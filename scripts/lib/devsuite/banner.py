"""
The status header, and the first-run details that follow it.

Every start, resume and attach prints the same block, read from the instance's
own files rather than from the flags of the command that happens to be running:
an attach has none of them, and it is the run that needs the answers most.
"""

import sys
import time
from dataclasses import dataclass

from devsuite.console import OUT, relative
from devsuite.environment import educator_credentials, origins
from devsuite.instance import Instance
from devsuite.layout import (
    BOOTSTRAP_TOKEN_TTL_SECONDS,
    EDUCATOR_LOGIN_PATH,
    NAME_COLUMN,
    SETUP_PATH,
)
from devsuite.logview import SERVICE_COLOUR


def service_name(name: str) -> str:
    """A service's name in its own colour, in the column every view shares."""
    return OUT.paint(name.ljust(NAME_COLUMN), SERVICE_COLOUR[name])


def banner(
    instance: Instance,
    ports: dict[str, int],
    level: str,
    with_cpa: bool,
    production: bool,
    ctrl_c: str,
    caddy: bool = False,
) -> None:
    rule = OUT.dim("─" * 66)
    mode = OUT.bold(instance.mode)
    app_origin, sandbox_origin = origins(ports, caddy=caddy)
    dot = OUT.dim("·")
    print(rule)
    title = f"{OUT.bold('Setun dev suite')}  {dot}  instance {OUT.bold(instance.name)} ({mode})"
    print(f"  {title}  {dot}  log level {OUT.bold(level)}")
    build = OUT.bold("production build") if production else OUT.dim("dev server")
    print(f"  {service_name('app')} {app_origin} {dot} {build}")
    served = OUT.dim("built · served by caddy") if caddy else OUT.dim("built (always)")
    print(f"  {service_name('sandbox')} {sandbox_origin} {dot} {served}")
    if caddy:
        upstream = OUT.dim("upstream host.docker.internal:" + str(ports["app"]))
        where = f":{ports['caddy']} {OUT.dim('(container)')}"
        print(f"  {service_name('caddy')} {where} {dot} {upstream}")
    if with_cpa:
        where = f"http://127.0.0.1:{ports['cpa']} {OUT.dim('(container)')}"
        print(f"  {service_name('cpa')} {where}")
    for label, value in sign_in_rows(instance, ports, caddy=caddy):
        print(f"  {OUT.dim(label.ljust(NAME_COLUMN))} {value}")
    print(f"  {OUT.dim('data'.ljust(NAME_COLUMN))} {OUT.dim(relative(instance.data))}")
    print(f"  {OUT.dim('logs'.ljust(NAME_COLUMN))} {OUT.dim(relative(instance.logs))}")
    print(f"  {OUT.dim('Ctrl-C'.ljust(NAME_COLUMN))} {OUT.dim(ctrl_c)}")
    print(rule)
    _ = sys.stdout.flush()


def sign_in_rows(
    instance: Instance, ports: dict[str, int], *, caddy: bool = False
) -> list[tuple[str, str]]:
    """
    Where an operator signs in, and as whom.

    Read from instance.json — and, where the stack is up, from the state its
    supervisor recorded — on every call rather than only on the run that minted
    the values: a `resume`, a re-`start` and an attach all land on the same
    instance and all need the same answer, and the alternative is reading a
    gitignored JSON file by hand.

    The application origin's root is the *student* login and asks for an access
    code, so it is never the answer to this question — the row names
    /educator/login, or /setup where the wizard still owns the installation.
    """
    origin, _ = origins(ports, caddy=caddy)
    config = instance.read_config()

    if config.get("first_run"):
        # Deliberately vague, because at banner time it is: the wizard's own
        # state lives in a database the application has not opened yet, and
        # whether this run needs a token or is walking into a finished
        # installation is `announce_first_run`'s answer once it has.
        return [("set up", OUT.dim("first-run wizard — the details follow once the app answers"))]

    credentials = educator_credentials(config, instance.read_state())
    rows = [("sign in", f"{origin}{EDUCATOR_LOGIN_PATH}")]
    if credentials is None:
        return rows

    username, password = credentials
    from_environment = OUT.dim("(password from the environment or .env)")
    rows.append(
        ("as", f"{username} / {password}" if password else f"{username} {from_environment}")
    )
    return rows


@dataclass(frozen=True)
class BootstrapToken:
    """A token the application left on disk, and whether it is still worth typing."""

    value: str
    expired: bool


def read_bootstrap_token(instance: Instance, wait: float) -> BootstrapToken | None:
    """
    The first-run token the application wrote, once it has written one.

    None means the application minted nothing, and the only reason it does that
    is a setup it already considers finished — so the caller reports a wizard
    this instance completed on an earlier run rather than a missing token.

    A file that is past its fifteen minutes is reported as expired rather than
    as absent, because the two mean opposite things to whoever reads the banner.
    The application mints once, holds the token in memory, and evaluates expiry
    there; the file is a second sink it unlinks at exit and on completion, and
    at no point in between. So a stack left running past the deadline keeps a
    file the setup claim now refuses, and an attach that printed it would be
    handing over a credential that cannot work. The mtime is the mint:
    `writeBootstrapTokenFile` removes the file and rewrites it every time.
    """
    deadline = time.monotonic() + wait
    path = instance.bootstrap_token_path
    while True:
        try:
            token = path.read_text(encoding="utf-8").strip()
            age = time.time() - path.stat().st_mtime
        except OSError:
            token, age = "", 0.0
        if token:
            return BootstrapToken(token, age > BOOTSTRAP_TOKEN_TTL_SECONDS)
        if time.monotonic() >= deadline:
            return None
        time.sleep(0.2)


def announce_first_run(
    instance: Instance, ports: dict[str, int], wait: float, *, caddy: bool = False
) -> None:
    """
    Put the bootstrap token where the operator is actually looking.

    The application prints it to its own log and nowhere else, which a detached
    start never shows and an attached one buries under Vite's start-up. Lifting
    it onto the suite's own output is the whole reason the suite points
    SETUN_BOOTSTRAP_TOKEN_PATH at the instance; it is not a second copy of a
    secret, because the log it comes from is the same log the suite is already
    rendering.
    """
    origin, _ = origins(ports, caddy=caddy)
    minutes = BOOTSTRAP_TOKEN_TTL_SECONDS // 60
    token = read_bootstrap_token(instance, wait)
    if token is None:
        made = OUT.dim("(the account the wizard created)")
        print(f"  {OUT.dim('sign in'.ljust(NAME_COLUMN))} {origin}{EDUCATOR_LOGIN_PATH} {made}")
    elif token.expired:
        # Naming it as lapsed rather than printing it: the value is still on
        # disk, but `/setup` stopped accepting it, and only a restart mints
        # another — the application does not re-mint on expiry.
        lapsed = OUT.dim(f"(its {minutes} minutes are up — `devsuite restart` mints a new one)")
        print(f"  {OUT.dim('set up'.ljust(NAME_COLUMN))} {origin}{SETUP_PATH}")
        print(f"  {OUT.dim('token'.ljust(NAME_COLUMN))} {OUT.bold('lapsed')} {lapsed}")
    else:
        life = OUT.dim(f"({minutes} minutes; a restart mints a new one)")
        print(f"  {OUT.dim('set up'.ljust(NAME_COLUMN))} {origin}{SETUP_PATH}")
        print(f"  {OUT.dim('token'.ljust(NAME_COLUMN))} {OUT.bold(token.value)} {life}")
    _ = sys.stdout.flush()
