"""
The unified log view.

Every service's output is normalised into one shape before anything renders it,
so the terminal view, the plain non-TTY view and the replay in `logs` all agree
about alignment, level and continuation. `Renderer` is that one implementation:
`start` feeds it from the child pipes, `logs` feeds it from the files those
pipes were written to, and the two cannot drift.
"""

import os
import re
import sys
import threading
from dataclasses import dataclass, replace
from pathlib import Path
from typing import IO

from devsuite.console import Style
from devsuite.layout import NAME_COLUMN
from devsuite.util import now_iso

# ─────────────────────────────────────────────────────────────────────────────
# Log levels
# ─────────────────────────────────────────────────────────────────────────────

LEVELS: tuple[str, ...] = ("silent", "error", "warn", "info", "debug", "trace")
LEVEL_RANK = {name: index for index, name in enumerate(LEVELS)}
DEFAULT_LEVEL = "info"

# Vite understands four of the six. debug and trace map onto its most verbose
# setting and turn on the knobs that do go further: SETUN_LOG_LEVEL for the
# application's own logging, and Vite's DEBUG namespaces for trace.
VITE_LEVEL = {
    "silent": "silent",
    "error": "error",
    "warn": "warn",
    "info": "info",
    "debug": "info",
    "trace": "info",
}


def level_at_least(level: str, floor: str) -> bool:
    """True when `level` is as verbose as `floor` or more so."""
    return LEVEL_RANK[level] >= LEVEL_RANK[floor]


# ─────────────────────────────────────────────────────────────────────────────
# Colour
#
# 256-colour foregrounds only, chosen mid-tone so they read on a white terminal
# and a black one alike; no backgrounds, no bright-white, no pure yellow.
# ─────────────────────────────────────────────────────────────────────────────

SERVICE_COLOUR = {
    "app": "38;5;33",  # blue
    "sandbox": "38;5;134",  # purple
    "cpa": "38;5;29",  # teal
    "caddy": "38;5;136",  # amber
    "suite": "38;5;244",  # grey — the supervisor's own voice
}

LEVEL_COLOUR = {
    "error": "38;5;160",
    "warn": "38;5;172",
    "info": "38;5;244",
    "debug": "38;5;66",
    "trace": "38;5;245",
}

ANSI_ESCAPE = re.compile(r"\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)")

# `bun run` reports a script killed by SIGTERM as an error, which during a
# shutdown the suite itself asked for is exactly what it is not. Recognised so
# a clean `stop` does not sign off with four red lines.
SHUTDOWN_NOISE = re.compile(r"signal SIGTERM|Polite quit request", re.IGNORECASE)

# Level tokens as the three services actually emit them: Vite's symbols, Bun's
# `error:` prefix, Go-style `level=warn`, and plain bracketed words.
LEVEL_PATTERNS: tuple[tuple[str, re.Pattern[str]], ...] = (
    # The multiplication sign in the first pattern is the character esbuild
    # actually prints; the ASCII letter would match nothing it emits.
    ("error", re.compile(r"(^|\s)(✘|✗|×)|(^|\W)(error|fatal|panic|failed)\b", re.IGNORECASE)),  # noqa: RUF001
    ("warn", re.compile(r"(^|\s)(⚠|!)|(^|\W)warn(ing)?\b", re.IGNORECASE)),
    ("debug", re.compile(r"(^|\W)(debug|verbose)\b", re.IGNORECASE)),
    ("trace", re.compile(r"(^|\W)trace\b", re.IGNORECASE)),
    ("info", re.compile(r"(^|\s)(✔|✓|➜)|(^|\W)info\b", re.IGNORECASE)),
)

# Only the first stretch of a line is inspected. A message body that merely
# mentions the word "error" further along is not an error line, and treating it
# as one would misclassify half the output of a test run.
LEVEL_SCAN_CHARS = 48


def detect_level(message: str) -> str:
    head = message[:LEVEL_SCAN_CHARS]
    for level, pattern in LEVEL_PATTERNS:
        if pattern.search(head):
            return level
    return "info"


@dataclass(frozen=True)
class Line:
    """One physical line of output, from one service, at one moment."""

    service: str
    text: str
    stamp: str
    level: str
    continuation: bool


# What counts as a continuation of the line above: leading whitespace (a stack
# frame, an indented column list), a closing delimiter (the `);` ending a
# logged CREATE TABLE), or nothing at all. Such a line keeps its service colour
# and column but drops the timestamp, so a multi-line burst reads as one block.
#
# A heuristic, and knowingly so — three tools with three output conventions
# share this view, and none of them announces where a message ends. It is built
# to fail in the harmless direction: a misread line still lands in exactly the
# same columns as every other, so alignment holds either way.
CONTINUATION_OPENERS = ")}];,"


def make_line(service: str, raw: str, stamp: str) -> Line:
    clean = ANSI_ESCAPE.sub("", raw).rstrip("\r\n").replace("\t", "    ")
    continuation = (not clean) or clean[0].isspace() or clean[0] in CONTINUATION_OPENERS
    return Line(
        service=service,
        text=clean,
        stamp=stamp,
        level=detect_level(clean.strip()),
        continuation=continuation,
    )


