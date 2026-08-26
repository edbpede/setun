# Setun

A self-hosted, privacy-first learning environment for teaching AI and *Teknologiforståelse*.
Students get pseudonymous access to modern AI models, a code artifact workspace, and curated
tools — no accounts, no email addresses, no names, no third-party identity.

Licensed AGPL-3.0.

## Normative documents

Three files govern this repository, in this order of authority:

| File | Carries |
| --- | --- |
| `docs/setun-prd.md` | What to build and why — scope, behaviour, data model, security (§21), testing (§22), Appendix A defaults |
| `docs/setun-implementation-plan.md` | In what order, and how each phase proves itself. **The single source of progress truth** |
| `.agents/rules/svelte5-sveltekit-app.md` | The stack idiom, version-anchored, with its anti-pattern table |

## Setup

Requires [Bun](https://bun.com) 1.4 or newer.

```sh
bun install          # also compiles Paraglide messages and syncs SvelteKit types
prek install         # git hooks — required before your first commit
bun --bun run dev    # the application, on :5173
bun run dev:sandbox  # the artifact origin, on :5174 — a second terminal
```

`prek install` is not optional: the hooks enforce Conventional Commits, block direct commits
to `main`, and run the secret scanner. Install [prek](https://prek.j178.dev) separately.

`./scripts/devsuite start` runs both servers, the database and the log view from a single
terminal — see [Development suite](#development-suite).

**Two origins, always.** Artifacts execute on a separate hostname from the application, and
that separation *is* the isolation (PRD §14) — so development runs two servers, and `bun run
build` produces two outputs: `build/` for the application and `build-sandbox/` for the static
artifact host Caddy serves. Running only the first leaves the Build panel with nothing to
render.

## Development suite

`scripts/devsuite` runs the whole local stack from one place — both Vite servers, a per-instance
SQLite database, and optionally the CLIProxyAPI container — and streams every service into one
aligned, colour-coded log view.

```sh
./scripts/devsuite start        # bring the stack up and attach to the log view
./scripts/devsuite status       # what is running, on which ports, healthy or not
./scripts/devsuite logs app     # follow one service
./scripts/devsuite stop         # graceful shutdown, data preserved
./scripts/devsuite --help       # every command and flag
```

`start` runs in the foreground and **Ctrl-C stops the stack**. Add `--detach` to leave it running
and come back with `logs`, where **Ctrl-C only detaches**. Starting an instance that is already
running attaches to its log view rather than spawning a second one.

Every start, resume and attach prints where to sign in and as whom.
`http://localhost:5173` is the **student** login and asks for an access code; the educator entry
point is `/educator/login`, panel at `/educator`.

Caddy is not part of it: locally Vite serves both origins on their own ports, and the Caddyfile
needs real hostnames and certificates. CPA is opt-in with `--with-cpa` — it needs a Docker engine
and an operator's filled-in `cpa/config.yaml`, and it runs from `scripts/devsuite.compose.yml`
because the deployment's CPA is deliberately unreachable from the host (PRD §6, §9).

Either form of Compose works, and the `docker` CLI itself is not required — Compose reaches the
engine directly. The `docker compose` plugin that Docker Desktop ships is one; the standalone
`docker-compose` that Homebrew installs is the other, which is what a Colima machine has:

```sh
brew install colima docker-compose && colima start   # a Docker engine without Docker Desktop
```

CPA's `api-keys:` must carry the same value as `SETUN_CPA_LISTENER_KEY` — it is the only thing
authenticating the gateway (PRD §9), and nothing keeps the two files in step. Where the suite
minted the key itself, it is in that instance's `instance.json`. `--with-cpa` warns at start-up
when the two disagree, rather than leaving a 401 to be met on the first model call.

Colima *does* need the `docker` CLI on PATH for its own dependency check, even though the suite
does not. A Homebrew `docker` that is installed but unlinked makes `colima start` report it as
missing; `brew link docker`, or putting `$(brew --prefix docker)/bin` on PATH, settles it. The
suite says so by name when it cannot reach an engine.

### Two modes

**`--persistent NAME`** — a named instance whose data survives `stop`. The default, as `dev`.
`resume NAME` brings one back, `list` shows them all, `destroy NAME` removes one for good.

**`--ephemeral`** — a throwaway instance on a fresh database, destroyed on the way out: on
`stop`, on Ctrl-C, and on a crash.

```sh
./scripts/devsuite start  --persistent demo
./scripts/devsuite stop   --persistent demo
./scripts/devsuite resume demo             # the same data
./scripts/devsuite start  --ephemeral      # fresh database, nothing left behind
```

The four values `.env.example` gives no default for — the code pepper, the two educator seed
credentials and the CPA listener key — are read from the environment or `.env` when they are
there. When they are not, the suite mints development values *per instance* and keeps them in
that instance's own `instance.json`; it never writes to `.env`. A generated educator signs in as
`educator` / `educator`, and the banner says so on every run, not only the one that minted them.
A password *you* supplied through the environment or `.env` is named rather than echoed. While a
stack is up the banner reports the account that stack was *started* with — recorded in its
`run/state.json` — rather than whatever the environment or `.env` says now, because the running
application seeded the former and only a restart would pick up the latter.

### Exercising the first-run wizard

An instance with seed credentials is a finished installation by definition (PRD §6.2), so it
never sees the wizard. `--first-run` is the instance that does:

```sh
./scripts/devsuite start --first-run --persistent setup --port 6173 --sandbox-port 6174
```

It blanks both `SETUN_EDUCATOR_SEED_*` variables for the child — a blank counts as absent — so
the application gates every path to `/setup`. This is the one place the suite overrides a real
environment variable or a line in `.env`; it says so when it does.

The bootstrap token is lifted onto the suite's own banner, by pointing
`SETUN_BOOTSTRAP_TOKEN_PATH` at the instance's `run/` directory. That is what makes `--detach`
usable here: otherwise the token is printed only to a log file nobody is watching. It is valid
fifteen minutes and a restart mints another; the application evaluates that deadline in memory and
leaves the file alone until it exits, so the suite dates the file and reports a token past its
fifteen minutes as lapsed rather than printing one `/setup` would refuse.

The flag needs a database that has never been through setup, because "setup started" and "setup
completed" are recorded in the database itself; an instance that already has one is refused, with
`--ephemeral` and `destroy` named as the ways forward. It is remembered in `instance.json` rather
than passed on every run, so `resume` comes back to an unfinished wizard — with a fresh token and
your progress intact — rather than seeding an account half-way through creating one.

### Log levels

`--log-level silent|error|warn|info|debug|trace`, default `info`. `-v` is `debug`, `-vv` is
`trace`.

| Service | How the level reaches it |
| --- | --- |
| `app`, `sandbox` | Vite's own `--logLevel` for `silent`, `error`, `warn` and `info`. `debug` and `trace` pin Vite at `info` and raise `SETUN_LOG_LEVEL`, which gates the application's own logging and turns on **Drizzle query logging** — statements *with their bound parameters*, which is why it takes an explicit `--log-level debug`. `trace` also sets `DEBUG=vite:*`. |
| `cpa` | **Not reachable.** CPA reads `debug:` from `cpa/config.yaml`, an operator file the suite will not rewrite. Its lines are filtered at the log view instead. |
| the log view | Whatever a service still prints below the chosen level is dropped on the way to the terminal. |

The per-service files under `.devsuite/instances/<name>/logs/` are never filtered — the view has
a floor, the file is the record. The view degrades to plain, greppable lines when stdout is not a
terminal or `NO_COLOR` is set.

### Where state lives

Everything is inside the repository, under `.devsuite/`, and gitignored:

```
.devsuite/instances/<name>/
  instance.json   mode, ports, and any generated development values
  data/           db/setun.sqlite, storage/, backups/ — this instance's whole state
  logs/           one plain, timestamped file per service
  run/            state.json, the lock that makes `start` idempotent, and — under
                  --first-run — the bootstrap token the banner reads back
```

Nothing is written to `$HOME` or `/tmp`.

## Gates

All five must be green; nothing merges past a red one, including a pre-existing failure.

```sh
bun run check         # svelte-check — the authority on template and type correctness
bunx biome ci         # format + lint, writes nothing
bun test              # server logic and rune modules
bunx vitest run       # component behaviour, Vitest Browser Mode
bunx playwright test  # end-to-end
prek run --all-files  # hooks: format, hygiene, gitleaks
```

## Conventions

**All user-facing text flows through Paraglide messages — never string literals in
components** (PRD §5). Add the key to both `messages/en.json` and `messages/da.json`, then call
it as `m.my_key()`. English is the default locale; Danish ships complete at pilot. A component
containing a bare user-visible string is a defect, not a shortcut — `src/routes/stack-check/`
is the worked example.

**Test placement follows the tool that can actually run it** (PRD §22):

| Target | Tool | Filename |
| --- | --- | --- |
| Server logic, `.svelte.ts` rune modules | `bun test` | `*.test.ts` |
| `.svelte` component behaviour | Vitest Browser Mode | `*.svelte.spec.ts` |
| Flows through a real server | Playwright | `*.e2e.ts` |

The three suffixes are disjoint so each runner claims only its own files; `bunfig.toml` keeps
`bun test` off the other two.

**Styling is UnoCSS, not Tailwind.** Never run `shadcn-svelte init` — `components.json` is
hand-written and `tailwind.config.js` is an empty stub that exists only to satisfy the CLI's
`add` command. Add components with:

```sh
bunx shadcn-svelte add <component> --skip-preflight
```

`--skip-preflight` is required: the CLI's preflight insists on an installed Tailwind.

**Biome does not judge `.svelte` templates.** It parses `<script>` but not the markup, so
`noUnusedImports` and `noUnusedVariables` are disabled for `.svelte` files in `biome.json` —
otherwise every template-only import reads as unused, and `--write --unsafe` would delete it.
`svelte-check` is the authority there. Never run Biome's unsafe fixes over a component.

## Theme

The design baseline is the tweakcn **clean-slate** theme (PRD §5), light mode by default. A
Tailwind project would install it with
`bunx shadcn@latest add https://tweakcn.com/r/themes/clean-slate.json`; Setun runs UnoCSS, so
its variables are ported by hand into `uno.config.ts` as bare **oklch** components — that is
what `unocss-preset-shadcn`'s Wind4 entry resolves, whatever its published types claim.

## Deployment

Three containers: the app, CLIProxyAPI (the model gateway), and Caddy. The operator surface is
the Compose file, one `.env`, and the MCP configuration file; CPA's own `cpa/config.yaml` is
the gateway operator's file, where provider accounts are enrolled on the host (PRD §9).

```sh
cp .env.example .env            # fill every required value; boot fails loudly on a missing one
cp mcp.example.json mcp.json    # the tool servers this installation offers (PRD §11)
docker compose up -d
```

The educator seed credentials are **optional**. Left blank, the first boot prints a one-time
setup token to the container log and sends every request to `/setup`, where a wizard creates the
account, checks the gateway, and makes the first model alias and classroom. Filled in, the
account is seeded at every boot instead — which is also how a forgotten password is reset,
because there is none inside the application (PRD §6.2, §7).

**Operating a real installation — first run, DNS and TLS, provider enrolment, educator password
recovery, the backup restore procedure, and the pinned gateway upgrade — is documented in
[`docs/setun-operations.md`](docs/setun-operations.md).**

`mcp.json` is where MCP servers are defined: an endpoint is a security decision, so it lives
in reviewable configuration rather than in the database or the panel, and credentials are
referenced there by the *name* of an environment variable. The panel switches configured
servers on, chooses which of their tools each class may use, and marks the ones that should
ask before they run — it can add nothing. A deployment that offers no tools keeps the file
with an empty `servers` object.
