# Setun — Implementation Plan

**Derived from:** `docs/setun-prd.md` v0.6 (authoritative for all scope and behaviour)
**Status:** Active working document — implementation sessions tick checkboxes here as work lands
**Structure:** Phase 0 (bootstrap) + Phases 1–5, mapping one-to-one onto PRD milestones M1–M5 (§23)

This plan says *what to build in what order*. The PRD says *what it must do* — section references like (§10) point there. Where the PRD pins a default, Appendix A of the PRD is the value; nothing in this plan is open, optional, or "to be decided".

## Normative coding guidelines

Follow the normative coding guidelines in `.agents/rules/svelte5-sveltekit-app.md`. Every implementation session reads that file at session start, before writing code. It is authoritative for implementation idiom throughout: runes not stores, snippets not slots, `$app/state` not `$app/stores`, callback props not `createEventDispatcher`, `error()`/`redirect()` called not thrown, `Bun.password` for the educator credential, `event.locals` for request state (never module-scope mutable server state), the four `$env` modules (never `process.env`), hand-written `components.json` (never `shadcn-svelte init` under UnoCSS), the `presetWind4` theme-key corrections (`radius` and `font`, single-string font values), the `.ts` content-pipeline include, the cursor preflight restoration, and the per-layer test-tool table (`bun test` / Vitest Browser Mode / Playwright). SvelteKit remote functions are **not used** (§5) — data flows through load functions, form actions, and `+server.ts` endpoints only.

All UI and UX design work uses the `frontend-design` skill, with the tweakcn clean-slate theme as the baseline vocabulary (§5).

---

## Phase 0 — Repository and toolchain bootstrap

**Goal.** Put every quality gate in place before the first feature commit: the scaffolded SvelteKit 2 + Svelte 5 project on Bun, the validated UnoCSS + shadcn-svelte styling stack, lint/type/test wiring, CI, i18n plumbing, the Docker Compose skeleton, and git hooks. Nothing in this phase implements product behaviour; everything after this phase is checked by the gates it installs.

**Exit criterion.** A fresh clone can run `bun install`, `bun --bun run dev`, `bun run check`, `bunx biome ci`, `bun test`, `bunx vitest run`, `bunx playwright test`, and `prek run --all-files` cleanly, and GitHub Actions CI is green on the empty-feature repository with all five gates passing as separate jobs.

### 0.1 Project scaffold

- [ ] Scaffold with `bunx sv create` per `.agents/rules/svelte5-sveltekit-app.md`: SvelteKit 2, Svelte 5, TypeScript, `@sveltejs/adapter-node` (production entry `bun ./build/index.js`, §5)
- [ ] `package.json` scripts use `bun --bun run dev` / `bun --bun run build`; `bun run check` runs `svelte-check` (Vite does not type-check)
- [ ] `tsconfig.json` extends `./.svelte-kit/tsconfig.json` with `strict`, `moduleResolution: "bundler"`, `verbatimModuleSyntax`, `isolatedModules` per the rules file
- [ ] `bunfig.toml` with `[test]` preload for the `bun test` setup file
- [ ] `src/app.d.ts` skeleton typing `App.Locals` (empty for now, filled in Phase 1) and `App.Error` as `{ message: string }` — production errors carry no detail (§21)

### 0.2 Styling stack and day-one validation (§5)

- [ ] `uno.config.ts`: `presetWind4` + `unocss-preset-animations` + `unocss-preset-shadcn`, with the corrections mandated by `.agents/rules/svelte5-sveltekit-app.md`:
  - [ ] `radius` theme key (not `borderRadius`) restating the shadcn radius scale
  - [ ] `font` theme key (not `fontFamily`) with single-string values
  - [ ] `content.pipeline.include` covering `.ts` variant files — without it shadcn-svelte components render unstyled
- [ ] `vite.config.ts` with `UnoCSS()` **before** `sveltekit()`; `virtual:uno.css` imported once in the root layout; no `@unocss/reset/tailwind.css` (presetWind4 ships its own preflight)
- [ ] Global stylesheet restores the button cursor preflight (`button:not(:disabled) { cursor: pointer }`) per the rules file
- [ ] Port the tweakcn **clean-slate** theme into the preset-shadcn CSS-variable theme (§5) — space-separated HSL values
- [ ] Hand-write `components.json`; add empty `tailwind.config.js` to satisfy the CLI's `add` command; add `src/lib/utils.ts` with `cn()`; **never run `shadcn-svelte init`** (rules file, §5)
- [ ] **Stack validation:** `bunx shadcn-svelte@latest add` one non-trivial component (dialog) plus button; render both on a scratch route and verify radius, fonts, colours, and animations against the clean-slate variables before anything else is built (§5)

### 0.3 Lint, type-check, tests, CI (§5, §22)

