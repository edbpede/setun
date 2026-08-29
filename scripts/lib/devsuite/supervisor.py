"""
The supervisor.

One foreground process owns every child. Children are started in their own
session, so shutdown signals a process *group* and a Vite server cannot leave
an esbuild or a worker behind.
"""

import os
import shutil
import signal
import subprocess
import threading
import time
from collections.abc import Iterable
from dataclasses import replace
from queue import Empty, Queue
from types import FrameType
from typing import IO

from devsuite.compose import compose_argv
from devsuite.console import OUT, fail
from devsuite.environment import EDUCATOR_SEED_KEYS
from devsuite.health import probe
from devsuite.instance import Instance, InstanceLock, RunState
from devsuite.layout import (
    HEALTH_TIMEOUT_SECONDS,
    PROBE_INTERVAL_SECONDS,
    REPO,
    STOP_GRACE_SECONDS,
)
from devsuite.logview import (
    ANSI_ESCAPE,
    SHUTDOWN_NOISE,
    Line,
    LogFile,
    Renderer,
    make_line,
    short_stamp,
)
from devsuite.services import Service, app_service, caddy_service, cpa_service, sandbox_service
from devsuite.util import now_iso, signal_group, write_json


class Supervisor:
    def __init__(
        self,
        instance: Instance,
        ports: dict[str, int],
        level: str,
        with_cpa: bool,
        production: bool,
        environment: dict[str, str],
        lock: InstanceLock,
        caddy: bool = False,
    ) -> None:
        self.instance: Instance = instance
        self.ports: dict[str, int] = ports
        self.level: str = level
        self.with_cpa: bool = with_cpa
        self.production: bool = production
        self.caddy: bool = caddy
        self.environment: dict[str, str] = environment
        self.renderer: Renderer = Renderer(OUT, level)
        self.queue: Queue[Line] = Queue()
        self.services: list[Service] = []
        self.files: dict[str, LogFile] = {}
        self.stopping: threading.Event = threading.Event()
        self.failure: str | None = None
        # Acquired by `command_start` before any instance state was written, and
        # held here until shutdown releases it.
        self.lock: InstanceLock = lock

    # ── output ───────────────────────────────────────────────────────────────

    def emit(self, service: str, text: str) -> None:
        stamp = now_iso()
        for physical in text.splitlines() or [""]:
            self.files[service].write(stamp, physical)
            self.queue.put(make_line(service, physical, short_stamp(stamp)))

    def drain(self, block: float = 0.0) -> None:
        deadline = time.monotonic() + block
        while True:
            try:
                line = self.queue.get(timeout=0.05 if block else 0)
            except Empty:
                if time.monotonic() >= deadline:
                    return
                continue
            self.renderer.emit(line)

    # ── lifecycle ────────────────────────────────────────────────────────────

    def open_logs(self, names: Iterable[str]) -> None:
        # A fresh file per session: the file that survives `stop` is the record
        # of the run that just ended, not a merge of every run so far.
        for name in names:
            path = self.instance.logs / f"{name}.log"
            path.unlink(missing_ok=True)
            self.files[name] = LogFile(path)

    def spawn(self, service: Service) -> None:
        try:
            service.process = subprocess.Popen(
                service.argv,
                cwd=REPO,
                env=self.environment,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                start_new_session=True,
                bufsize=1,
                text=True,
                errors="replace",
            )
        except FileNotFoundError:
            fail(
                f"cannot start {service.name}: `{service.argv[0]}` is not on PATH",
                hint="The stack runs on Bun 1.4 or newer — https://bun.com",
            )

        service.reader = threading.Thread(
            target=self._pump, args=(service,), name=f"read-{service.name}", daemon=True
        )
        service.reader.start()
        self.services.append(service)

    def _pump(self, service: Service) -> None:
        assert service.process is not None and service.process.stdout is not None
        # Popen.stdout is typed IO[Any] whichever mode the child was opened in;
        # `spawn` passes text=True, so this one yields str.
        stream: IO[str] = service.process.stdout
        for raw in stream:
            stamp = now_iso()
            self.files[service.name].write(stamp, ANSI_ESCAPE.sub("", raw.rstrip("\n")))
            line = make_line(service.name, raw, short_stamp(stamp))
            if (
                self.stopping.is_set()
                and line.level == "error"
                and SHUTDOWN_NOISE.search(line.text)
            ):
                line = replace(line, level="debug")
            self.queue.put(line)
        stream.close()

    def start_stack(self) -> None:
        self.instance.materialise()

        names = ["suite", "app"]
        names += ["caddy"] if self.caddy else ["sandbox"]
        names += ["cpa"] if self.with_cpa else []
        self.open_logs(names)

        self.emit(
            "suite",
            f"instance '{self.instance.name}' ({self.instance.mode}), log level {self.level}",
        )

        if self.with_cpa:
            self.compose_up("cpa")
            self.spawn(cpa_service(self.instance.compose_project, self.ports["cpa"]))

        self.build_artifacts()

        self.spawn(app_service(self.level, self.ports["app"], built=self.production))

        if self.caddy:
            # After the build, not before: Caddy's `file_server` is pointed at
            # `build-sandbox/`, and starting it against a half-written directory
            # would serve a runner from the previous build.
            self.compose_up("caddy")
            self.spawn(caddy_service(self.instance.compose_project, self.ports["caddy"]))
        else:
            self.spawn(sandbox_service(self.level, self.ports["sandbox"]))

        self.write_state()

    def compose_up(self, name: str) -> None:
        """Bring one containerised service up, or fail the whole start."""
        self.emit("suite", f"starting {name} container")
        result = subprocess.run(
            compose_argv(self.instance.compose_project, "up", "--detach", name),
            cwd=REPO,
            env={**self.environment, "SETUN_CPA_PORT": str(self.ports["cpa"])},
            capture_output=True,
            text=True,
            check=False,
        )
        if result.returncode != 0:
            detail = (result.stderr or result.stdout).strip()
            self.emit("suite", f"error: docker compose up {name} failed — {detail}")
            raise RuntimeError(f"{name} failed to start")

    def build_artifacts(self) -> None:
        """
        Build whatever this run serves from a build, before anything is spawned.

        The sandbox is always built (see `sandbox_service`); the application is
        built only for `--production`. Both are the repository's own package
        scripts, so there is still one place that knows how to build each.

        Synchronous and fail-loud on purpose: a stale `build-sandbox/` serves an
        old runner that looks fine and behaves like the last build, which is the
        most confusing failure this suite could produce.
        """
        steps = [("sandbox", "build:sandbox")]
        if self.production:
            steps.insert(0, ("app", "build"))

        for name, script in steps:
            self.emit("suite", f"building {name} (bun run {script})")
            result = subprocess.run(
                ["bun", "run", script],
                cwd=REPO,
                env=self.environment,
                capture_output=True,
                text=True,
                check=False,
            )
            if result.returncode != 0:
                detail = (result.stderr or result.stdout).strip()
                tail = "\n".join(detail.splitlines()[-20:])
                self.emit("suite", f"error: `bun run {script}` failed\n{tail}")
                raise RuntimeError(f"{name} build failed")

    def write_state(self) -> None:
        state: RunState = {
            "instance": self.instance.name,
            "mode": self.instance.mode,
            "supervisor_pid": os.getpid(),
            "started_at": now_iso(),
            "log_level": self.level,
            "with_cpa": self.with_cpa,
            "production": self.production,
            "caddy": self.caddy,
            "compose_project": self.instance.compose_project,
            "services": {
                service.name: {
                    "pid": service.process.pid if service.process else None,
                    "port": service.port,
                    "containerised": service.containerised,
                }
                for service in self.services
            },
        }

        # Recorded from the dictionary the children were spawned with, which is
        # the only account the application actually seeded. The password itself
        # is not: the development value is already in `instance.json` and the
        # banner reads it from there, and an operator's own is never echoed.
        username_key, password_key = EDUCATOR_SEED_KEYS
        username = self.environment.get(username_key)
        if username:
            minted = self.instance.read_config().get("secrets", {}).get(password_key)
            state["educator_username"] = username
            state["educator_password_minted"] = (
                bool(minted) and self.environment.get(password_key) == minted
            )

        write_json(self.instance.state_path, state)

    def await_health(self, timeout: float = HEALTH_TIMEOUT_SECONDS) -> bool:
        """Block until every service answers, rendering its start-up as it goes."""
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline and not self.stopping.is_set():
            self.drain(block=0.25)
            if self.dead_service():
                return False
            for service in self.services:
                state = probe(service, deep=True)
                if state != service.health:
                    service.health = state
                    if state == "up":
                        self.emit("suite", f"{service.name} ready on :{service.port}")
            if all(service.health == "up" for service in self.services):
                self.write_state()
                return True
        return False

    def dead_service(self) -> Service | None:
        for service in self.services:
            if service.process and service.process.poll() is not None:
                return service
        return None

    # ── the foreground loop ──────────────────────────────────────────────────

    def run(self) -> int:
        for received in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
            _ = signal.signal(received, self._on_signal)

        next_probe = time.monotonic() + PROBE_INTERVAL_SECONDS
        while not self.stopping.is_set():
            self.drain(block=0.2)

            # A dev server that dies leaves the rest of the stack half-up, which
            # is worse than no stack at all: take the whole thing down and exit
            # non-zero rather than let the terminal look healthy.
            gone = self.dead_service()
            if gone:
                code = gone.process.returncode if gone.process else "?"
                self.emit("suite", f"error: {gone.name} exited ({code}) — shutting the stack down")
                self.failure = gone.name
                break

            if time.monotonic() >= next_probe:
                next_probe = time.monotonic() + PROBE_INTERVAL_SECONDS
                for service in self.services:
                    state = probe(service)
                    if state == service.health:
                        continue
                    service.health = state
                    if state == "down":
                        self.emit(
                            "suite",
                            f"warn: {service.name} stopped answering on :{service.port}",
                        )
                    else:
                        self.emit("suite", f"{service.name} ready on :{service.port}")

        self.shutdown()
        return 1 if self.failure else 0

    def _on_signal(self, number: int, _frame: FrameType | None) -> None:
        self.emit("suite", f"received {signal.Signals(number).name} — stopping")
        self.stopping.set()

    # ── shutdown ─────────────────────────────────────────────────────────────

    def shutdown(self, *, force: bool = False) -> None:
        # Also set on the signal path; set again for the paths that get here
        # without one — a service exiting, or start-up never becoming healthy.
        self.stopping.set()

        for service in self.services:
            self._terminate(service, force=force)

        if self.with_cpa or self.caddy:
            containers = ", ".join(
                name for name, on in (("cpa", self.with_cpa), ("caddy", self.caddy)) if on
            )
            self.emit("suite", f"stopping {containers} container(s)")
            # `down` takes the whole Compose project, which is this instance's
            # own — the project name carries the instance name, so nothing
            # another instance owns is inside it.
            #
            # An ephemeral instance takes its volume with it; a persistent one
            # keeps CPA's enrolment between runs. `force` shortens the wait —
            # it does not change what survives, because a hard stop is still
            # not a decision to discard the instance's data.
            arguments = ["down"]
            if self.instance.mode == "ephemeral":
                arguments.append("--volumes")
            if force:
                arguments += ["--timeout", "0"]
            _ = subprocess.run(
                compose_argv(self.instance.compose_project, *arguments),
                cwd=REPO,
                env=self.environment,
                capture_output=True,
                text=True,
                check=False,
            )

        self.drain(block=0.3)
        self.instance.state_path.unlink(missing_ok=True)

        if self.instance.mode == "ephemeral":
            self.emit("suite", f"destroying ephemeral instance '{self.instance.name}'")
            self.drain(block=0.2)
            for handle in self.files.values():
                handle.close()
            self.files = {}
            shutil.rmtree(self.instance.root, ignore_errors=True)

        for handle in self.files.values():
            handle.close()
        self.lock.release()

    def _terminate(self, service: Service, *, force: bool) -> None:
        process = service.process
        if not process or process.poll() is not None:
            return
        try:
            group = os.getpgid(process.pid)
        except ProcessLookupError:
            return

        if force:
            signal_group(group, signal.SIGKILL)
            return

        signal_group(group, signal.SIGTERM)
        deadline = time.monotonic() + STOP_GRACE_SECONDS
        while time.monotonic() < deadline:
            self.drain(block=0.1)
            if process.poll() is not None:
                return
        self.emit("suite", f"warn: {service.name} ignored SIGTERM — killing its process group")
        signal_group(group, signal.SIGKILL)
