"""
`status`, `logs` and `list` — the commands that only look.

`logs` renders from the files the child pipes were written to, through the same
`Renderer` a foreground `start` feeds from the pipes themselves, so the two are
one view and not two implementations that drift.
"""

import time

from devsuite.console import OUT, fail, note, relative
from devsuite.health import http_answers, tcp_open
from devsuite.instance import Instance, RunState, ServiceState, instance_is_running, list_instances
from devsuite.layout import ATTACH_TIMEOUT_SECONDS, DEFAULT_PORTS, NAME_COLUMN
from devsuite.logview import SERVICE_COLOUR, Line, Renderer, Tail
from devsuite.options import Options, chosen_level, resolve_target
from devsuite.util import directory_size

HEALTH_MARK = {"up": ("●", "38;5;29"), "down": ("○", "38;5;160"), "unknown": ("◌", "38;5;244")}


def log_names(instance: Instance) -> set[str]:
    """The services this instance has a log for. `supervisor.out` is not one."""
    if not instance.logs.is_dir():
        return set()
    return {path.stem for path in instance.logs.glob("*.log") if path.stem != "supervisor"}


def await_logs(instance: Instance, timeout: float = ATTACH_TIMEOUT_SECONDS) -> bool:
    """
    Wait until there is a log to follow.

    The winner takes the lock before it materialises anything, so a second
    `start` can reach the log view before the first file exists. Waiting here is
    what keeps that gap from reading as an instance that was never started.

    Presence is all that is waited for. Completeness cannot be decided from
    here — the previous run's files are indistinguishable from this one's, so a
    set that looks whole may be last run's — and it does not need to be: the
    view picks up each log as it appears.

    False when the winner is gone before it wrote anything; there is nothing to
    attach to then.
    """
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if log_names(instance):
            return True
        if not instance_is_running(instance):
            return False
        time.sleep(0.1)
    return bool(log_names(instance))


def command_status(options: Options) -> int:
    instance = resolve_target(options)
    if instance is None:
        print(OUT.dim("no ephemeral instance"))
        return 0

    if not instance.root.exists():
        print(f"{OUT.bold(instance.name)}  {OUT.dim('never started')}")
        print(OUT.dim(f"  Nothing under {relative(instance.root)}. Start it with:"))
        print(OUT.dim("    ./scripts/devsuite start"))
        return 0

    running = instance_is_running(instance)
    config = instance.read_config()
    ports = {**DEFAULT_PORTS, **(config.get("ports") or {})}

    if not running:
        stale = instance.read_state() is not None
        state_note = OUT.dim(" (stale runtime state — next command will clear it)") if stale else ""
        print(f"{OUT.bold(instance.name)}  {OUT.paint('stopped', '38;5;172')}{state_note}")
        print(OUT.dim(f"  mode      {config.get('mode', instance.mode)}"))
        print(OUT.dim(f"  data      {relative(instance.data)} ({directory_size(instance.data)})"))
        print(OUT.dim(f"  ports     app {ports.get('app')}, sandbox {ports.get('sandbox')}"))
        print(OUT.dim("  resume    ./scripts/devsuite resume " + instance.name))
        return 0

    state: RunState = instance.read_state() or {}
    headline = (
        f"{OUT.bold(instance.name)}  {OUT.paint('running', '38;5;29')}  "
        f"{OUT.dim('mode')} {state.get('mode', instance.mode)}  "
        f"{OUT.dim('level')} {state.get('log_level', '?')}  "
        f"{OUT.dim('since')} {state.get('started_at', '?')}"
    )
    print(headline)

    entries: dict[str, ServiceState] = state.get("services") or {}
    for name in ("app", "sandbox", "caddy", "cpa"):
        if name not in entries:
            continue
        entry = entries[name]
        port = entry.get("port", ports.get(name))
        health = "up" if _probe_port(name, port) else "down"
        mark, colour = HEALTH_MARK[health]
        pid = entry.get("pid")
        where = "container" if entry.get("containerised") else f"pid {pid}"
        row = (
            f"  {OUT.paint(mark, colour)} {OUT.paint(name.ljust(NAME_COLUMN), SERVICE_COLOUR[name])}"
            f" :{str(port).ljust(5)} {OUT.dim(where.ljust(12))} {OUT.dim(health)}"
        )
        print(row)

    print(OUT.dim(f"  data {relative(instance.data)} ({directory_size(instance.data)})"))
    return 0


