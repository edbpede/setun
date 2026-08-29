"""
Docker Compose: finding it, reaching an engine, and saying so when neither works.

The two containerised services — CPA and Caddy — are Compose's to run; the suite
only follows their logs. Everything about discovering a working Compose on a
developer's machine, and about explaining a machine where there is not one,
lives here.
"""

import shutil
import subprocess
from collections.abc import Sequence
from pathlib import Path

from devsuite.console import fail, note, relative
from devsuite.layout import COMPOSE_FILE, REPO

# Compose comes in two shapes on a developer's machine: the `docker compose`
# CLI plugin that Docker Desktop ships, and the standalone `docker-compose`
# binary that Homebrew installs. A Homebrew-and-Colima machine has the second
# and not the first — a normal macOS setup, not a broken one — so the suite
# uses whichever is there rather than insisting on the one it expected. Neither
# needs the `docker` CLI itself: Compose talks to the engine directly, through
# the same docker context.
_COMPOSE_CACHE: dict[str, list[str]] = {}

# Where Homebrew keeps a formula's binaries when the formula is not linked.
# `docker` unlinked is easy to end up with and hard to read from the symptom:
# Colima refuses to start with "docker not found, run \'brew install docker\'"
# on a machine where `brew list` shows docker installed.
UNLINKED_DOCKER = (
    Path("/opt/homebrew/opt/docker/bin/docker"),
    Path("/usr/local/opt/docker/bin/docker"),
)


def unlinked_docker() -> Path | None:
    """A Homebrew `docker` that exists but is not on PATH."""
    if shutil.which("docker"):
        return None
    return next((path for path in UNLINKED_DOCKER if path.exists()), None)


def compose_candidates() -> list[list[str]]:
    """
    Every way this machine might reach Compose, best first.

    An unlinked Homebrew `docker` still carries its CLI plugins, so it is worth
    asking directly before falling back. Between that and the standalone
    binary, the suite never needs `brew link` — only Colima does, for its own
    dependency check.
    """
    candidates = [["docker", "compose"]]
    keg = unlinked_docker()
    if keg:
        candidates.append([str(keg), "compose"])
    candidates.append(["docker-compose"])
    return candidates


def compose_command() -> list[str] | None:
    """The Compose command on this machine, or None if there is not one."""
    if "argv" not in _COMPOSE_CACHE:
        _COMPOSE_CACHE["argv"] = []
        for candidate in compose_candidates():
            if not shutil.which(candidate[0]):
                continue
            try:
                probe = subprocess.run(
                    [*candidate, "version"], capture_output=True, text=True, timeout=20, check=False
                )
            except OSError, subprocess.SubprocessError:
                continue
            if probe.returncode == 0:
                _COMPOSE_CACHE["argv"] = candidate
                break
    return _COMPOSE_CACHE["argv"] or None


def compose_argv(project: str, *arguments: str) -> list[str]:
    command = compose_command()
    if command is None:
        fail(
            "no Docker Compose command found",
            hint="Install one (`brew install docker-compose`), or run without --with-cpa.",
        )
    # --project-directory pins relative paths in the compose file to the
    # repository root rather than to scripts/, so ./cpa/config.yaml means the
    # same thing there as it does in docker-compose.yml.
    return [
        *command,
        "--project-name",
        project,
        "--project-directory",
        str(REPO),
        "--file",
        str(COMPOSE_FILE),
        *arguments,
    ]


def daemon_reachable(command: Sequence[str]) -> bool:
    """
    Whether Compose can reach an engine.

    `ls` is the cheapest question that actually needs the daemon. `version`
    answers from the binary alone and would pass with nothing running behind it,
    which is exactly the case this has to catch.
    """
    try:
        probe = subprocess.run(
            [*command, "ls"], capture_output=True, text=True, timeout=30, check=False
        )
    except OSError, subprocess.SubprocessError:
        return False
    return probe.returncode == 0


