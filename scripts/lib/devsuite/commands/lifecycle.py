"""
`start`, `stop`, `kill` and `restart` — the commands that move the stack.
"""

import os
import shutil
import signal
import subprocess
import sys
import time
import traceback
from contextlib import suppress
from pathlib import Path

from devsuite.banner import announce_first_run, banner
from devsuite.commands.inspection import await_logs, command_logs
from devsuite.compose import (
    check_caddy_prerequisites,
    check_cpa_prerequisites,
    compose_argv,
    compose_command,
    warn_on_gateway_key_mismatch,
)
from devsuite.console import OUT, confirm, fail, note, relative
from devsuite.environment import child_environment, resolve_secrets, supplied_seed_keys
from devsuite.health import check_ports, require_binary
from devsuite.instance import (
    Instance,
    InstanceLock,
    RunState,
    instance_is_running,
    reap_stale,
)
from devsuite.layout import (
    BOOTSTRAP_TOKEN_WAIT_SECONDS,
    DEFAULT_PORTS,
    REPO,
    STOP_GRACE_SECONDS,
)
from devsuite.options import (
    Options,
    caddy_wanted,
    chosen_level,
    first_run_wanted,
    resolve_ports,
    resolve_target,
)
from devsuite.supervisor import Supervisor
from devsuite.util import now_iso, process_alive, signal_group


def attach_to_running(options: Options, instance: Instance) -> int:
    """
    What `start` does when the stack is already up: follow it, never spawn a
    second one. Both places that discover it is running end here, so the
    outcome does not depend on which of them noticed.
    """
    note(f"instance '{instance.name}' is already running — attaching to its log view")
    if not await_logs(instance):
        fail(
            f"instance '{instance.name}' holds the lock but opened no logs",
            hint=(
                f"{relative(instance.logs / 'supervisor.out')} has what its supervisor did,\n"
                "if it got far enough to write one. `./scripts/devsuite status` says what is up."
            ),
        )

    # The same header a start prints. An attach is the run where the operator is
    # least likely to still have the sign-in details on screen — the stack was
    # started in another terminal, possibly days ago — so it is the run that
    # needs them most. The ports come from the running instance's own config
    # rather than from this command's flags, which it is not in a position to
    # apply.
    config = instance.read_config()
    # Merged rather than taken whole: an instance.json written before a port was
    # introduced has no entry for it, and every caller reads the map by key.
    ports = {**DEFAULT_PORTS, **(config.get("ports") or {})}
    state = instance.read_state() or {}
    running_caddy = bool(state.get("caddy", False))
    banner(
        instance,
        ports,
        state.get("log_level", chosen_level(options)),
        "cpa" in (state.get("services") or {}),
        bool(state.get("production", False)),
        "detaches; the stack keeps running",
        caddy=running_caddy,
    )
    if config.get("first_run"):
        # Already running, so the token file is either there or was never
        # written; nothing to wait for.
        announce_first_run(instance, ports, wait=0.0, caddy=running_caddy)

    return command_logs(options, instance=instance)


