"""
The parsed command line, and the questions every command asks of it.

`build_parser` gives every flag a default on the top-level parser, so each one
is present whichever subcommand ran — which is what lets a command read a flag
another subcommand owns without asking whether it is there.
"""

import os
from collections.abc import Callable
from typing import Protocol

from devsuite.console import fail, relative
from devsuite.instance import Instance, InstanceConfig, instance_for, list_instances
from devsuite.layout import DEFAULT_INSTANCE, DEFAULT_PORTS, EPHEMERAL_PREFIX
from devsuite.logview import DEFAULT_LEVEL


class Options(Protocol):
    """Every flag any subcommand defines, as one shape."""

    command: str | None
    run: Callable[[Options], int]
    persistent: str | None
    ephemeral: bool
    log_level: str | None
    verbose: int
    port: int | None
    sandbox_port: int | None
    cpa_port: int | None
    caddy_port: int | None
    with_cpa: bool
    production: bool
    no_caddy: bool
    first_run: bool
    detach: bool
    force: bool
    service: str | None
    tail: int
    # `resume` and `destroy` alone take a positional instance name.
    name: str


def chosen_level(options: Options) -> str:
    """
    The level every command renders and configures its services at.

    `main` resolves the flags into `log_level` before dispatching, so this only
    names the floor for the type checker's benefit; the fallback never fires.
    """
    return options.log_level or DEFAULT_LEVEL


def resolve_target(options: Options, *, creating: bool = False) -> Instance | None:
    """
    Pick the instance a command acts on, from --ephemeral / --persistent.

    An ephemeral instance is named after the process that started it, which no
    other terminal can guess — so every command but `start` finds the one that
    is there rather than deriving a name. Returns None when `--ephemeral` was
    asked for and there is none; the caller decides whether that is an error.
    """
    if options.ephemeral:
        if creating:
            return instance_for(f"{EPHEMERAL_PREFIX}{os.getpid()}", "ephemeral")
        return sole_ephemeral()
    name = options.persistent or DEFAULT_INSTANCE
    return instance_for(name, "persistent")


def sole_ephemeral() -> Instance | None:
    found = [instance for instance in list_instances() if instance.mode == "ephemeral"]
    if not found:
        return None
    if len(found) > 1:
        fail(
            f"{len(found)} ephemeral instances exist — say which one",
            hint="\n".join(f"--persistent {instance.name}" for instance in found),
        )
    return found[0]


def first_run_wanted(options: Options, instance: Instance, config: InstanceConfig) -> bool:
    """
    Whether this instance runs with no operator account, so the wizard gates it.

    Remembered on the instance rather than passed per run, unlike `--with-cpa`.
    The wizard is several screens and survives a `stop`, and `resume` is exactly
    when somebody comes back to an unfinished one: an instance whose seed
    credentials returned on the next start would seed an operator account
    half-way through creating one, and `adoptExistingInstall` would have nothing
    to say about it because the claim is already in the database. So the flag
    adopts an instance once and the instance keeps it — which also makes it
    idempotent, since a second `--first-run` on the same instance changes
    nothing.

    Adoption needs a database that has never been through setup, and the only
    database certain of that is one that does not exist yet: `setupStartedAt`
    and `setupCompletedAt` live in the file, and a flag that cleared them would
    be a flag that deletes data. Refusing names the two commands that discard a
    database on purpose.
    """
    already = bool(config.get("first_run"))
    if not options.first_run or already:
        return already

    if instance.database_path.exists():
        fail(
            (
                f"instance '{instance.name}' already has a database — --first-run needs "
                "one that has never been set up"
            ),
            hint=(
                "Whether first-run setup has been started or finished is recorded in the\n"
                f"database itself ({relative(instance.database_path)}), so there is nothing\n"
                "left for the wizard to claim. Point --first-run at a database that has none:\n"
                f"  ./scripts/devsuite start --first-run --persistent {instance.name}-setup\n"
                "  ./scripts/devsuite start --first-run --ephemeral\n"
                "or discard this one first:\n"
                f"  ./scripts/devsuite destroy {instance.name}"
            ),
        )
    return True


def resolve_ports(options: Options, config: InstanceConfig) -> dict[str, int]:
    stored = config.get("ports", {})
    return {
        "app": options.port or stored.get("app") or DEFAULT_PORTS["app"],
        "sandbox": options.sandbox_port or stored.get("sandbox") or DEFAULT_PORTS["sandbox"],
        "cpa": options.cpa_port or stored.get("cpa") or DEFAULT_PORTS["cpa"],
        "caddy": options.caddy_port or stored.get("caddy") or DEFAULT_PORTS["caddy"],
    }


def caddy_wanted(options: Options) -> bool:
    """
    Caddy is what `--production` means at the proxy tier, and `--no-caddy` opts out.

    Not offered without `--production`: Caddy would then be proxying Vite's dev
    server, whose host allowlist and HMR socket both assume they are addressed
    directly. That is a fight with no prize — the reason to put Caddy in front is
    to reproduce a build, and the dev server is not one.
    """
    return options.production and not options.no_caddy