def _probe_port(name: str, port: int | None) -> bool:
    if not port:
        return False
    if name in ("app", "sandbox"):
        return http_answers(port)
    return tcp_open(port)


def command_logs(
    options: Options,
    instance: Instance | None = None,
    detached_notice: bool = True,
) -> int:
    instance = instance or resolve_target(options)
    if instance is None:
        note("no ephemeral instance is running")
        return 0

    if not instance.logs.is_dir():
        fail(
            f"instance '{instance.name}' has no logs",
            hint="It has never been started. `./scripts/devsuite start`",
        )

    wanted = options.service
    available = sorted(log_names(instance))
    if wanted and wanted not in available:
        fail(
            f"no log for service '{wanted}'",
            hint="Available: " + ", ".join(available),
        )

    names = [wanted] if wanted else available
    tails = {name: Tail(name, instance.logs / f"{name}.log") for name in names}
    renderer = Renderer(OUT, chosen_level(options))

    running = instance_is_running(instance)
    if detached_notice:
        note(
            f"following {', '.join(names)} — Ctrl-C detaches, the stack keeps running"
            if running
            else f"instance '{instance.name}' is not running — showing what it left behind"
        )

    replay: list[tuple[str, Line]] = []
    for tail in tails.values():
        replay.extend(tail.replay(options.tail))
    for _, line in sorted(replay, key=lambda item: item[0]):
        renderer.emit(line)

    if detached_notice and not running:
        return 0

    try:
        while True:
            # The set of logs is not fixed for the run. A start that enables a
            # service the last one did not opens its file after this view has
            # already listed what exists — and the files that were there when
            # it looked may be the previous run's. Picking new ones up as they
            # appear is what keeps the view showing the whole stack.
            if not wanted:
                for name in sorted(log_names(instance) - tails.keys()):
                    tails[name] = Tail(name, instance.logs / f"{name}.log")

            batch: list[tuple[str, Line]] = []
            for tail in tails.values():
                batch.extend(tail.poll())
            for _, line in sorted(batch, key=lambda item: item[0]):
                renderer.emit(line)
            if not batch and not instance_is_running(instance):
                note("the stack has stopped — detaching")
                return 0
            time.sleep(0.15)
    except KeyboardInterrupt:
        print()
        note("detached — the stack is still running")
        return 0


def command_list(_options: Options) -> int:
    found = list_instances()
    if not found:
        print(OUT.dim("no instances — `./scripts/devsuite start` creates one"))
        return 0

    header = (
        f"  {OUT.dim('INSTANCE'.ljust(20))}{OUT.dim('MODE'.ljust(12))}"
        f"{OUT.dim('STATE'.ljust(10))}{OUT.dim('PORTS'.ljust(14))}{OUT.dim('DATA')}"
    )
    print(header)

    for instance in found:
        config = instance.read_config()
        ports = config.get("ports", {})
        running = instance_is_running(instance)
        label = "running" if running else "stopped"
        state = OUT.paint(label, "38;5;29" if running else "38;5;172")
        # Padded by hand: the colour codes make ljust() count invisible bytes.
        padding = " " * (10 - len(label))
        endpoints = f"{ports.get('app', '-')}/{ports.get('sandbox', '-')}"
        row = (
            f"  {instance.name.ljust(20)}"
            f"{config.get('mode', instance.mode).ljust(12)}"
            f"{state}{padding}"
            f"{endpoints.ljust(14)}"
            f"{OUT.dim(directory_size(instance.data))}"
        )
        print(row)
    return 0