- [ ] `biome.json` per the rules file; `bunx biome check --write` locally, `bunx biome ci` in CI; Biome is not the authority on `.svelte` templates — `svelte-check` is
- [ ] `bun test` skeleton: one passing placeholder test under `src/lib/server/`, `bun:test` imports
- [ ] Vitest Browser Mode skeleton: client/server project split in `vite.config.ts` per the rules file, `vitest-browser-svelte` setup, one passing placeholder component test
- [ ] Playwright skeleton: config with two dev-server origins reserved (app + sandbox, §6), one passing placeholder e2e test
- [ ] GitHub Actions workflow with **five separate gates**: `svelte-check`, Biome, `bun test`, Vitest, Playwright (§5)

### 0.4 Internationalisation (§5)

- [ ] Paraglide JS wired with `en` (default) and `da` locales; compile step in dev and build; Paraglide output directory excluded from Biome and prek formatting hooks
- [ ] Convention established and documented in a repo `README` note: **all user-facing text flows through Paraglide messages — no string literals in components** (§5); the scratch validation route from 0.2 converted to messages as the first example

### 0.5 Docker Compose skeleton (§6.2)

- [ ] `docker-compose.yml`: three services — app (adapter-node build under Bun), CPA (pinned image version, **no published host port**, management API disabled/localhost-bound, self-update off, §9), Caddy (plain proxy, no custom builds, §5) — with volumes for SQLite database, file storage, and backups
- [ ] Caddyfile: two hostnames — application origin and sandbox origin (§6.2); sandbox serves static files only (content mounted in Phase 4); TLS via ACME or internal CA
- [ ] `.env.example` enumerating **every** required variable (§6.2): student-code HMAC pepper, educator seed credentials, CPA listener key, both origin URLs, MCP credential names placeholder — with a one-line comment each; boot-time validation that fails with a clear message on any missing variable lands in Phase 1 alongside the server entry

### 0.6 Git hooks — `prek`

- [ ] Install `prek`; commit `prek.toml` at the repo root; document `prek install` in contributor setup
- [ ] Adjust the template below to the actual scaffold: exclude `.svelte-kit/`, `build/`, and the Paraglide output directory from formatting hooks; confirm `bun run check` and `bun test` entries match the real script names (`rev` values verified current as of 2026-08-23)

```toml
# Configuration file for `prek`, a git hook framework written in Rust.
# See https://prek.j178.dev for more information.
#:schema https://www.schemastore.org/prek.json

[[repos]]
repo = "builtin"
hooks = [
  { id = "trailing-whitespace" },
  { id = "end-of-file-fixer" },
  { id = "mixed-line-ending", args = ["--fix=lf"] },
  { id = "check-merge-conflict" },
  { id = "check-case-conflict" },
  { id = "check-added-large-files", args = ["--maxkb=500"] },
  { id = "detect-private-key" },
  { id = "check-json", exclude = '^tsconfig\.json$' },
  { id = "check-toml" },
  { id = "check-yaml" },
  { id = "no-commit-to-branch", args = ["--branch", "main"] },
]

# Conventional Commits
[[repos]]
repo = "https://github.com/compilerla/conventional-pre-commit"
rev = "v4.4.0"
hooks = [
  { id = "conventional-pre-commit", stages = ["commit-msg"] },
]

# Secret / credential leak guard — fixtures and dotfiles must never carry tokens.
[[repos]]
repo = "https://github.com/gitleaks/gitleaks"
rev = "v8.30.1"
hooks = [
  { id = "gitleaks" },
]

[[repos]]
repo = "local"
hooks = [
  { id = "biome", name = "Format and lint with Biome", entry = "bunx biome check --write", language = "system", types_or = ["javascript", "ts", "svelte", "json", "css"] },
  { id = "svelte-check", name = "TypeScript and Svelte type check", entry = "bun run check", language = "system", pass_filenames = false, stages = ["pre-push"] },
  { id = "tests", name = "Run test suite", entry = "bun test", language = "system", pass_filenames = false, stages = ["pre-push"] },
]
```

---

## Phase 1 — Core loop (M1)

**Goal.** The vertical slice from a student's browser to a model and back: repository structure per §6.1, database schema, student authentication with rate limiting, the two-dialect gateway adapter, the agent loop in its zero-tool form, SSE streaming with buffering and resume, and the message tree. Everything later participates in this loop (§10), so it is built first and built properly.

**Exit criterion.** A provisioned student can log in with an access code and hold a streaming chat conversation: deltas render live, a reloaded tab resumes the in-flight turn, aborting works, editing a prompt creates a sibling branch, and `bun test` covers credentials, rate limiting, event normalisation, and loop termination. Verified against a running CPA via Docker Compose.

**Ordering note.** Tasks 1.1–1.2 precede everything; 1.3 (auth) and 1.4 (gateway) are independent of each other; 1.5–1.7 depend on both; 1.8 depends on 1.5–1.7.

### 1.1 Structure and server entry

- [ ] Create the §6.1 skeleton: `src/lib/server/{gateway,agent,auth,db}` now, remaining folders (`mcp`, `skills`, `classroom`, `storage`, `jobs`) as their phases arrive; `src/lib/{components,state,i18n}`; route groups `(student)`, `(educator)`, `api`. Follow the splitting principle (§6.1): one responsibility per file, one domain concern per folder, split on a second reason to change or a second audience of importers — no numeric size limits
- [ ] `hooks.server.ts`: session resolution into `event.locals` (typed in `app.d.ts`) per `.agents/rules/svelte5-sveltekit-app.md` — request state lives on `locals`, never at module scope
- [ ] Boot sequence in the server entry: validate required env vars (fail loudly, §6.2), apply Drizzle migrations before the listener starts (§6), mark any in-flight turns interrupted (§10)

