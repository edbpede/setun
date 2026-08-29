"""
Setun development suite — one entry point for the whole local stack.

The stack this drives is the one the repository actually has (package.json,
docker-compose.yml):

  app       the SvelteKit application, `bun run dev`, on :5173
  sandbox   the artifact origin, `bun run dev:sandbox`, on :5174 — a separate
            origin is the isolation mechanism (PRD §14), so it is not optional
  cpa       CLIProxyAPI, the model gateway, a pinned container on :8317 —
            opt-in with `--with-cpa`, because it needs Docker and an operator's
            filled-in cpa/config.yaml
  caddy     the proxy tier, a pinned container on :8080 reading the
            repository's own Caddyfile — part of `--production`, because that
            flag means "the way a deployment runs it" and a deployment has one
  database  SQLite, a file rather than a service; there is no process to run,
            so the suite owns *where the file lives* instead

Two shapes, then. Without `--production` the two Vite servers answer directly on
their own ports, which is the fast loop. With it, Caddy sits in front on two
`*.localhost` hostnames and serves the instance's own `build-sandbox/` itself,
so the static server, the response headers, the origin shape and the proxy hop
are the ones a deployment actually has rather than Vite's approximations of
them. `--no-caddy` takes it back out for a machine without Docker.

Only TLS is left behind: the site addresses carry an explicit `http://`, which
is what tells Caddy to skip ACME. Everything else in the Caddyfile is read here
exactly as it is read in deployment, because it is the same file.

Written in Python 3 with the standard library alone: the unified log view
multiplexes several live process streams into one re-rendered, aligned view,
which wants threads and pipes rather than the background subshells and FIFOs
the same thing costs in shell.

The layers, innermost first — no module imports one above it:

  layout       where everything lives, and the constants that name it
  console      the suite's own voice: colour, notes, and how it gives up
  util         small shared helpers with no home of their own
  logview      one normalised line shape, one renderer, the log files
  compose      finding Docker Compose, and explaining a machine without one
  instance     an instance's directories, its lock, its state, its cleanup
  environment  the environment the children are spawned with
  services     the four services, as commands
  health       ports before the start, probes after it
  supervisor   one process owning every child
  banner       the header, and the first-run details that follow it
  options      the parsed command line, and what each command asks of it
  commands/    start, stop, kill, restart, status, logs, list, resume, destroy
  cli          the parser and `main`
"""

from devsuite.cli import main as main
