"""Small shared helpers with no home of their own."""

import fcntl
import json
import os
from collections.abc import Callable, Generator, Mapping
from contextlib import contextmanager, suppress
from datetime import UTC, datetime
from pathlib import Path


def now_iso() -> str:
    return datetime.now(tz=UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def write_json(path: Path, payload: Mapping[str, object]) -> None:
    """Write through a temporary file so a reader never sees half a document."""
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    _ = temporary.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    _ = temporary.replace(path)


def process_alive(pid: int | None) -> bool:
    if not pid:
        return False
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def signal_group(group: int, number: int) -> None:
    try:
        os.killpg(group, number)
    except ProcessLookupError:
        pass
    except PermissionError:
        pass


@contextmanager
def exclusive_lock(path: Path, *, on_wait: Callable[[], None] | None = None) -> Generator[None]:
    """
    Hold an exclusive advisory lock on `path` for the duration of the block.

    Blocking, unlike `InstanceLock`: the caller wants its turn, not a verdict on
    whether somebody else has one. `on_wait` is called once, and only where the
    lock is actually contended, so an uncontended run says nothing at all — the
    caller decides where that goes, because the supervisor has a log view and
    everything else has stderr.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a+") as handle:
        try:
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            if on_wait:
                on_wait()
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(handle.fileno(), fcntl.LOCK_UN)


def directory_size(path: Path) -> str:
    if not path.exists():
        return "0 B"
    total = 0
    for item in path.rglob("*"):
        if item.is_file():
            with suppress(OSError):
                total += item.stat().st_size
    for unit in ("B", "KiB", "MiB", "GiB"):
        if total < 1024 or unit == "GiB":
            return f"{total:.0f} {unit}" if unit == "B" else f"{total:.1f} {unit}"
        total /= 1024
    return f"{total:.1f} GiB"