def command_start(options: Options) -> int:
    instance = resolve_target(options, creating=True)
    assert instance is not None

    if instance_is_running(instance):
        # Idempotent by construction: the lock is held, so nothing is spawned.
        return attach_to_running(options, instance)

    reap_stale(instance)

    _ = require_binary("bun", hint="The stack runs on Bun 1.4 or newer — https://bun.com")
    caddy = caddy_wanted(options)
    if options.with_cpa:
        check_cpa_prerequisites()
    if caddy:
        check_caddy_prerequisites()

    # Before anything is created on disk: a start that cannot bind must leave
    # no instance directory behind for the next command to trip over.
    config = instance.read_config()
    # Before the lock, because refusing is cheaper than a stack that comes up
    # and then has to be told it cannot do what it was started for.
    _ = first_run_wanted(options, instance, config)
    ports = resolve_ports(options, config)
    level = chosen_level(options)

    # Caddy serves the sandbox itself, so with it in front there is no second
    # Vite server and nothing wants the sandbox port.
    services = ["app"] + (["caddy"] if caddy else ["sandbox"])
    services += ["cpa"] if options.with_cpa else []
    check_ports(ports, services)

    # Nothing is written until the lock is held. Two concurrent starts on one
    # fresh instance would otherwise both mint secrets and both write
    # instance.json, leaving the persisted values different from the ones the
    # running stack was handed — and a later `resume` would then change the
    # student-code pepper and invalidate every access code already issued.
    lock = InstanceLock(instance.lock_path)
    if not lock.acquire():
        # The probe at the top of this function and this line are not one step:
        # a concurrent `start` that passed the probe before the winner took the
        # lock lands here, and "already running" has to mean the same thing at
        # both ends of that gap.
        return attach_to_running(options, instance)

    instance.materialise()

    # Re-read under the lock: a start that finished between the read above and
    # this line has already stored this instance's secrets, and minting a
    # second set would persist credentials nothing is running with.
    config = instance.read_config()
    first_run = first_run_wanted(options, instance, config)
    resolved, minted = resolve_secrets(config, first_run=first_run)
    config.update(
        {
            "name": instance.name,
            "mode": instance.mode,
            "created_at": config.get("created_at", now_iso()),
            "ports": ports,
        }
    )
    if first_run:
        config["first_run"] = True
    instance.write_config(config)

    if minted:
        note(
            "generated development values for "
            + ", ".join(sorted(minted))
            + f" — held in {relative(instance.config_path)}, never written to .env"
        )

    token_path: Path | None = None
    if first_run:
        overridden = supplied_seed_keys()
        if overridden:
            note(
                "--first-run overrides "
                + " and ".join(sorted(overridden))
                + (
                    " for this instance — a seeded operator account would be adopted as a"
                    " finished installation and the wizard would never run"
                )
            )
        # A token file the previous run left behind — the application unlinks it
        # at exit and on completion, but not after a SIGKILL — would be reported
        # as this run's, and it is worthless: the token lives in the process.
        instance.bootstrap_token_path.unlink(missing_ok=True)
        token_path = instance.bootstrap_token_path

    if options.with_cpa:
        warn_on_gateway_key_mismatch(resolved["SETUN_CPA_LISTENER_KEY"])

    environment = child_environment(instance, ports, level, resolved, token_path, caddy=caddy)

    if options.detach:
        return _start_detached(
            instance,
            ports,
            level,
            options.with_cpa,
            options.production,
            environment,
            lock,
            first_run,
            caddy,
        )

    supervisor = Supervisor(
        instance, ports, level, options.with_cpa, options.production, environment, lock, caddy
    )

    banner(
        instance,
        ports,
        level,
        options.with_cpa,
        options.production,
        "stops the stack" + (" and destroys it" if instance.mode == "ephemeral" else ""),
        caddy=caddy,
    )

    try:
        supervisor.start_stack()
    except Exception as error:  # noqa: BLE001 — any failure here must still clean up
        supervisor.emit("suite", f"error: {error}")
        supervisor.shutdown(force=True)
        return 1

    if not supervisor.await_health():
        if supervisor.stopping.is_set():
            supervisor.shutdown()
            return 0
        supervisor.emit("suite", "error: the stack did not become healthy — shutting down")
        supervisor.shutdown()
        return 1

    if first_run:
        # After health rather than on the banner: the application mints on its
        # first request, and the health probe is that request.
        announce_first_run(instance, ports, BOOTSTRAP_TOKEN_WAIT_SECONDS, caddy=caddy)

    return supervisor.run()


def _notify(descriptor: int, healthy: bool) -> None:
    """Tell the parent whether the stack came up. Safe to call twice."""
    try:
        _ = os.write(descriptor, b"1" if healthy else b"0")
        os.close(descriptor)
    except OSError:
        pass


def _start_detached(
    instance: Instance,
    ports: dict[str, int],
    level: str,
    with_cpa: bool,
    production: bool,
    environment: dict[str, str],
    lock: InstanceLock,
    first_run: bool = False,
    caddy: bool = False,
) -> int:
    """
    Fork a supervisor into its own session and return once it reports healthy.

    The pipe is the handshake: the parent blocks on one byte rather than
    polling, so `start --detach` returns having actually established that the
    stack is up — or fails with the log to read.

    The lock crosses the fork: parent and child share one open file
    description, so it stays held for the supervisor once the parent exits.
    The parent must therefore never release it — unlocking a shared
    description would unlock it for the child too.
    """
    instance.logs.mkdir(parents=True, exist_ok=True)
    read_end, write_end = os.pipe()
    pid = os.fork()

    if pid != 0:
        os.close(write_end)
        with os.fdopen(read_end, "rb") as pipe:
            verdict = pipe.read(1)
        if verdict != b"1":
            fail(
                "the detached stack did not come up",
                hint=(
                    f"{relative(instance.logs / 'suite.log')} has what the services printed;\n"
                    f"{relative(instance.logs / 'supervisor.out')} has what the supervisor did."
                ),
            )
        banner(
            instance,
            ports,
            level,
            with_cpa,
            production,
            "n/a — detached; `devsuite stop` ends it",
            caddy=caddy,
        )
        if first_run:
            # The child reported healthy, so its first request has been served
            # and the token is already on disk. This is the only place a
            # detached start can show it at all: the log it was printed to is a
            # file nobody is watching.
            announce_first_run(instance, ports, BOOTSTRAP_TOKEN_WAIT_SECONDS, caddy=caddy)
        note(f"supervisor detached (pid {pid}) — attach with `./scripts/devsuite logs`")
        return 0

    # Child. Its own session, no controlling terminal, and no further claim on
    # the parent's stdout — everything it says goes to a file from here.
    os.close(read_end)
    os.setsid()
    lock.stamp()
    handle = (instance.logs / "supervisor.out").open("a", buffering=1, encoding="utf-8")
    _ = os.dup2(handle.fileno(), sys.stdout.fileno())
    _ = os.dup2(handle.fileno(), sys.stderr.fileno())
    _ = os.dup2(os.open(os.devnull, os.O_RDONLY), sys.stdin.fileno())
    OUT.follow(sys.stdout)

    status = 1
    try:
        supervisor = Supervisor(
            instance, ports, level, with_cpa, production, environment, lock, caddy
        )
        try:
            supervisor.start_stack()
            healthy = supervisor.await_health()
        except Exception as error:  # noqa: BLE001 — the parent needs a verdict
            supervisor.emit("suite", f"error: {error}")
            healthy = False
        _notify(write_end, healthy)
        if healthy:
            status = supervisor.run()
        else:
            supervisor.shutdown(force=True)
    except BaseException:  # noqa: BLE001 — nothing above may leave the parent blocked
        traceback.print_exc()
        _notify(write_end, False)

    os._exit(status)


