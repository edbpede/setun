"""
The suite's own voice: colour, notes, and the one way it gives up.

Separate from the log view because these are the suite speaking as itself —
before any service exists, and after they have all gone.
"""

import os
import sys
from pathlib import Path
from typing import IO, NoReturn

from devsuite.layout import REPO


def colour_wanted(stream: IO[str]) -> bool:
    return stream.isatty() and not os.environ.get("NO_COLOR") and os.environ.get("TERM") != "dumb"


class Style:
    """Colour, or the absence of it, decided once at start-up."""

    def __init__(self, stream: IO[str]) -> None:
        self.enabled: bool = colour_wanted(stream)

    def follow(self, stream: IO[str]) -> None:
        """
        Re-decide for a stream that has replaced the one this was built on.

        The detached supervisor redirects its own stdout to a file after the
        fork. Mutating the one `Style` every caller already holds is what keeps
        `OUT` a constant while still answering for the stream it now writes to.
        """
        self.enabled = colour_wanted(stream)

    def paint(self, text: str, code: str) -> str:
        return f"\x1b[{code}m{text}\x1b[0m" if self.enabled else text

    def dim(self, text: str) -> str:
        return self.paint(text, "2")

    def bold(self, text: str) -> str:
        return self.paint(text, "1")


OUT = Style(sys.stdout)
ERR = Style(sys.stderr)


def note(message: str) -> None:
    print(f"{ERR.dim('suite')} {message}", file=sys.stderr, flush=True)


def fail(message: str, *, hint: str | None = None, code: int = 1) -> NoReturn:
    """Stop with an actionable message rather than a traceback."""
    print(f"{ERR.paint('error', '38;5;160')} {message}", file=sys.stderr)
    if hint:
        for line in hint.splitlines():
            # A blank line in a hint stays blank rather than becoming indent.
            print(f"      {ERR.dim(line)}" if line else "", file=sys.stderr)
    sys.exit(code)


def relative(path: Path) -> str:
    try:
        return str(path.relative_to(REPO))
    except ValueError:
        return str(path)


def confirm(question: str, forced: bool) -> bool:
    if forced:
        return True
    if not sys.stdin.isatty():
        fail(
            f"{question} needs confirmation", hint="Re-run with --force in a non-interactive shell."
        )
    answer = input(f"{question} [y/N] ").strip().lower()
    return answer in ("y", "yes")