class Renderer:
    """Turns `Line`s into terminal output, coloured or plain."""

    def __init__(self, style: Style, floor: str) -> None:
        self.style: Style = style
        self.floor: str = floor
        # Whether the last primary line from each service was shown. A stack
        # trace whose first line was filtered out must go with it — otherwise
        # `--log-level error` leaves headless blocks of indented text behind.
        self.showing: dict[str, bool] = {}

    def visible(self, line: Line) -> bool:
        """
        The view's own floor.

        Services the suite can configure at the source are already quiet; this
        catches the ones it cannot reach — CPA's container, and anything a tool
        prints below the level it was asked for.
        """
        if self.floor == "silent":
            return False
        if line.continuation:
            return self.showing.get(line.service, True)
        shown = LEVEL_RANK[line.level] <= LEVEL_RANK[self.floor]
        self.showing[line.service] = shown
        return shown

    def format(self, line: Line) -> str:
        service = line.service.ljust(NAME_COLUMN)

        if not self.style.enabled:
            # Plain, greppable, one line in one shape: timestamp, level,
            # service, message. Continuations keep the columns and blank the
            # fields that would repeat.
            stamp = " " * len(line.stamp) if line.continuation else line.stamp
            level = "     " if line.continuation else line.level[:5].ljust(5)
            return f"{stamp} {level} {service} | {line.text}"

        colour = SERVICE_COLOUR.get(line.service, "38;5;244")
        if line.continuation:
            gutter = self.style.dim(" " * len(line.stamp))
            level = "     "
            bar = self.style.paint("┆", colour)
        else:
            gutter = self.style.dim(line.stamp)
            level = self.style.paint(line.level[:5].ljust(5), LEVEL_COLOUR[line.level])
            bar = self.style.paint("│", colour)

        name = self.style.paint(service, colour)
        text = line.text
        if line.level == "error" and not line.continuation:
            text = self.style.paint(text, LEVEL_COLOUR["error"])
        return f"{gutter} {level} {name} {bar} {text}"

    def emit(self, line: Line, stream: IO[str] = sys.stdout) -> None:
        if self.visible(line):
            print(self.format(line), file=stream, flush=True)


def short_stamp(iso: str) -> str:
    """`12:04:11.208` — the date is on the banner, not on every line."""
    return iso[11:23]


# ─────────────────────────────────────────────────────────────────────────────
# Per-service log files
#
# Raw child output with an ISO timestamp in front of every line. Nothing is
# filtered on the way in: the view has a floor, the file is the record.
# `grep` over one of these needs no knowledge of the suite.
# ─────────────────────────────────────────────────────────────────────────────


class LogFile:
    def __init__(self, path: Path) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        self._handle: IO[str] = path.open("a", encoding="utf-8", errors="replace")
        self._lock: threading.Lock = threading.Lock()

    def write(self, stamp: str, text: str) -> None:
        with self._lock:
            _ = self._handle.write(f"{stamp} {text}\n")
            self._handle.flush()

    def close(self) -> None:
        with self._lock:
            self._handle.close()


LOG_FILE_LINE = re.compile(r"^(?P<stamp>\d{4}-\d\d-\d\dT[\d:.]+Z) (?P<text>.*)$")


class Tail:
    """
    Follows one service's log file.

    Opened in binary and decoded here rather than in text mode, because this
    seeks. A text stream's `tell()` returns an opaque cookie that may not be
    arithmetic on a byte offset, so comparing it against a file size or backing
    up over a partial line is only correct on bytes.
    """

    def __init__(self, service: str, path: Path) -> None:
        self.service: str = service
        self.path: Path = path
        self.handle: IO[bytes] | None = None
        self.inode: int | None = None
        self.last_stamp: str = ""

    def _open(self) -> None:
        try:
            handle = self.path.open("rb")
        except FileNotFoundError, NotADirectoryError:
            return
        self.handle = handle
        self.inode = os.fstat(handle.fileno()).st_ino

    def _line(self, raw: bytes) -> tuple[str, Line]:
        """One file line, paired with the key the cross-service merge sorts on."""
        text = raw.decode("utf-8", "replace").rstrip("\n")
        match = LOG_FILE_LINE.match(text)
        if match:
            self.last_stamp = match.group("stamp")
            return (
                self.last_stamp,
                make_line(self.service, match.group("text"), short_stamp(self.last_stamp)),
            )

        # No stamp, where the writer puts one on every line it writes. Rather
        # than drop it, read it as part of the line above and give it that
        # line's sort key, so a block stays whole and nothing that reached the
        # file disappears on the way back out of it.
        blank = " " * len(short_stamp(now_iso()))
        return (
            self.last_stamp,
            replace(make_line(self.service, text, blank), continuation=True),
        )

    def replay(self, count: int) -> list[tuple[str, Line]]:
        """The last `count` lines, leaving the handle at the end to follow from."""
        self._open()
        handle = self.handle
        if handle is None:
            return []
        lines = handle.read().splitlines(keepends=True)
        return [self._line(raw) for raw in (lines[-count:] if count else [])]

    def poll(self) -> list[tuple[str, Line]]:
        # A restart unlinks the file and makes a new one, so the inode is what
        # says whether this handle still points at the log anyone is writing.
        try:
            current = self.path.stat()
        except FileNotFoundError, NotADirectoryError:
            return []
        if self.handle is None or self.inode != current.st_ino:
            if self.handle:
                self.handle.close()
            self._open()
        handle = self.handle
        if handle is None:
            return []
        if current.st_size < handle.tell():
            _ = handle.seek(0)

        collected: list[tuple[str, Line]] = []
        while True:
            position = handle.tell()
            raw = handle.readline()
            if not raw:
                break
            if not raw.endswith(b"\n"):
                # Half a line: the writer has not finished it. Rewind and take
                # it whole on the next poll rather than render it twice.
                _ = handle.seek(position)
                break
            collected.append(self._line(raw))
        return collected