def _supervisor_pid(instance: Instance) -> int | None:
    state = instance.read_state()
    recorded = state.get("supervisor_pid") if state else None
    if recorded:
        return int(recorded)
    try:
        return int(instance.lock_path.read_text(encoding="utf-8").strip())
    except OSError, ValueError:
        return None


def _await_release(instance: Instance, timeout: float) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if not instance_is_running(instance):
            return True
        time.sleep(0.2)
    return False


def command_stop(options: Options) -> int:
    instance = resolve_target(options)
    if instance is None:
        note("no ephemeral instance is running")
        return 0

    if not instance_is_running(instance):
        reap_stale(instance)
        note(f"instance '{instance.name}' is not running")
        return 0

    pid = _supervisor_pid(instance)
    if not pid:
        fail(
            f"instance '{instance.name}' is running but its supervisor cannot be identified",
            hint="Use `./scripts/devsuite kill --force` to clear it.",
        )

    note(f"stopping instance '{instance.name}' (supervisor {pid})")
    try:
        os.kill(pid, signal.SIGTERM)
    except ProcessLookupError:
        reap_stale(instance)
        return 0

    if not _await_release(instance, STOP_GRACE_SECONDS + 15):
        fail(
            "the supervisor did not exit in time",
            hint="Force it with `./scripts/devsuite kill --force`.",
        )

    # The supervisor removes an ephemeral instance itself. This is the second
    # lock on a door that must not be left open: "zero left behind" is the
    # whole of what ephemeral means, so it is checked rather than assumed.
    if instance.mode == "ephemeral" and instance.root.exists():
        shutil.rmtree(instance.root, ignore_errors=True)

    note("stopped" + ("" if instance.mode == "ephemeral" else " — data preserved"))
    return 0


def command_kill(options: Options) -> int:
    instance = resolve_target(options)
    if instance is None:
        note("no ephemeral instance is running")
        return 0

    if not instance_is_running(instance) and instance.read_state() is None:
        note(f"instance '{instance.name}' is not running")
        return 0

    if not confirm(f"Force-terminate instance '{instance.name}' without cleanup?", options.force):
        note("cancelled")
        return 1

    state: RunState = instance.read_state() or {}

    # Children first: they are in their own sessions and would outlive a killed
    # supervisor otherwise. This is the whole reason `kill` is not just SIGKILL
    # on one pid.
    for name, entry in (state.get("services") or {}).items():
        pid = entry.get("pid")
        if entry.get("containerised") or pid is None or not process_alive(pid):
            continue
        note(f"killing {name} (pid {pid})")
        with suppress(ProcessLookupError):
            signal_group(os.getpgid(pid), signal.SIGKILL)

    supervisor = _supervisor_pid(instance)
    if supervisor is not None and process_alive(supervisor):
        note(f"killing supervisor (pid {supervisor})")
        with suppress(ProcessLookupError):
            os.kill(supervisor, signal.SIGKILL)

    if (state.get("with_cpa") or state.get("caddy")) and compose_command():
        project = state.get("compose_project", instance.compose_project)
        _ = subprocess.run(
            compose_argv(project, "kill"), cwd=REPO, capture_output=True, text=True, check=False
        )
        # --volumes only where the instance is ephemeral, matching the message
        # this command prints: CPA's auth volume is that instance's data as
        # much as its database is, and `kill` leaves a persistent one's alone.
        teardown = ["down", "--timeout", "0"]
        if instance.mode == "ephemeral":
            teardown.append("--volumes")
        _ = subprocess.run(
            compose_argv(project, *teardown), cwd=REPO, capture_output=True, text=True, check=False
        )

    _ = _await_release(instance, 5)
    instance.state_path.unlink(missing_ok=True)

    if instance.mode == "ephemeral" and instance.root.exists():
        shutil.rmtree(instance.root, ignore_errors=True)
        note(f"destroyed ephemeral instance '{instance.name}'")
    else:
        note(f"killed instance '{instance.name}' — data left in place")
    return 0


def command_restart(options: Options) -> int:
    code = command_stop(options)
    if code != 0:
        return code
    return command_start(options)
