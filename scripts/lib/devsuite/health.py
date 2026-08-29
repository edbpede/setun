"""
Ports and health.

Two questions that look alike and are not: whether a port can be bound before
the stack starts, and whether something is answering on it once it has.
"""

import http.client
import shutil
import socket
import subprocess
import urllib.error
import urllib.request
from collections.abc import Sequence
from typing import cast

from devsuite.console import fail
from devsuite.services import Service


def require_binary(name: str, *, hint: str) -> str:
    found = shutil.which(name)
    if not found:
        fail(f"`{name}` is not on PATH", hint=hint)
    return found


def port_owner(port: int) -> str:
    """Best-effort description of what already holds a port, for the message."""
    lsof = shutil.which("lsof")
    if not lsof:
        return ""
    try:
        result = subprocess.run(
            [lsof, "-nP", f"-iTCP:{port}", "-sTCP:LISTEN", "-F", "cn"],
            capture_output=True,
            text=True,
            timeout=4,
            check=False,
        )
    except subprocess.SubprocessError, OSError:
        return ""
    commands = [line[1:] for line in result.stdout.splitlines() if line.startswith("c")]
    return f" (held by {commands[0]})" if commands else ""


# Every shape `getaddrinfo` can hand back as a sockaddr: IPv4, IPv6, and the
# link-layer form. Spelled out because `bind` takes the tuple as it comes.
type SocketAddress = tuple[str, int] | tuple[str, int, int, int] | tuple[int, bytes]


def loopback_addresses(port: int) -> list[tuple[socket.AddressFamily, SocketAddress]]:
    """
    Every loopback address `localhost` resolves to, IPv4 and IPv6 alike.

    Node stopped reordering DNS results at 17, so on macOS `localhost` resolves
    to ::1 first and a Vite dev server listens *only* there. A probe or a bind
    test that assumed 127.0.0.1 would report a server that is running as absent,
    and a port that is taken as free.
    """
    try:
        resolved = socket.getaddrinfo("localhost", port, type=socket.SOCK_STREAM)
    except socket.gaierror:
        return [(socket.AF_INET, ("127.0.0.1", port))]
    return [(family, address) for family, _, _, _, address in resolved]


def port_free(port: int) -> bool:
    for family, address in loopback_addresses(port):
        with socket.socket(family, socket.SOCK_STREAM) as probe_socket:
            probe_socket.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                probe_socket.bind(address)
            except OSError:
                return False
    return True


def check_ports(ports: dict[str, int], services: Sequence[str]) -> None:
    # A free port is not yet a usable one. Two services given the same number
    # both pass a bindability probe and then race for the single endpoint, so
    # the clash has to be caught here rather than as a service exiting later
    # and taking the whole stack down with it.
    wanted: dict[int, list[str]] = {}
    for name in services:
        wanted.setdefault(ports[name], []).append(name)
    clashing = [(port, names) for port, names in sorted(wanted.items()) if len(names) > 1]
    if clashing:
        details = "\n".join(f"{' and '.join(names)} both want :{port}" for port, names in clashing)
        fail(
            "two services in this stack were given the same port",
            hint=(
                f"{details}\n"
                "Each one needs its own:\n"
                "  ./scripts/devsuite start --port 5173 --sandbox-port 5174 --cpa-port 8317"
            ),
        )

    taken = [(name, ports[name]) for name in services if not port_free(ports[name])]
    if not taken:
        return
    details = "\n".join(f"{name} wants :{port}{port_owner(port)}" for name, port in taken)
    fail(
        "a port the stack needs is already in use",
        hint=(
            f"{details}\n"
            "Either stop what holds it, or move this instance:\n"
            "  ./scripts/devsuite start --port 6173 --sandbox-port 6174"
        ),
    )


def tcp_open(port: int, timeout: float = 0.6) -> bool:
    # `localhost` rather than an address: create_connection walks every result
    # getaddrinfo returns, so it finds a server on either loopback family.
    try:
        socket.create_connection(("localhost", port), timeout).close()
    except OSError:
        return False
    return True


def http_answers(port: int, path: str = "/", timeout: float = 2.0) -> bool:
    """
    Any HTTP status counts.

    A 404 from the sandbox origin still proves a server answered on that port,
    and the sandbox deliberately serves no history fallback.
    """
    request = urllib.request.Request(f"http://localhost:{port}{path}", method="GET")
    try:
        # urlopen is typed as returning Any because it answers for every scheme
        # it knows; the URL above is http, and http is what it opens.
        response = cast(
            "http.client.HTTPResponse", urllib.request.urlopen(request, timeout=timeout)
        )
        response.close()
    except urllib.error.HTTPError:
        return True
    except urllib.error.URLError, OSError, ValueError:
        return False
    return True


def probe(service: Service, *, deep: bool = False) -> str:
    """
    `deep` asks for readiness over HTTP; otherwise liveness over TCP.

    Startup wants the first — Vite binds its port a moment before it will serve
    anything. The steady-state loop wants the second, because an HTTP GET every
    few seconds is a request the application would log forever.

    Caddy is asked over TCP alone. It answers HTTP only on the two hostnames its
    site addresses name, so a request to `localhost:<port>` gets a 404 from a
    perfectly healthy proxy — a liveness question is the one it can answer.
    """
    if deep and service.name in ("app", "sandbox"):
        return "up" if http_answers(service.port) else "down"
    return "up" if tcp_open(service.port) else "down"
