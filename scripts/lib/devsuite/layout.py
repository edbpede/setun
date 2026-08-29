"""
Where the suite lives and what it calls things.

Everything the suite writes is under `.devsuite/` inside the repository, so a
developer's `$HOME` and `/tmp` stay untouched and `rm -rf .devsuite` is the
whole of "start again". Nothing here imports another module of the package:
this is the layer every other one is allowed to depend on.
"""

from pathlib import Path

# scripts/lib/devsuite/layout.py — the repository is four levels up, and
# `scripts/` is two. Spelled out rather than walked for a marker file: the
# package only ever runs from inside this checkout.
_PACKAGE = Path(__file__).resolve().parent
SCRIPTS = _PACKAGE.parent.parent
REPO = SCRIPTS.parent

DEVSUITE = REPO / ".devsuite"
INSTANCES = DEVSUITE / "instances"
COMPOSE_FILE = SCRIPTS / "devsuite.compose.yml"

DEFAULT_INSTANCE = "dev"
EPHEMERAL_PREFIX = "ephemeral-"

DEFAULT_PORTS = {"app": 5173, "sandbox": 5174, "cpa": 8317, "caddy": 8080}

# The hostnames the local Caddy answers on. `*.localhost` resolves to loopback
# in every browser and in macOS's own resolver, so two genuinely separate
# origins cost no /etc/hosts entry — and separate origins are the artifact
# isolation mechanism (PRD §14), not a detail of how they are addressed.
CADDY_APP_HOST = "setun.localhost"
CADDY_SANDBOX_HOST = "sandbox.setun.localhost"

# `sandbox` is the longest service name; a fixed column keeps every log line in
# the same place whichever services happen to be running.
NAME_COLUMN = 7

STOP_GRACE_SECONDS = 12.0
HEALTH_TIMEOUT_SECONDS = 60.0

# How long a second `start` waits for the winner of the lock to open its log
# files before giving up on following them. Generous because it costs nothing:
# the wait ends the moment the files settle, or the moment the winner is gone.
ATTACH_TIMEOUT_SECONDS = 30.0

# Readiness is asked for over HTTP once, while the stack is coming up.
# After that a TCP connect answers the same question without putting a
# request through the application every few seconds.
PROBE_INTERVAL_SECONDS = 3.0

# How long to wait for the bootstrap token file after the stack is healthy.
# Short by design: the application mints on its first request and the health
# probe is a request, so the file is there by the time this is asked — this
# only covers the gap between the response and the write landing on disk. An
# instance whose setup is already finished mints nothing, and waits this out.
BOOTSTRAP_TOKEN_WAIT_SECONDS = 5.0

# How long a minted token is worth typing — BOOTSTRAP_TOKEN_TTL_MS in
# src/lib/server/auth/bootstrap.ts, which is the deadline `/setup` enforces.
# Held here because the file the application drops cannot answer the question on
# its own: expiry is evaluated in memory, and the file is unlinked only at exit
# or on completion, so a stack left running past the deadline keeps a token file
# whose contents the setup claim now refuses.
BOOTSTRAP_TOKEN_TTL_SECONDS = 15 * 60

# Where an operator signs in, per role. `/` is the *student* login and asks for
# an access code, so a banner that printed only the origin sent the one person
# who cannot use it to the one screen they cannot use.
EDUCATOR_LOGIN_PATH = "/educator/login"
SETUP_PATH = "/setup"