def engine_hint() -> str:
    """Advice naming the engine this machine actually has, not a guessed one."""
    keg = unlinked_docker()
    if keg:
        # Compose does not need the docker CLI, and the suite has already found
        # one by the time this runs. Colima does: its dependency check refuses
        # to start the VM without a `docker` on PATH, reporting it as not
        # installed on a machine where it plainly is.
        return (
            f"`docker` is installed at {keg} but is not on PATH.\n"
            "Compose does not need it; Colima's own dependency check does.\n"
            "\n"
            "Put it on PATH, changing no Homebrew state:\n"
            f'  export PATH="{keg.parent}:$PATH"\n'
            "Or link it — brew names the conflicting formula if there is one:\n"
            "  brew link docker\n"
            "\n"
            "Then start the engine:\n"
            "  colima start"
        )
    if shutil.which("colima"):
        try:
            running = (
                subprocess.run(
                    ["colima", "status"], capture_output=True, text=True, timeout=20, check=False
                ).returncode
                == 0
            )
        except OSError, subprocess.SubprocessError:
            running = False
        if not running:
            return "Colima is installed but its VM is not running:\n  colima start"
        return (
            "Colima is running but Compose cannot reach it — check the active context:\n"
            "  colima status\n"
            '  export DOCKER_HOST="unix://$HOME/.colima/default/docker.sock"'
        )
    if Path("/Applications/Docker.app").exists():
        return "Docker Desktop is installed but not running:\n  open -a Docker"
    return (
        "No Docker engine was found. On macOS either works:\n"
        "  brew install colima docker-compose && colima start\n"
        "  or install Docker Desktop"
    )


def warn_on_gateway_key_mismatch(key: str) -> None:
    """
    Warn when CPA's own config does not carry the key the app will present.

    The listener key is the only thing authenticating the gateway (PRD §9), and
    it lives in two files that nothing keeps in step: the environment or the
    instance's own config on one side, `cpa/config.yaml` on the other. Out of
    step, everything starts healthy and the first model call answers 401 — so it
    is worth saying at start-up rather than leaving to be met in a lesson.

    A substring test rather than a parse: there is no YAML reader in the
    standard library, and the question is only whether the value appears at all.
    """
    path = REPO / "cpa" / "config.yaml"
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return
    if key in text:
        return
    note(f"warning: {relative(path)} does not list this instance's listener key")
    note("         the gateway will answer 401 until its `api-keys:` and")
    note("         SETUN_CPA_LISTENER_KEY hold the same value")


def check_cpa_prerequisites() -> None:
    command = compose_command()
    if command is None:
        fail(
            "no Docker Compose command found",
            hint=(
                "CPA is the only containerised service in the local stack. It needs either\n"
                "the `docker compose` CLI plugin or the standalone `docker-compose` binary;\n"
                "the `docker` CLI itself is not required.\n"
                "  brew install docker-compose\n"
                f"{engine_hint()}\n"
                "Or drop --with-cpa to run app and sandbox alone."
            ),
        )

    if not daemon_reachable(command):
        fail(
            f"`{' '.join(command)}` cannot reach a Docker engine",
            hint=f"{engine_hint()}\nOr drop --with-cpa to run app and sandbox alone.",
        )

    if not (REPO / "cpa" / "config.yaml").exists():
        fail(
            "cpa/config.yaml is missing",
            hint=(
                "CPA's own configuration is the gateway operator's file (PRD §9).\n"
                "  cp cpa/config.example.yaml cpa/config.yaml\n"
                "Then set its api-keys entry to the value of SETUN_CPA_LISTENER_KEY."
            ),
        )


def check_caddy_prerequisites() -> None:
    """
    Caddy needs the same Compose that CPA does, and says so in its own terms.

    Separate from `check_cpa_prerequisites` because the way out is different:
    CPA is opted *in* to and can simply be dropped, while Caddy comes with
    `--production` and is opted *out* of.
    """
    command = compose_command()
    if command is None or not daemon_reachable(command):
        reason = (
            "no Docker Compose command found"
            if command is None
            else f"`{' '.join(command)}` cannot reach a Docker engine"
        )
        fail(
            f"--production runs the deployment's Caddy, and {reason}",
            hint=(
                "Caddy is what makes the local stack match a deployment: the same image,\n"
                "the repository's own Caddyfile, two hostnames and a real proxy hop.\n"
                "  brew install docker-compose\n"
                f"{engine_hint()}\n"
                "Or run `--production --no-caddy` for the build on two Vite servers."
            ),
        )