### 1.2 Database (§19)

- [ ] `src/lib/server/db/schema/` — Drizzle schema, one file per aggregate: `classroom` (minimal columns now, settings grow in Phase 2), `student`, `session`, `educator`, `conversation`, `message` (tree: parent reference, content parts, usage), `model-alias`, `usage-event`, `login-attempt`
- [ ] `src/lib/server/db/` — connection module (`bun:sqlite` + Drizzle), migration runner, and query modules per aggregate (e.g. `queries/conversations.ts`) — domain logic never lives in `+server.ts` (§6.1)
- [ ] `bun test`: message-tree invariants (sibling creation, active-leaf tracking), query-module round trips against an in-memory database

### 1.3 Student authentication (§7)

- [ ] `src/lib/server/auth/codes.ts` — 120-bit codes from crypto-secure randomness, Crockford Base32, grouped display format, HMAC-SHA-256 digest with the env pepper, non-secret tail for card identification; plaintext never persisted
- [ ] `src/lib/server/auth/pseudonyms.ts` — word-pair label generation from the localised wordlists shipped in the repo (`en` + `da`, §17), unique within a classroom
- [ ] `src/lib/server/auth/provisioning.ts` — create student records (label + digest + hint); plus a first-boot dev seed (one classroom, one student, code printed once to the operator console) so M1 is verifiable before the Phase 5 provisioning UI exists
- [ ] `src/lib/server/auth/sessions.ts` — student session create/resolve/invalidate; `HttpOnly`, `Secure`, `SameSite=Lax` cookie scoped to the application origin so the sandbox origin can never read it; sliding 14-day expiry default (§7, Appendix A)
- [ ] `src/lib/server/auth/rate-limit.ts` — SQLite-backed, per IP and per credential digest, progressive delay per Appendix A, uniform failure responses in content and timing
- [ ] `src/routes/(student)/login/` — plain progressively-enhanced form action (§5: trivial forms don't use Superforms), Valibot-validated input
- [ ] `bun test`: entropy source, digest uniqueness and lookup, no plaintext persistence, rotation invalidating sessions, rate-limiter thresholds and uniform responses, pseudonym uniqueness (§22)

### 1.4 Gateway adapter (§9)

- [ ] `src/lib/server/gateway/events.ts` — the normalised internal event types: text delta, tool call started, permission request, tool result, usage, error, done (§10); this is the wire format everything above the adapter consumes
- [ ] `src/lib/server/gateway/openai/` and `src/lib/server/gateway/anthropic/` — dialect implementations behind one internal interface; chat completions, models listing, images endpoint (OpenAI dialect); Anthropic-native Messages; each alias selects its dialect
- [ ] `src/lib/server/gateway/client.ts` — CPA HTTP client: listener-key auth, streaming parse, error mapping to a single student-facing unavailability message; upstream URLs, provider identifiers, OAuth errors, and tokens never reach the browser (§9, §21); credentials redacted from logs (§16)
- [ ] Model alias query module: alias table lookup, dialect selection, utility-alias designation; alias records seeded via the dev seed until the Phase 2 management UI
- [ ] `bun test`: dialect event normalisation against recorded fixtures for both dialects, error mapping, usage extraction, estimated-usage fallback (~4 chars/token, flagged as estimated — never zero, §10)

### 1.5 Agent loop, zero-tool case (§10)

- [ ] `src/lib/server/agent/system-prompt.ts` — layered assembly: fixed base prompt → classroom instructions → per-student instructions → skill index (later layers empty until Phases 2–3, but the layering function and its `bun test` coverage exist now, §22)
- [ ] `src/lib/server/agent/loop.ts` — assemble context from the active message path, call the adapter, emit normalised events, terminate on model stop; tool execution slots in during Phase 3
- [ ] `src/lib/server/agent/turn-buffer.ts` — persist every event to the database as it streams, so resume replays from one source of truth (§10)
- [ ] `src/lib/server/agent/concurrency.ts` — one turn in flight per student across all conversations, enforced server-side; a new send requires aborting the running turn (§10)
- [ ] `bun test`: loop termination conditions, buffering order, single-turn enforcement (§22)

### 1.6 Streaming transport (§10)

- [ ] `src/routes/api/` — POST message endpoint returning the SSE stream of normalised events; Valibot-validated input; thin route delegating to `$lib/server/agent` (§6.1)
- [ ] Resume endpoint: replay buffered events then tail the live turn — one code path for live and resumed turns (§10)
- [ ] Abort endpoint: cancels the upstream request and marks the turn; boot-time interrupted-turn marking (1.1) surfaces a friendly cut-short notice on resume
- [ ] Integration tests (`bun test` against a running server): stream, disconnect/resume, abort, both dialects, error propagation (§22)

### 1.7 Conversation persistence (§10)

- [ ] Conversation CRUD in query modules: create, list (owner-scoped), delete; message tree append, edit-as-sibling, regenerate-as-sibling, active-leaf update
- [ ] Title generation: async utility-alias call after the first exchange, fallback to first-message truncation (§10); accounting hook stubs recorded now, enforced in Phase 2
- [ ] `bun test`: owner scoping on every query, sibling semantics

### 1.8 Chat UI (§10, §20)

- [ ] `src/lib/state/` — client rune modules (`.svelte.ts`) for conversation, streaming turn, and composer state, following the container pattern in `.agents/rules/svelte5-sveltekit-app.md` (class or getter/setter object, never bare reassignable exports); SSR-safe state via context, not module singletons
- [ ] `src/lib/components/chat/` — message list, streaming message, composer; markdown via `marked` + mandatory `DOMPurify` sanitisation (§5); Shiki (fine-grained core, JS regex engine, small language set) highlighting only after a fenced block closes — plain preformatted text while streaming (§20)
- [ ] `src/routes/(student)/` — chat route wiring load functions and the SSE client; edit and regenerate actions on the message tree; abort control
- [ ] All text through Paraglide messages (§5); design via the `frontend-design` skill, clean-slate baseline
- [ ] Vitest Browser Mode: composer and streaming-message components (§22); Playwright: login → chat → logout happy path (first cut of the §22 student flow)

---

## Phase 2 — Classroom (M2)

**Goal.** The control plane: educator authentication, the classroom as the unit of configuration, availability with timezone-correct schedules, the classroom-state push channel, model alias management with allowlists, three-layer budgets with allowances and cost estimates, layered instructions, language settings, and session policies — with server-side enforcement on every path that can reach a model (§8). Educator-facing routes built here are functional forms in `(educator)/`; the consolidated panel experience is Phase 5.

**Exit criterion.** Locking a classroom immediately refuses new requests **at the API** while a streaming response finishes; schedules open and close access correctly across a DST boundary in tests; an exhausted allowance refuses new turns with a friendly message; connected tabs see the lock via the push channel; students out of hours see the status screen with the next opening — all covered by the §22 security tests for out-of-hours access and disabled models.

**Ordering note.** 2.1 precedes all educator routes. 2.2 precedes 2.3–2.9. Enforcement (2.4) lands before the management UIs that configure it, so nothing ever ships unenforced.

### 2.1 Educator authentication (§7)

- [ ] `src/lib/server/auth/educator.ts` — account seeded from env at first boot (re-seed + restart is the recovery path, §6.2); `Bun.password` (argon2id) per `.agents/rules/svelte5-sveltekit-app.md`; own session namespace, sliding 7-day expiry
- [ ] `(educator)/` login route and guard: educator role required on every educator endpoint (§21), enforced in the layout server load and re-checked in actions
- [ ] `bun test`: seeding, verify, role separation; security tests: student session cannot reach educator endpoints (§22)

### 2.2 Classroom model and settings (§8, §19)

- [ ] Extend the classroom schema: state, IANA timezone (default `Europe/Copenhagen`), weekly schedule, temporary windows, session policy, retention and creations policy, budgets and caps, tool permission mode, skill authoring policy, attachment policy, classroom instructions, interface language, feature flags — plus the Classroom↔ModelAlias allowlist join table
- [ ] Per-student columns: per-student instructions, interface-language override, status
- [ ] `src/lib/server/classroom/` — settings query modules and a typed settings-resolution module (classroom defaults + per-student overrides, the granularity principle §2)

### 2.3 Availability and schedules (§8)

- [ ] `src/lib/server/classroom/schedule.ts` — resolution of open/locked state from explicit state + weekly schedule + one-off windows, all via `date-fns` + `date-fns-tz` in the classroom timezone; **no hand-rolled offset or DST arithmetic** (§5); computes next-opening for the closed screen
- [ ] Educator controls: Open now (with durations incl. until end of current window), Lock (immediate), schedule and window editing — Superforms 2 + Valibot form actions (§5)
- [ ] `bun test`: schedule resolution including daylight-saving boundaries in both directions (§22)

### 2.4 Server-side enforcement (§8, §21)

- [ ] `src/lib/server/classroom/enforcement.ts` — one guard invoked by every path that can reach a model: chat send, (later) tool execution and image generation, and every API endpoint; checks availability, model allowlist, session validity; a streaming response may finish after a lock, new requests are refused; hiding a UI control is never access control
- [ ] Student closed screen: friendly status with next scheduled opening — never a raw authorisation error (§8)
- [ ] Security tests via direct API access: out-of-hours refusal, disabled model refusal, refusal after lock mid-session (§22)

### 2.5 Classroom-state push channel (§6, §8)

- [ ] `src/routes/api/` classroom-state SSE endpoint pushing open/locked/next-window/allowance to connected tabs; enforcement never depends on it (§6)
- [ ] Client rune module consuming the channel; chat UI reacts to lock immediately
- [ ] Integration test: state change reaches a connected client; enforcement holds when the channel is severed

### 2.6 Model alias management (§9)

- [ ] `(educator)/` alias CRUD: friendly name, gateway identifier, dialect, availability, data-protection flag, image-input and image-generation capability flags, optional per-million-token USD prices (single price applies to both directions), utility designation — Superforms 2 + Valibot
- [ ] Per-classroom allowlist editing with data-protection flags displayed and the explicit **no-DPA confirmation** dialog stating what it means (§16)
- [ ] Request validation against the classroom allowlist in enforcement (2.4); students only ever see friendly names
- [ ] Gateway health and available-model count surfaced for the Phase 5 dashboard (server module now, display later)

### 2.7 Budgets, allowances, accounting (§10)

- [ ] `src/lib/server/agent/budgets.ts` — the three layers: per-turn caps (steps, wall-clock, tokens) enforced inside the loop with graceful stop at a clean boundary and partial content preserved; per-student daily allowance and per-classroom daily cap checked at turn start; per-turn caps bound mid-turn overshoot
- [ ] Usage recording to `usage-event`: input/output tokens separately, gateway-reported vs estimated flag; budget day = calendar day in the classroom timezone (§10); utility-alias calls count toward the classroom cap only, skipped with fallback when the cap is exhausted
- [ ] Panel budget forms with the three presets (Cautious / Standard default / Generous) filling all five Appendix A fields, each field editable after
- [ ] Friendly refusal and mid-turn notices — never presented as errors (§10)
- [ ] `bun test`: budget and allowance resolution, day-boundary reset in classroom timezone, preset values, utility accounting (§22)

### 2.8 Cost estimate display (§10)

- [ ] `src/lib/server/classroom/cost-estimate.ts` — USD + DKK estimates from per-alias prices and the configurable exchange rate (default 7.00 DKK/USD, Appendix A); display-only, enforcement never depends on prices
- [ ] Shown on the student allowance display and educator usage views

### 2.9 Instructions, language, session policy (§7, §8, §10)

- [ ] Classroom and per-student instructions editable in `(educator)/`; wired into the Phase 1 system-prompt layering; `bun test` layering with all layers populated (§22)
- [ ] Interface language: classroom setting + student self-service override, driving Paraglide locale; educator panel follows the educator's own preference (§8)
- [ ] Session policy per classroom: sliding (duration editable) or per-lesson (sessions end at classroom close); force-logout = bulk session invalidation, immediate (§7)
- [ ] Security tests: sessions dead after force-logout and after rotation (§22)

---

## Phase 3 — Tools (M3)

**Goal.** The teaching material (§2): Setun as an MCP client with the `2026-07-28` protocol and legacy adapters, tool execution inside the agent loop under the three permission modes, elicitation, the skills system with educator library and student authoring, image generation through both trigger paths, and student attachments. All of it rides the Phase 1 loop and the Phase 2 enforcement.

**Exit criterion.** With a configured MCP server: a tool round trip completes in each permission mode (strict prompts, standard runs with sensitive-flag prompts, open runs silently); a declined call returns a refusal and the loop continues; an elicitation renders with server attribution and round-trips; an enabled skill changes model behaviour and loads on demand; a student generates an image from chat and from the composer, debited at the fixed token-equivalent; an attachment on a non-capable alias is refused before any gateway call — all with §22 integration and security coverage.

**Ordering note.** 3.1–3.3 (MCP plumbing) precede 3.4–3.6 (loop integration). 3.7 precedes 3.8–3.9. 3.10 and 3.11 are independent of MCP and can interleave.

### 3.1 MCP client (§11)

- [ ] `src/lib/server/mcp/transport.ts` — Streamable HTTP only; the deprecated HTTP+SSE transport is not implemented
- [ ] `src/lib/server/mcp/negotiation.ts` — `server/discover` probe with legacy-handshake fallback; negotiated version stored per server
- [ ] `src/lib/server/mcp/legacy/` — adapters at the transport edge (absent result-type field, legacy session semantics, both error-code ranges) — not a union-of-all-versions abstraction (§11)
- [ ] `src/lib/server/mcp/catalogue.ts` — server-wide tool-catalogue cache honouring freshness and cache-scope hints; filtered per classroom; no per-student connections (§11)
- [ ] `bun test`: version negotiation, legacy normalisation, catalogue cache behaviour (§22)

### 3.2 Server configuration (§11)

- [ ] On-disk, version-controlled MCP configuration file (the third operator file, §6.2): endpoints, credential references by env-var name — never in the database; validated at boot with clear failure
- [ ] Header-injection from tool parameters disabled or strictly allowlisted per server (§11); sampling, roots, and logging not implemented (§11)

### 3.3 Tool enablement (§11, §19)

- [ ] `mcp-server` and `mcp-tool` schema (configuration reference, negotiated version, per-tool enablement, sensitive flag) + Classroom↔McpTool allowlist join
- [ ] `(educator)/` MCP routes: toggle configured servers, select individual tools per classroom, set sensitive flags, show negotiated version and reachability
- [ ] Security tests: disabled tool refused at the API (§22)

### 3.4 Permission modes (§11)

- [ ] `src/lib/server/agent/permissions.ts` — mode application before any tool executes: strict (always ask), standard (sensitive-flagged ask), open (never ask; prominent panel warning on selection); declined calls return a refusal result and the loop continues
- [ ] Permission-request event flows through the existing normalised stream; `src/lib/components/chat/` permission prompt with unmissable server attribution (§11)
- [ ] Vitest Browser Mode: permission prompt approve/decline; integration tests: round trip in each mode (§22)

### 3.5 Elicitation (§11)

- [ ] Interim-result handling in the loop: surface to the student with server attribution, restricted input types only (free text, number, boolean, single choice), retry the original request with responses attached; nothing resembling a credential prompt is ever displayed (§11)
- [ ] Integration test: elicitation round trip (§22)

### 3.6 Tool execution in the loop (§10, §11)

- [ ] `src/lib/server/agent/loop.ts` — execute permitted tool calls, append results, repeat until stop or budget; per-turn step cap from Phase 2 applies; tool results treated as untrusted input — no MCP server holds privileges over application data, no student credential ever passed into a tool call (§11)
- [ ] Abort during tool execution cancels the running execution (§10)
- [ ] `bun test`: loop termination with tools; integration: multi-step tool turns

### 3.7 Skills registry (§12)

- [ ] `skill` schema: origin (panel/upload/import/student), owner, body, resources, enablement, approval state, reserved executable marker (deferred, §12); Classroom↔Skill allowlist with per-student rows
- [ ] `src/lib/server/skills/registry.ts` — resolution of active skills per student; name + one-line description injected into the system prompt (last layer, §10); full body via the **internal load tool** — never a permission prompt in any mode, but consuming a per-turn step (§12)
- [ ] `bun test`: skill index injection, load-tool resolution, enablement resolution per classroom and per student

### 3.8 Educator skill library (§12)

- [ ] `(educator)/` skills routes: panel authoring, file upload, skills.sh server-side browsing and import (best-effort; degrades to manual upload, §12)
- [ ] Imported and uploaded skill text is untrusted: never executed, arrives **disabled**, activates only by explicit educator action (§12, §21); per-classroom and per-student enablement
- [ ] Security test: disabled skill absent from the prompt and refused by the load tool (§22)

### 3.9 Student skill authoring (§12)

- [ ] Student-facing authoring UI; student skills apply only to that student's conversations
- [ ] Authoring policy per classroom: immediate-with-oversight (default; panel lists every student skill with view/disable/delete), pre-approval (new and edited versions inactive until approved — approval queue in `(educator)/`), or disabled entirely
- [ ] Vitest Browser Mode: authoring form; security tests: cross-student skill isolation

### 3.10 Image generation (§15)

- [ ] `src/lib/server/storage/` — local file storage for generated images, served only by Setun to their owner; no external image URL ever reaches the browser
- [ ] Single server-side execution path through the gateway adapter, refused on non-flagged aliases before any gateway call; two triggers converge on it: the internal generate-image tool (exposed to the loop when the classroom allowlists a generation-capable alias, subject to the permission mode) and the composer's explicit image mode
- [ ] Accounting: fixed token-equivalent per image (default 10k, panel-editable, Appendix A) debited against the student allowance and classroom cap
- [ ] Integration tests: both trigger paths, refusal on unflagged alias, debit recorded

### 3.11 Attachments (§10)

- [ ] `src/lib/server/storage/attachments.ts` — server-side validation: content sniffing against the educator's type allowlist, size caps (Appendix A: images ≤ 5 MB, text ≤ 256 KB, ≤ 5 per message); stored outside any web root, served only to the owner with restrictive content-type headers, never to or from the sandbox origin (§21); deleted with their conversation
- [ ] Policy per the granularity principle: classroom toggle, per-student overrides, allowed-type list (§10); image attachments only on image-input-flagged aliases — friendly refusal before any gateway call; text/code files inlined as text
- [ ] Composer attachment UI
- [ ] `bun test`: validation matrix; security tests: cross-student attachment access, type and size enforcement (§22)

---

## Phase 4 — Build (M4)

**Goal.** The artifact workspace: fence-based detection, the separate-origin sandbox with its restrictive policy, Tier 0 static rendering, CodeMirror editing with versioning and diff, Tier 1 compilation through `esbuild-wasm` against pinned self-hosted runtimes, and the escape test suite. Generated code is treated as hostile throughout (§14).

**Exit criterion.** A student asks for an interactive HTML page and it renders in the sandboxed iframe; they edit it in CodeMirror, see a diff of what the model changed, and their edit travels back to the model on the next message; a `tsx` artifact compiles and runs on the self-hosted React runtime; and the full Playwright escape suite (parent DOM, cookies, storage, authenticated APIs, external fetch, frame escape, navigation, popups) is green (§14, §22).

**Ordering note.** 4.1 (sandbox origin) precedes all rendering. 4.2–4.4 (detection, Tier 0, editing) precede 4.5 (Tier 1). 4.6 rides on 4.1. Cross-phase: extends the Phase 0 Compose/Caddy skeleton; the creations gallery (4.7) joins the Phase 3 generated images.

### 4.1 Sandbox origin (§6, §14)

- [ ] `sandbox/` — runner page, compiler worker, pinned runtimes; own build step producing static files; mounted into the Caddy container (the app never serves the sandbox hostname, §6); Vite serves it on a second localhost port in dev
- [ ] Iframe sandboxed to allow scripts but **not** same-origin; strict CSP denying outbound network by default (§14); communication with the host page via explicit message passing only
- [ ] Self-hosted `@unocss/runtime` served from the sandbox origin (§13) — no CDN contact in normal operation

### 4.2 Artifact detection and versioning (§13, §19)

- [ ] Renderer detection from fenced blocks: `html`/`svg` → Tier 0, `jsx`/`tsx`/`svelte` → Tier 1; everything else (including bare `js`/`ts`/`css`) stays a highlighted code block
- [ ] `artifact` + `artifact-version` schema (nullable conversation/message refs so creations outlive expired conversations, §19); continuity heuristic: same language as the conversation's most recent artifact → new version, different language → new artifact; every version retained (§13)
- [ ] `bun test`: detection matrix, continuity heuristic

### 4.3 Tier 0 rendering (§13)

- [ ] `src/lib/components/artifacts/` — artifact panel: sandboxed iframe host, message-passing bridge, tabbed/overlaid default with split-view by choice and fullscreen as primary preview mode (§20); prominent **Build** entry point (§13)
- [ ] Vitest Browser Mode: artifact panel interaction logic (§22)

### 4.4 Editing, versioning, diff (§13)

- [ ] CodeMirror 6 editor; edits create versions locally with no model request; undo and diff view from the version history
- [ ] Edited-since-model-emitted tracking: the next message in the conversation carries the current source, clearly marked as the student's edited version (§13)
- [ ] Integration test: edit → version → edit flows back on next message

### 4.5 Tier 1 compilation (§13, §20)

- [ ] `sandbox/` compiler worker: `esbuild-wasm` fetched lazily on first non-static artifact, cached thereafter; compilation on explicit **Run** or heavily debounced idle — never per keystroke (§13); the worker competes with the UI on two cores, so lazy and explicit (§20)
- [ ] Pinned self-hosted ESM runtimes: React and Svelte only (§13)
- [ ] Playwright: `tsx` and `svelte` artifacts compile and render

### 4.6 Creations gallery (§13, §16)

- [ ] `src/routes/(student)/` creations route: artifacts and generated images; student delete (§16)
- [ ] Playwright: gallery shows a created artifact and image

### 4.7 Escape test suite (§14, §22)

- [ ] Playwright suite asserting each attempt **fails**: parent DOM access, cookie and storage access, authenticated API calls, external fetches, frame escape, navigation, popup abuse — runs in CI as part of the Playwright gate

---

## Phase 5 — Console and hardening (M5)

**Goal.** Make the pilot operable and pleasant: the consolidated educator panel (§17), the student dashboard (§18), conversation search, provisioning with credential cards, the job scheduler with retention and backups, log hygiene, the Chromebook performance pass, Danish completion, the full Playwright suite, and operator documentation. Earlier phases built functional educator routes; this phase shapes them into the dense single-operator tool the PRD describes.

**Exit criterion.** The §25 definition-of-done walkthrough passes end to end: an educator opens the panel, provisions students, prints credential cards, opens the classroom; students log in on Chromebook-class hardware (verified under sixfold CPU throttling against the §20 budgets), chat, build an artifact; the educator locks and requests stop at the API; a backup has been restored successfully at least once; the Danish locale is complete; all §22 suites and all five CI gates are green.

### 5.1 Educator panel (§17)

- [ ] `(educator)/` dashboard: classroom state, active students, gateway health (from 2.6), current window, usage against budgets, one-click lock — design via `frontend-design`, dense single-operator layout
- [ ] Roster: per-student status, usage and allowance with cost estimate, last activity, per-student instructions and attachment overrides, disable/enable/rotate/clear-display-name/remove/delete — with the classroom-deletion distinctions (disable vs remove vs permanent, §16)
- [ ] Provisioning: batch account creation using the Phase 1 pseudonym and code modules; printable credential cards (code shown at provisioning and rotation only, §7); the dev seed from 1.3 retired
- [ ] Consolidation pass over the Phase 2–3 routes (classroom config, aliases, MCP, skills) into the §17 information architecture
- [ ] Vitest Browser Mode: panel forms (§22); Playwright: educator flow — create classroom, provision, open, lock, rotate (§22)

### 5.2 Student dashboard (§18)

- [ ] `src/routes/(student)/` dashboard: account status, open/closed with next window, allowance used with cost estimate, language override, display name (set/change/clear), conversation list with search, creations gallery link, own skills — everything the system knows about the student, visible to the student (§18)

### 5.3 Conversation search (§10)

- [ ] FTS5 index over titles and message content, `unicode61` tokenizer with `remove_diacritics 2` (Appendix A); index maintenance in the message query module
- [ ] Search endpoint and UI, strictly scoped to the requesting student
- [ ] Security tests: cross-student search isolation (§22)

### 5.4 Jobs: scheduler, retention, backups (§6, §16, §21)

- [ ] `src/lib/server/jobs/scheduler.ts` — in-process scheduler started with the server, portable across Node and Bun (§6 — dev runs under Node, so not `Bun.cron`)
- [ ] Retention job: conversation expiry per classroom policy (default 30 days) deleting messages and attachments; creations governed separately — kept until deleted unless a creations retention period is set (§16)
- [ ] Session cleanup job
- [ ] Backup job: nightly `VACUUM INTO` snapshot plus images and skills directories, 14 days retained on the backup volume (§21, Appendix A); **restore rehearsal performed and documented** — the pilot does not ship without it (§21)
- [ ] `bun test`: retention resolution, backup file naming/rotation

### 5.5 Log hygiene (§16, §21)

- [ ] Review pass: normal-level logs carry internal identifiers, request ids, aliases, latency, status, token counts — no prompt or response content; credentials redacted everywhere including gateway headers and error paths; production errors expose no stack traces or infrastructure detail
- [ ] `bun test`: redaction on representative error paths

### 5.6 Chromebook performance pass (§20)

- [ ] Verify under sixfold CPU throttling: < 250 KB gzipped JS on the chat route, first meaningful paint < 2 s cold, no dropped frames streaming plain text
- [ ] Memory and layout items: content-visibility on off-screen messages, windowed long conversations, drafts and scroll surviving tab discard (resume already server-side), no backdrop blur, no persistent header, overlay sidebar, on-screen-keyboard handling, touch-sized targets and draggable handles
- [ ] Scoped markdown re-rendering (current block only) confirmed from Phase 1; fix regressions found

### 5.7 Danish locale completion (§5, §8)

- [ ] Every Paraglide message translated; `da` wordlist reviewed; a sweep confirming no string literals in components escaped the convention

### 5.8 Full test suite and CI (§22)

- [ ] Playwright: all three §22 flows complete, asserted at the API level not only the UI (student chat+build flow, educator flow, scheduling flow)
- [ ] Security suite complete per §22: auth failures and brute force, revoked/disabled credentials, sessions after rotation and force-logout, out-of-hours access, cross-student access including search and attachments, disabled models/tools/skills, artifact escape suite
- [ ] All five CI gates green on `main`

### 5.9 Operator documentation (§6.2)

- [ ] `docs/` operator guide: the three operator files (Compose, `.env`, MCP config), the two DNS hostnames and TLS modes, CPA provider enrolment on the host, educator password recovery via re-seed, backup restore procedure, upgrade note on the pinned CPA version

---

## Phase delivery flow

**One phase = one branch = one PR**, regardless of phase size. A phase's PR merges into `main` only when the phase's exit criterion holds. Follow these steps throughout the work on every phase:

1. **Prepare the branch before making changes.**
   - If on `main`, create a new branch before starting. If on a non-main branch, rename it if needed.
   - Use the appropriate prefix: `feat/`, `fix/`, or `refactor/` (e.g. `feat/phase-0-bootstrap`, `feat/phase-1-core-loop`).
   - Use a concise, descriptive branch name.
   - Keep all related work in one branch and one PR.

2. **Commit changes at logical points.**
   - Create commits throughout the work when a meaningful unit is complete, or group them afterward when that produces a cleaner history.
   - Use judgment to avoid both overly large commits and unnecessary commit fragmentation — a task or a coherent group of subtasks is a natural commit boundary.
   - Always follow the Conventional Commits standard; keep commits logical, focused, and clearly categorized.
   - Push the branch as needed and ensure all final commits are pushed.

3. **Open the PR only after the phase is fully complete.**
   - Confirm the phase's exit criterion holds and the final state has been reviewed or validated. Do not open a draft or partial PR unless explicitly requested.
   - Create the PR with `gh`, with a Conventional Commit-style PR title.
   - Write a detailed, professional description covering the changes, rationale, and validation performed. No emojis.
   - Use `rtk proxy` when needed to prevent `rtk` from interfering with the PR description.

## Working agreement

- **Read the rules first.** Every implementation session reads `.agents/rules/svelte5-sveltekit-app.md` (and any rules files added later under `.agents/rules/`) at session start, before writing code.
- **This file is the single source of progress truth.** Tick checkboxes in this document as work lands, on the phase branch alongside the work itself. A box is ticked only when its named tests pass.
- **PRD wins.** `docs/setun-prd.md` v0.6 is final. Do not reopen decisions, add features, or change scope. A genuine contradiction between PRD and this plan is resolved in the PRD's favour and this plan is corrected.
- **Conventional Commits**, enforced by the `conventional-pre-commit` hook on commit-msg.
- **Branch workflow.** From Phase 0 onward, all work happens on the phase branches of the delivery flow above, merged into `main` via the phase PR — the `no-commit-to-branch` prek hook blocks direct commits to `main`. (History to date was committed directly to `main`; the hook changes that.)
- **Verification.** `prek run --all-files` and the relevant test layer pass before any merge; CI's five gates pass on every PR.
