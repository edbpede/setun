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

**Two origins, always.** Artifacts execute on a separate hostname from the application, and
that separation *is* the isolation (PRD §14) — so development runs two servers, and `bun run
build` produces two outputs: `build/` for the application and `build-sandbox/` for the static
artifact host Caddy serves. Running only the first leaves the Build panel with nothing to
render.

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
cp .env.example .env            # fill every variable; boot fails loudly on a missing one
cp mcp.example.json mcp.json    # the tool servers this installation offers (PRD §11)
docker compose up -d
```

`mcp.json` is where MCP servers are defined: an endpoint is a security decision, so it lives
in reviewable configuration rather than in the database or the panel, and credentials are
referenced there by the *name* of an environment variable. The panel switches configured
servers on, chooses which of their tools each class may use, and marks the ones that should
ask before they run — it can add nothing. A deployment that offers no tools keeps the file
with an empty `servers` object.
