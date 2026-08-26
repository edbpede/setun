# Setun — Product Requirements Document

**Version:** 0.7
**Status:** Ready for implementation planning — all open decisions resolved, defaults pinned
**Licence:** AGPL-3.0
**Target:** Classroom pilot, 5–20 students and one educator

---

## 1. Summary

Setun is a self-hosted, privacy-first learning environment for teaching AI and *Teknologiforståelse*. Students get pseudonymous access to modern AI models, a code artifact workspace, and a curated set of tools — without accounts, email addresses, names, or third-party identity providers.

Setun is a new application, written from scratch. Its only external dependency of consequence is CLIProxyAPI (CPA), an unmodified upstream service used as the model gateway and integrated over its HTTP interface alone.

The pilot's measure of success is mundane: an educator opens the classroom, students enter a code, and everything works well enough to be used every week.

*The name comes from the ternary computer built at Moscow State University in 1958 — small, inexpensive, built for universities and research institutes, and running on a number system unlike everything else in the room.*

---

## 2. Goals

1. Students use capable AI models without surrendering personal information.
2. The educator controls access, availability, models, tools, and budgets — from a UI, without touching a database or a terminal. **Granularity principle:** wherever a capability is toggled, it is configured per classroom with per-student overrides where meaningful (skills, attachments, system-prompt instructions all follow this pattern).
3. Students can build, run, inspect, and break code artifacts safely.
4. The application is genuinely pleasant on the classroom's actual hardware.
5. Tool use (MCP) and reusable instructions (skills) are first-class, because they are the interesting teaching material.
6. The architecture stays small enough that one person can maintain it.

## 3. Non-goals

Not an LMS, gradebook, or timetable system. No school-wide identity integration, multi-tenancy, or billing. No conversation-surveillance interface for educators. No agent marketplace, no plugin ecosystem, no RAG or document-management product. No provider-specific logic anywhere above the gateway adapter. No content-moderation layer of Setun's own — provider-side safety is the deliberate stance, recorded in §16.

---

## 4. Users

**Student.** Logs in with an access code. Chats with permitted models, uses permitted tools and skills, builds and edits artifacts, generates images, manages their own conversations and creations, searches their own conversations, optionally sets a display name. Cannot see other students' data, alter classroom settings, reach the gateway directly, or use anything the educator has not enabled.

**Educator.** Conventional authenticated account, established at first run — from deployment configuration when it supplies one, and otherwise through the first-run setup wizard of §6.2. Creates classrooms, provisions and manages student credentials, opens and locks access, sets schedules, curates the model alias table and per-classroom allowlists, registers MCP servers and selects individual tools, sets tool permission modes, maintains the skill library (including uploads and registry imports), sets budgets and allowances, and views operational and aggregate usage data — never conversation contents.

---

## 5. Technology

**Runtime:** Bun (production server runs `bun ./build/index.js`)
**Framework:** SvelteKit 2 with Svelte 5 (runes), `@sveltejs/adapter-node` executed under the Bun runtime — the officially maintained adapter; nothing in Setun requires a `Bun.serve` entry point
**Styling:** UnoCSS with `presetWind4` plus `unocss-preset-shadcn`, and `shadcn-svelte` copy-in components on bits-ui
**Design baseline:** the tweakcn **clean-slate** theme, ported into the `preset-shadcn` CSS-variable theme (the theme is CSS variables; the React-oriented `shadcn` CLI is not used)
**Internationalisation:** Paraglide JS — compile-time, typed messages; English is the default locale, Danish ships complete at pilot; all user-facing text flows through messages, never string literals in components
**Editor:** CodeMirror 6
**Markdown rendering:** `marked`, output sanitised with `DOMPurify` — model output is untrusted HTML source; sanitisation is mandatory, not optional
**Forms and validation:** Valibot is the single schema library — every form action and every API endpoint validates its input through a Valibot schema, no exceptions. Superforms 2 (Valibot adapter) powers the educator panel's forms; trivial forms such as login use plain progressively-enhanced form actions
**Database:** SQLite via `bun:sqlite`, schema and queries through Drizzle ORM, full-text search via FTS5
**Gateway:** CLIProxyAPI, pinned version, unmodified
**Artifact compilation:** `esbuild-wasm`, lazily loaded, executed inside the sandbox origin
**Sandbox styling:** self-hosted `@unocss/runtime`
**Syntax highlighting:** Shiki, fine-grained core, JS regex engine, small language set
**Date and time:** `date-fns` with `date-fns-tz` for all schedule resolution in classroom timezones — no hand-rolled offset or DST arithmetic anywhere
**Reverse proxy:** Caddy, kept a plain proxy — no custom builds or plugins
**Lint / format / type-check:** Biome for lint and format; `svelte-check` as the authority on template and type correctness, run in CI
**CI:** GitHub Actions — `svelte-check`, Biome, `bun test`, Vitest, and Playwright as separate gates
**Testing:** `bun test` for pure server logic and rune modules, Vitest Browser Mode with `vitest-browser-svelte` for component rendering, Playwright for end-to-end
**Containerisation:** Docker Compose — three services: application, CPA, Caddy

Deliberate omissions: no document database, no search server, no vector database, no separate API service, no heavyweight in-browser IDE, no WebSockets, no CDN dependencies of any kind.

A single SvelteKit application serves the student UI, the educator panel, and all server logic. There is no `frontend/` / `backend/` split — SvelteKit is full-stack and enforces the client/server boundary at compile time (`src/lib/server/` cannot be imported by client code). SvelteKit remote functions are experimental and are not used; data flows through load functions, form actions, and `+server.ts` endpoints.

The `.agents/rules/` stack guidelines are authoritative for all implementation idiom: runes not stores, snippets not slots, `$app/state` not `$app/stores`, `Bun.password` for the educator credential, hand-configured `components.json` (never `shadcn-svelte init` under UnoCSS), and the documented `presetWind4` theme-key corrections.

**Stack validation on day one:** `unocss-preset-shadcn` 1.0.x targets `presetWind4` and the pairing is known-good, but carries documented gotchas (radius and font theme keys, content pipeline for `.ts` variant files, cursor preflight). Wire up one non-trivial shadcn-svelte component with the clean-slate variables before building on the combination.

**Design process:** all UI and UX design work during implementation uses the `frontend-design` skill. The clean-slate theme is the baseline vocabulary — spacing, radii, colour tokens, typography — and deviations from it are deliberate, not accidental.

---

## 6. Architecture

The browser talks only to Setun. Setun talks to CPA over a private Docker network; CPA talks to providers. The database is a single SQLite file on a mounted volume.

Artifacts execute in an iframe served from a **separate origin** — a distinct hostname, and the only other thing Caddy exposes. CPA has no published host port and is unreachable from outside the internal network.

MCP servers are contacted server-side only. The browser never speaks MCP, never sees a provider credential, and never sees an MCP server credential.

Streaming uses server-sent events end to end: sending a message is a POST returning an SSE stream of normalised events, and a second lightweight SSE channel pushes classroom state (open, locked, next window, allowance) to connected tabs so a lock is visible immediately. There are no WebSockets; enforcement never depends on the push channel — every request is checked server-side regardless.

A small in-process job scheduler (started with the server, portable across Node and Bun) runs retention enforcement, nightly backups, and session cleanup.

The sandbox origin is prebuilt static files served directly by Caddy — the application never serves the sandbox hostname. Those files are built from `sandbox/` by the repository's own build step and mounted into the Caddy container; in development, Vite serves the sandbox on a second localhost port so both origins exist locally. Drizzle migrations are applied at server boot, before the listener starts; there is no separate migration step for the operator.

### 6.1 Repository structure

Modularity comes from single-purpose modules, grouped by domain, behind the compiler-enforced server boundary:

```
src/
  lib/
    server/
      gateway/        # CPA adapter: dialect implementations (openai/, anthropic/), normalised events
      agent/          # agent loop, turn buffering, budgets, permission gating
      mcp/            # MCP client, version negotiation, transport, catalogue cache
      skills/         # registry, student authoring, uploads, skills.sh import
      classroom/      # availability, schedule resolution, enforcement, allowlists
      auth/           # student codes, educator auth, sessions, rate limiting
      db/             # Drizzle schema, migrations, query modules per aggregate
      storage/        # local file storage: generated images, attachments
      jobs/           # scheduler, retention, backup
    components/       # ui/ (shadcn-svelte copies), plus app components by area
    state/            # client rune modules (.svelte.ts)
    i18n/             # Paraglide setup and messages
  routes/
    (student)/        # login, chat, dashboard, creations
    (educator)/       # panel
    api/              # streaming, resume, classroom-state SSE
  hooks.server.ts
sandbox/              # separate-origin artifact host: runner page, compiler worker, runtimes
```

**Splitting principle.** A file holds one responsibility; a module (folder) holds one domain concern with a small explicit public surface, importable without pulling in siblings. Split when a file accumulates a second reason to change or a second audience of importers — never because of line count alone, and no numeric size limits. Route files stay thin: parse, authorise, delegate to `$lib/server` modules, shape the response. Domain logic never lives in `+server.ts` or `+page.server.ts`.

### 6.2 Deployment requirements

Two DNS hostnames are required — the application origin and the sandbox origin — both terminating TLS at Caddy: automatic HTTPS via ACME where the host is publicly reachable, Caddy's internal CA on closed networks. The operator surface is exactly three files: the Compose file, one `.env`, and the MCP server configuration file (§11), plus mounted volumes for the SQLite database, file storage, and backups.

Required environment variables, enumerated so nothing is discovered late: the student-code HMAC pepper; the CPA listener key shared between Setun and CPA; the two origin URLs; and any credentials the MCP configuration references by name. Absence of a required variable fails boot with a clear message rather than starting degraded.

**The educator seed credentials are optional, and are a pair** — set both, or neither. Set, they are applied at every boot, and re-seeding them and restarting is the password-recovery path of §7. Unset, the installation is completed through the first-run setup below. Half a pair fails boot, because it would silently select the wizard where an operator expected a seeded account.

**First-run setup.** An installation with no operator account is unusable until one exists, and before one exists there is no credential to authenticate the person creating it. So the first boot of such an installation mints a **bootstrap token** — at least 120 bits from a cryptographically secure source, in the same Crockford Base32 format as an access code, held in memory only and valid for fifteen minutes — and prints it once to the operator console with the URL to open. Reading it proves access to the host, which is the only property that distinguishes the operator from a passer-by at that moment. This is a deliberate, argued exception to the rule that credentials are never logged (§21): the token lives fifteen minutes, authorises exactly one irreversible action, is worthless the moment setup completes, and the console is the only channel that can carry it. An optional second sink writes it to a file for an operator running detached; it is never the only sink, and it is deleted at completion.

Until setup completes, every path other than the setup surface redirects to it. The wizard establishes the operator account, checks that the gateway answers, creates the first model alias — which is also the utility alias of §9 — creates the first classroom with that alias allowlisted, and optionally provisions a first batch of pupils. Completion is the single flag the gate reads: the account existing is not enough, because a panel with no model and no classroom cannot serve a lesson. Once complete, the setup surface returns `404` and the token is discarded.

The wizard is claimed by exactly one browser at a time, recorded durably so a restart mid-setup does not lose it. A second browser is refused while a claim is live and told when it lapses. Once an operator account exists, the educator credential re-takes a lost claim without a restart.

Installations that predate first-run setup are complete by definition, and are recorded as such at boot: an installation whose wizard has never been claimed and which already has an operator account — or seed credentials configured — is marked complete, once, with one log line. **In production a database file that does not exist fails boot** rather than being created, because with a setup gate in front an absent file is a dropped volume mount, and an empty database would present a configured installation as a cold start.

**Single container is the deployment.** The bootstrap token is per process, so an installation scaled to several replicas must pin setup traffic to one of them.

---

## 7. Identity and authentication

**Students authenticate with a single high-entropy access code.** No username, no password, no email address — not even a synthetic one. The student record has no email field.

The code carries at least 120 bits of entropy, generated from a cryptographically secure source, encoded in Crockford Base32, and grouped for readability, because students type these on small keyboards. The visual format is presentation, not a security boundary, and may change.

The server stores a keyed digest of the code — HMAC-SHA-256 with a pepper held outside the database — uniquely indexed for direct lookup. The plaintext code is never persisted. It is displayed exactly twice: once at provisioning and once at rotation, on a printable credential card. After that screen it can only be replaced, never recovered. A short non-secret tail may be retained purely to identify a card during support.

Successful login establishes a normal session with an `HttpOnly`, `Secure`, `SameSite=Lax` cookie, scoped so the sandbox origin can never read it. Students do not re-enter the code per request.

**Session lifetime is a per-classroom policy** with two modes: **sliding expiry**, defaulting to 14 days from last activity (a weekly-used device stays logged in all term; an abandoned one expires), and **per-lesson**, where sessions end when the classroom closes and students re-authenticate each lesson. The educator selects the mode and duration in the panel and can force-logout an entire classroom with one action (bulk session invalidation).

Login is rate limited **in-application, SQLite-backed** — per IP and per credential digest, with progressive delay (thresholds in Appendix A) and uniform failure responses that never disclose whether a code exists. Caddy performs no rate limiting. Rotation and disabling both invalidate existing sessions immediately.

Educator authentication is separate and conventional: a **single** account, password hashed with `Bun.password` (argon2id), with its own session namespace and a **sliding 7-day expiry**. The account is established at first run — seeded from deployment configuration when it supplies credentials, and otherwise collected by the first-run setup wizard of §6.2 behind the bootstrap token. The minimum password length is twelve characters; there are no composition rules, because length is the only requirement that meaningfully changes the work an attacker must do against an argon2id hash behind a rate limiter.

There is **no in-application password recovery**, and the wizard does not add one: a forgotten educator password is reset by seeding the credential in deployment configuration and restarting, which applies on every boot precisely so that it works. The wizard's own credential form is reachable only while setup is incomplete, and the setup surface returns `404` afterwards. Setup's claim recovery is not a password reset — it asks for the password rather than replacing it. OIDC may be added later without affecting student auth.

---

## 8. Classrooms and availability

A classroom is the unit of configuration: membership, model allowlist, tool allowlist and permission mode, enabled skills and skill-authoring policy, attachment policy, classroom instructions (§10), budgets and allowances, session policy, retention and creations policy, interface language, feature toggles, and schedule.

**Interface language** is a classroom setting (Danish for the pilot; English available), and each student may override it for themselves on the dashboard. The educator panel follows the educator's own preference.

Every classroom has an explicit **open** or **locked** state that overrides all scheduling. On top of that sits a recurring weekly schedule expressed in the classroom's IANA timezone (default `Europe/Copenhagen`), correct across daylight-saving transitions, plus one-off windows for homework or a substituted lesson.

The educator has two prominent controls: **Open now**, with duration options including until the end of the current scheduled window, and **Lock classroom**, which takes effect immediately. A response already streaming when the lock lands may finish; every new request is refused. Connected tabs learn of the change over the classroom-state channel at once; enforcement never depends on their having heard.

Enforcement is server-side and applies to every path that can reach a model — chat, tool execution, image generation, and any API endpoint. Hiding a control in the UI is never treated as access control.

When access is unavailable, students see a plain, friendly status screen with the next scheduled opening — never a raw authorisation error, never any infrastructure detail.

---

## 9. Model gateway

CPA is treated as an internal, replaceable gateway, spoken to through a single adapter module. The adapter supports **two dialects behind one internal interface**: OpenAI-compatible (`/v1/chat/completions`, `/v1/models`, `/v1/images` — the default) and Anthropic-native Messages. Each model alias selects its dialect; nothing above the adapter knows which was used, because the adapter emits only the normalised event stream of §10. Image generation runs through the same adapter.

Setun maintains its own **model alias table** — friendly names such as Fast, Balanced, Powerful, mapped to concrete CPA model identifiers. Aliases are **managed in the educator panel**: name, gateway model identifier, dialect, availability, a **data-protection flag** recording whether the backing access carries a data processing agreement (API-key) or not (subscription OAuth), a **capability flag for image input** (gating attachments, §10), a **capability flag for image generation** (gating §15 — generation is offered and accepted only on flagged aliases), and **optional per-million-token prices in USD, input and output separately** feeding the display-only cost estimate (§10); when only one of the two prices is filled it applies to both directions. Students only ever see the friendly name. Classrooms allow a subset of aliases and the backend validates every request against that subset. One alias is designated the **utility alias**, used for internal work such as title generation.

CPA runs with listener authentication enabled and its management API disabled or bound to localhost, since that API can rewrite provider configuration. Its self-updating admin panel is turned off and the image version pinned.

**Source.** CPA is `https://github.com/router-for-me/CLIProxyAPI`, published as the `eceasy/cli-proxy-api` image. A local checkout is kept alongside this repository at `../CLIProxyAPI`; its `config.example.yaml` and `internal/config/config_types.go` are the authoritative reference for gateway configuration options, and are read there rather than guessed at. Setun uses it unmodified.

Gateway failures produce a single student-facing message about temporary unavailability. Upstream URLs, provider identifiers, OAuth errors, tokens, and stack traces never reach the browser. Gateway health and available-model counts appear in the educator panel.

No classroom, student, or credential data is ever stored in CPA. If CPA is replaced, only the adapter changes. Provider accounts themselves — API keys and subscription OAuth logins — are configured in CPA's own configuration and login flows by the operator on the host; Setun neither stores nor manages provider enrolment.

**Operational note.** Where CPA is backed by subscription OAuth accounts rather than API keys, concurrency is the binding constraint: twenty students in one lesson window will hit provider rate limits. The alias table should therefore include at least one alias backed by a conventional API key, so a lesson degrades rather than fails. The data-protection dimension of this choice is governed by §16.

---

## 10. Chat and the agent loop

Because MCP and skills are in scope, the core is not a stream proxy but an **agent loop**: assemble context, call the model, stream deltas to the client, execute any requested tools (subject to the permission mode of §11), append results, repeat until the model stops or a budget is exhausted. Plain chat is the zero-tool case. This is built first; everything else participates in it.

**The system prompt is layered:** Setun's fixed base prompt, then optional **classroom instructions**, then optional **per-student instructions** — both educator-authored in the panel, both inherited invisibly by the student's conversations. This is the educator's steering instrument ("answer in Danish", "always explain before showing code", extra scaffolding for one student). Students never author system prompts; student-driven behaviour change flows through skills (§12). The skill index (§12) is appended last.

**Attachments.** Students may attach **images** (forwarded to the model, only on aliases carrying the image-input capability flag) and **plain text or code files** (inlined into the message as text). Attachment policy follows the granularity principle: a per-classroom toggle with per-student overrides, an educator-controlled allowed-type list, and size caps (defaults in Appendix A). Uploads are validated server-side — content sniffing against the allowlist, size limits — stored locally alongside generated images, served only by Setun to their owner, and deleted with their conversation. Attaching an image on a non-capable alias is refused with a friendly message before any gateway call. PDFs and office documents are out of scope for the pilot.

**Budgets are three layers**, all denominated in **tokens** — the unit the gateway actually reports — and all panel-configurable per classroom. The panel offers three **budget presets** — Cautious, Standard *(the default)*, and Generous — which fill every budget field with the Appendix A values; a preset is a starting point, and every field remains individually editable afterwards:

1. **Per-turn caps** — maximum tool-call steps, wall-clock time, and tokens per turn. These stop a runaway loop.
2. **Per-student daily allowance** — a token allowance per student per day, so one student cannot drain the class. Students see their own allowance and consumption on the dashboard.
3. **Per-classroom daily cap** — the cost ceiling for the whole class.

Budgets are checked when a turn starts; a turn already streaming completes within its per-turn caps even if an allowance empties mid-turn — the per-turn layer bounds the overshoot. Hitting a per-turn cap mid-turn ends the turn gracefully: the loop stops at the next clean boundary, partial content is preserved, and the student sees a friendly notice — never an error. Exhausting an allowance or cap refuses new turns with a friendly, non-technical message; it is never presented as an error.

**A day, for budget purposes, is the calendar day in the classroom's timezone** — allowances and caps reset at local midnight. Token accounting relies on gateway-reported usage; when a response carries none, Setun estimates it (roughly four characters per token) and records the figure as estimated — usage is never counted as zero.

**Internal utility-alias calls** (today, title generation) count toward the per-classroom daily cap but never toward a student's personal allowance; when the classroom cap is exhausted, utility work is skipped and its fallback used.

Alongside the enforced token figures, the panel and student dashboard show an **approximate cost (USD and DKK)** computed from the optional per-alias prices and a configurable exchange rate. Estimates are display only — enforcement never depends on a price being present or current.

**One turn is in flight per student**, across all of their conversations. Sending a new message while a turn streams requires aborting it; the server enforces this, not just the composer.

Messages are stored as a **tree**, not a list. Editing a prompt or regenerating a response creates a sibling; each conversation tracks its active leaf. This costs little now and avoids a migration later.

The loop emits a **normalised internal event stream** — text delta, tool call started, permission request, tool result, usage, error, done — rather than forwarding provider events verbatim. Providers change; the internal wire format should not.

**Transport is SSE.** Sending a message is a POST whose response streams the normalised events. The server buffers every event to the database as it streams, so aborting a turn cancels the in-flight upstream request and any running tool execution, and a reloaded or discarded tab calls a resume endpoint that replays the buffered events and tails the live turn — one code path for live and resumed turns. A server restart marks any in-flight turn as interrupted at boot; resume then replays what was buffered, with a friendly notice that the response was cut short.

Students can **search their own conversations** — titles and message content — via FTS5, strictly scoped to the requesting student. Conversation titles are generated asynchronously by the utility alias after the first exchange, falling back to a truncation of the first user message.

---

## 11. MCP

Setun is an MCP **client**. Students never configure servers; servers are **defined in a version-controlled configuration file on disk** — an endpoint is a security decision and belongs in reviewable config — with credentials referenced by environment-variable name, never stored in the database. The educator panel registers nothing free-form; it toggles configured servers and selects which individual tools are exposed per classroom. Students see only that certain capabilities are available.

**Protocol support.** The internal model targets the `2026-07-28` revision, with older revisions handled by adapters at the transport edge rather than by a union-of-all-versions abstraction. On registration the client probes `server/discover` for version and capability negotiation and falls back to the legacy handshake if that is unsupported; the negotiated version is stored per server and displayed in the educator panel. Compatibility handling covers the absent result-type field on older results, legacy session semantics, and both the old and renumbered error-code ranges.

**Transport.** Streamable HTTP only. The deprecated HTTP+SSE transport is not implemented. Stdio servers, if ever needed, run as separate pinned containers on the internal network and are addressed over HTTP — educator-supplied stdio configuration would amount to remote code execution on the host and is not supported.

**Statelessness is exploited deliberately.** Because list results no longer vary per connection, tool catalogues are fetched once, cached server-wide honouring the advertised freshness and cache-scope hints, and filtered per classroom. There is no live MCP connection per student and no per-session state to lose on restart.

**Tool permission modes.** Each classroom runs in one of three modes, applied by the agent loop before any tool executes:

- **Strict** — every tool call pauses as a permission request the student approves or declines.
- **Standard** *(default)* — enabled tools run automatically, except tools the educator has flagged as **sensitive** at enablement time, which ask.
- **Open** — everything runs without confirmation; selecting it shows a prominent warning in the panel.

A declined tool call returns a refusal result to the model and the loop continues. Permission requests are rendered with the same unmissable server attribution as elicitation.

**Multi-round-trip requests** fold into the agent loop: an interim result requesting input is **surfaced to the student by default** — rendered with server attribution and a restricted set of input types (free text, number, boolean, single-choice selection — the flat elicitation primitives; nothing richer) — and the original request is retried with the responses attached. Per-server automatic answers from classroom policy are a later refinement, not a pilot feature.

**Security posture.** Tool results are untrusted input — students will discover prompt injection through fetched content, which is a good lesson, but it means no MCP server may hold privileges over application data, and no student credential is ever passed into a tool call. Nothing resembling a credential prompt is ever displayed. Header injection derived from tool parameters is disabled or strictly allowlisted per server. Sampling, roots, and logging are deprecated upstream and are not implemented — sampling in particular would let a third-party server spend the class's model quota. Long-running task extensions are out of scope for the pilot.

A curated ten to fifteen tools across three or four servers is a rich classroom. Breadth is not a goal.

---

## 12. Skills

A skill is a name, a description, an instruction body, and optional bundled reference material. Skill names and one-line descriptions are injected into the system prompt; the full body is retrieved on demand through an internal load tool, so skills cost almost nothing until used. The load tool is internal, not an MCP tool: it never triggers a permission prompt in any permission mode, though a load does consume a per-turn tool-call step like any other tool invocation — it is a model round trip. They travel through the same registry, allowlist, and execution path as MCP tools.

**The educator has complete control of the library.** Library skills are authored in the panel, uploaded as files, or **imported from the skills.sh registry**, which the panel can browse server-side (a preliminary, best-effort integration — the registry format is compatible with Setun's skill model, but the integration degrades to manual upload if the registry changes). Imported and uploaded skill text is untrusted content: it arrives **disabled** and takes effect only when the educator enables it. Enablement is **per classroom and per student** — a skill can be offered to a whole class or to individual students.

**Students may author skills.** Writing a skill, observing how the model's behaviour changes, and iterating is among the better available lessons in how these systems work. Student-authored skills apply only to that student's conversations. Each classroom sets an authoring policy: **immediate with oversight** *(default)* — a student's skill works right away, and the panel lists every student skill with view, disable, and delete — or **pre-approval required**, where new and edited versions sit inactive until the educator approves them. Student authoring can also be disabled per classroom entirely.

The schema reserves a marker for executable skills, but code-executing skills — which would require per-session containers, filesystems, and resource limits — are explicitly deferred.

---

## 13. Artifacts

Artifacts are detected by the renderer from fenced code blocks with recognised language tags: `html` and `svg` become Tier 0 artifacts; `jsx`, `tsx`, and `svelte` become Tier 1 artifacts. Every other tag — including bare `js`, `ts`, and `css` — remains an ordinary highlighted code block, because a fragment without markup has nothing to render. No tool call, no model-side capability, no special protocol — this works with any model the gateway offers.

**Tier 0 — static.** HTML documents (with whatever CSS and JavaScript they embed) and SVG render immediately in a sandboxed iframe with no build step. Most classroom work lands here, and it costs nothing to run.

**Tier 1 — compiled.** TypeScript, JSX, and Svelte compile through `esbuild-wasm` in a worker inside the sandbox origin, against pinned self-hosted ESM runtimes — **React and Svelte**, the two frameworks models most reliably emit; no other frameworks are hosted. The compiler is fetched only when a student first opens a non-static artifact, and cached thereafter. Compilation is triggered by an explicit **Run** action or a heavily debounced idle, never per keystroke.

**Artifact continuity is a heuristic**, since no model-side protocol exists: a fenced artifact block whose language matches the conversation's most recent artifact becomes a new version of that artifact; a different language starts a new one. The guess is presentational only — every version is retained, so a wrong guess loses nothing.

Students edit artifact source in CodeMirror; edits recompile locally with no model request. Every edit is versioned, which yields undo, a diff view — *what did the AI actually change?* is a good discussion prompt — and a creations gallery.

**Student edits flow back to the model.** When an artifact has been edited since the model last emitted it, the next message in that conversation carries the current source, clearly marked as the student's edited version — so "I broke it, help me fix it" works without pasting code by hand.

Utility CSS inside artifacts comes from a self-hosted UnoCSS runtime. No public CDN is contacted at any point during normal operation.

A prominent **Build** entry point makes artifact work discoverable rather than an obscure toggle.

---

## 14. Artifact security

Generated code is untrusted and treated as hostile.

Artifacts execute on a **separate origin** from the application, in an iframe sandboxed to allow scripts but explicitly *not* same-origin, under a strict content security policy that denies outbound network access by default. Isolation therefore comes from browser primitives rather than from network filtering infrastructure, which is both simpler and harder to misconfigure.

Artifact code cannot read application cookies, storage, or DOM, cannot call authenticated APIs, and cannot navigate or manipulate the parent window. Communication with the host page is limited to explicit message passing.

Outbound network access from artifacts is off for the pilot. A future classroom permission may enable it as a deliberate teaching exercise.

Automated tests attempt parent DOM access, cookie and storage access, authenticated API calls, external fetches, frame escape, navigation, and popup abuse — and assert that each fails.

---

## 15. Image generation

Image generation runs through the gateway adapter and is subject to the same classroom enablement, allowlist, permission, and budget rules as text. It is offered only on aliases carrying the image-generation capability flag (§9), and the server refuses generation requests against unflagged aliases before any gateway call.

**Two trigger paths, one execution path.** Inside chat, the agent loop exposes an internal generate-image tool whenever the classroom allowlists a generation-capable alias — the model calls it when a student asks in conversation, subject to the classroom's permission mode like any other tool. Alongside it, the composer offers an explicit image mode that sends the prompt straight to generation on a chosen generation-capable alias. Both paths converge on the same server-side execution, enforcement, and storage code; the paths differ only in who initiates the call.

**Accounting.** Each generated image debits a fixed token-equivalent — panel-configurable, default in Appendix A — against the student's daily allowance and the classroom cap, because image endpoints do not reliably report usage and generation must never be free.

Generated images are stored locally and served from Setun; no external image URL is ever handed to the browser. Images appear in the student's creations gallery alongside artifacts.

---

## 16. Privacy and data protection

No real-world identifying information is required or requested. Optional display names are exactly that. Student records contain a pseudonymous label, a credential digest, and usage counters.

Students see only their own conversations. **Educators have no interface for reading student conversations** — the pilot deliberately omits one. Educator views show account state, activity timestamps, request and token counts, and allowance consumption.

Application logs at normal levels contain no prompt or response content. They carry internal identifiers, request identifiers, model aliases, latency, status, and token counts. Credentials are redacted everywhere, including in gateway headers and error paths.

Students can delete their own conversations and creations. Conversation retention is server-enforced by the job scheduler and configurable per classroom, defaulting to thirty days; expiring a conversation deletes its messages and attachments. **Creations — artifacts and generated images — are governed separately:** by default they persist until the student or educator deletes them (the gallery is the student's portfolio), and each classroom may instead set a creations retention period. Classroom deletion clearly distinguishes disabling, removal from a class, and permanent deletion.

**Content safety is provider-level, by explicit decision.** Setun ships no moderation or filtering layer of its own: prompts and responses pass through unread, relying on the model providers' safety training, and the no-surveillance design means no one at the school reads them either. The educator's instruments are the layered system prompt (§10), the model allowlist, and classroom availability — steering, not surveillance. This boundary is a documented choice, made by the accountable educator, not an oversight.

**Provider-side data protection is the educator's explicit, informed choice.** The architecture above governs what *Setun* collects; it does not govern what the model provider receives. Every model alias carries a data-protection flag (§9) stating whether its backing access operates under a data processing agreement. The panel displays this flag wherever aliases are allowlisted, and enabling a no-DPA alias for a classroom requires an explicit confirmation that states plainly what it means: in a school context involving minors, free-text prompts — and attached images all the more — are personal data regardless of how pseudonymous the account is. The decision is made deliberately, per classroom, by the person accountable for it — never discovered later.

---

## 17. Educator panel

A dense, single-operator tool. It provides:

- Dashboard: classroom state, active students, gateway health, current window, usage against budgets and caps, and a one-click lock.
- Classroom configuration: open and lock, weekly schedule, temporary windows, model allowlist (with data-protection flags and the no-DPA confirmation), tool permission mode, skill authoring policy, attachment policy, classroom instructions, session policy, interface language, feature toggles, retention and creations policy, budgets and allowances, force-logout.
- Model aliases: create and edit aliases — friendly name, gateway identifier, dialect, availability, data-protection flag, image-input and image-generation capability flags, optional input/output prices, utility-alias designation.
- Roster: per-student status, usage and allowance (with cost estimate), last activity, per-student instructions and attachment overrides, with disable, enable, rotate credential, clear display name, remove, and delete actions.
- Provisioning: batch creation of pseudonymous accounts — labels are generated word pairs from a localised wordlist shipped in the repository (one per locale), unique within a classroom, speakable in class — and printable credential cards.
- MCP: configured servers (from the on-disk configuration), negotiated protocol version, reachability, per-tool enablement and sensitive flags.
- Skills: the shared library with panel authoring, file upload, and skills.sh browsing and import; per-classroom and per-student enablement; review of student-authored skills, including the approval queue when pre-approval is on.

---

## 18. Student dashboard

Deliberately thin: account status, classroom open or closed with the next window, daily allowance used (with the approximate cost where prices are configured), an interface-language override, the optional display name (set, changed, or cleared here), conversation list with search, creations gallery, and the student's own skills.

Its purpose is partly transparency — everything the system knows about a student is visible to that student, and none of it is their real name.

A **first-login introduction** — what Setun is, the §16 privacy statement in a pupil's own words, the optional display name, the interface language, and a short tour — is deferred (§24) and scaffolded only: the student record carries a completion marker that nothing writes yet, and the intended flow with its open questions is recorded in `docs/setun-student-onboarding.md`.

---

## 19. Data model

Tables, described in prose to keep implementation free:

- **Classroom** — name, state, timezone, schedule, temporary windows, retention and creations policy, budgets and caps, session policy, tool permission mode, skill authoring policy, attachment policy, classroom instructions, interface language, feature flags.
- **Student** — classroom reference (a student belongs to exactly one classroom), pseudonymous label (generated word pair), optional display name, per-student instructions, interface-language override, status, credential digest and hint, first-login completion marker (§18), timestamps.
- **Session** — owner (student or educator), expiry, invalidation marker.
- **Educator** — conventional account record, password hash.
- **Conversation** — owner, title, model alias, active leaf, timestamps.
- **Message** — conversation, parent, role, content parts, tool calls and results, permission decisions, usage, timestamps. Message content feeds an FTS5 index scoped by owner.
- **Artifact** and **ArtifactVersion** — conversation and message references (nullable, so creations outlive expired conversations), type, source, ordered revisions.
- **GeneratedImage** — owner, prompt reference (nullable, as above), local storage path.
- **Attachment** — owner, message reference, kind (image or text), original filename, size, local storage path; deleted with its conversation.
- **McpServer** and **McpTool** — configuration reference, negotiated protocol version, per-tool enablement, sensitive flag. Endpoints and credential references live in the on-disk configuration, not here.
- **Skill** — origin (panel-authored, uploaded, imported, student), owner, body, resources, enablement state, approval state, reserved executable marker.
- **ModelAlias** — friendly name, gateway model identifier, dialect, availability, data-protection flag, image-input and image-generation capability flags, optional per-million-token input and output prices (USD), utility designation.
- **UsageEvent** — classroom, student (null for internal utility work, which counts against the classroom cap only), model alias, input and output tokens recorded separately, tool calls, a flag marking gateway-reported versus estimated figures (§10; generated images record their fixed token-equivalent, §15), timestamp; the source of allowance and cap accounting. Rows are retained indefinitely — volume is trivial at pilot scale.
- **LoginAttempt** — rate-limiting state per IP and credential digest. First-run setup shares this table rather than adding a scope: its keys are namespaced inside the credential-digest scope.
- **Instance** — a single row describing the installation itself: when first-run setup was claimed, when it completed, and the digest of the claim proof with the instant it was last renewed. The completion timestamp is the one flag the setup gate reads (§6.2). The row is pinned to a fixed identifier by a database constraint, so a second one is an error rather than a second opinion.

Allowlists are join tables between Classroom and ModelAlias, McpTool, and Skill respectively; the Skill allowlist additionally supports per-student rows, and per-student attachment overrides follow the same pattern.

---

## 20. Client performance

The target hardware is the Acer Chromebook Spin 511 R753T class: dual-core Celeron N4500 (some units N4020), 4 GB RAM, 32 GB eMMC, 1366×768 touchscreen convertible. The network is not a constraint; CPU, memory, and vertical screen space are.

**CPU.** With two threads there is roughly one spare core, so compilation in a worker competes directly with the UI. Static artifacts require no compilation; the compiler loads lazily and runs on explicit action. Code is highlighted only once a fenced block closes — plain preformatted text while streaming — and markdown re-rendering is scoped to the block currently being written rather than the whole message.

**Memory.** Off-screen messages use content-visibility; long conversations are windowed. Composer drafts and scroll position survive tab discard, and in-flight turns resume from the server. Expensive compositing effects, notably backdrop blur, are avoided in the theme.

**Layout.** Usable height after browser and system chrome is roughly 640 pixels, so there is no persistent application header and the sidebar is an overlay rather than a permanent column. Chat and artifact preview default to tabbed or overlaid rather than side-by-side at this width, with split view available by choice and fullscreen preview as the primary artifact mode. The on-screen keyboard in tablet mode is handled explicitly so the composer and latest message stay visible. Touch targets are sized for fingers, and panel handles are draggable by touch.

**Budget.** Development and review happen under sixfold CPU throttling as a proxy for the real device. Targets: under 250 KB gzipped JavaScript for the chat route, first meaningful paint under two seconds cold, and no dropped frames while streaming plain text.

Because these devices receive current browser updates, modern platform features are used freely and no polyfills are shipped.

---

## 21. Security requirements

The pilot does not ship until all of the following hold.

Credentials use cryptographically secure randomness; plaintext codes are never stored and never logged; the login endpoint is rate limited; sessions use secure cookies unavailable to the sandbox origin; rotation, disabling, and force-logout invalidate sessions immediately.

Classroom availability, model allowlists, tool allowlists and permission modes, skill enablement, budgets, and allowances are enforced server-side and verified against direct API access. Educator endpoints require an educator role. Student-to-student isolation is tested, including search.

The gateway has listener authentication, no public endpoint, and no exposed management API. Provider and MCP credentials never reach the browser and never enter the database. Production errors expose no stack traces or infrastructure detail.

Uploaded and imported skill content is treated as untrusted text: it is never executed, arrives disabled, and activates only by explicit educator action.

Attachment uploads are validated server-side — content sniffed against the educator's type allowlist, size-capped — stored outside any web root, served only to their owner with restrictive content-type headers, and never served to or from the sandbox origin.

Artifacts execute on an isolated origin under a restrictive policy, with escape attempts covered by automated tests and no external network access. No CDN is required for normal operation.

Backups — a nightly snapshot job: SQLite online backup via `VACUUM INTO` plus the images and skills directories, last 14 days retained on the volume (Appendix A) — have been restored successfully at least once.

---

## 22. Testing

`bun test` covers pure server logic: credential generation, hashing and rotation; pseudonym generation and uniqueness; schedule and timezone resolution including daylight-saving boundaries; allowlist, permission-mode, budget, and allowance resolution; system-prompt layering; attachment validation; MCP protocol version negotiation and legacy normalisation; agent-loop termination conditions; rate-limiter behaviour.

Integration coverage for the full path from student request through Setun to the gateway, including streaming, resume after disconnect, aborts, tool execution round trips with each permission mode, elicitation round trips, both gateway dialects, and error propagation.

Component coverage with Vitest Browser Mode for the pieces with real interaction logic — composer, permission prompt, artifact panel, panel forms.

Security coverage for authentication failures and brute force, revoked credentials, disabled accounts, sessions after rotation and force-logout, out-of-hours API access, cross-student access including search, disabled models, tools, and skills, cross-student attachment access, attachment type and size enforcement, and the full artifact escape suite.

End-to-end coverage with Playwright for three flows: a student logging in, chatting, building and editing an artifact, and logging out; an educator creating a classroom, provisioning students, opening, locking, and rotating a credential; and a scheduling flow verifying that requests are refused when closed, succeed when opened, and are refused again after locking — all asserted at the API level, not only in the UI.

`svelte-check` and Biome run in CI as separate gates.

---

## 23. Milestones

**M1 — Core loop.** Project skeleton with the §6.1 structure, UnoCSS + shadcn-svelte + clean-slate theme validation, Paraglide wiring, database and schema, student authentication, sessions and rate limiting, gateway adapter with both dialects, agent loop with the zero-tool case, SSE streaming with buffering and resume, message tree, persistence. A student can log in and chat.

**M2 — Classroom.** Classroom model, membership, open and lock, weekly schedules, temporary windows, classroom-state push channel, model alias management and allowlists, three-layer budgets and allowances with the cost-estimate display, classroom and per-student instructions, interface-language settings, session policies and force-logout, server-side enforcement across every path, student closed screen.

**M3 — Tools.** MCP client with `2026-07-28` support and legacy adapters, on-disk server configuration and tool allowlisting, permission modes and sensitive flags, tool execution inside the agent loop, elicitation handling, skills registry with authoring policies, uploads, and skills.sh import, image generation (agent-loop tool and composer image mode), student attachments with policy enforcement.

**M4 — Build.** Artifact detection, sandbox origin and policy, Tier 0 rendering, CodeMirror editing, versioning and diff, Tier 1 compilation, creations gallery, escape test suite.

**M5 — Console and hardening.** Educator panel, student dashboard, conversation search, credential cards, retention enforcement and job scheduler, backup script and restore rehearsal, log review, Chromebook performance pass, Danish locale completion, Playwright suite, operator documentation.

Pilot-ready at the end of M5.

**M6 — First run.** The setup gate, the bootstrap token, the claim, and the wizard that takes a cold installation to a working classroom: operator account, gateway check, first model alias, first classroom, optional first batch of pupils. Optional educator seed credentials, boot-time adoption of installations that predate the wizard, and a production database-file check. Also lands the scaffold — one nullable column, one documented module, no UI — for the student first-login experience of §18.

---

## 24. Deferred

Assignments and lesson presets. Artifact export as a downloadable project. PDF and office-document attachments. Currency-accurate billing (the pilot shows estimates only). Expiring lesson-scoped accounts. QR credential login. An educational model-information panel. Side-by-side model comparison — cheap once the agent loop exists, and strong teaching material. Prompt and context inspection. Executable skills with a code sandbox. Per-server automatic elicitation answers. MCP long-running task extensions. Artifact outbound network as a classroom permission. Additional locales beyond Danish and English. OIDC for educators. Multi-educator accounts and multi-tenancy. The **student first-login introduction** — the welcome, the privacy statement of §16, the optional display name, the language confirmation and the short tour — scaffolded but not built; see `docs/setun-student-onboarding.md`.

---

## 25. Definition of done

An educator opens the panel and presses **Open classroom**. Students open their Chromebooks, enter a pseudonymous code, and begin. One asks for an interactive page showing how a neural network passes information between layers, and receives a working application they can read, change, break, and argue with. At the end of the lesson the educator presses **Lock classroom**, and new requests stop — verifiably, at the API, not only in the interface.

No student supplied a name, an email address, or a phone number to participate. No provider credential left the server. No generated code could reach the authenticated application. And the whole thing runs on three containers and a single database file.

---

## Appendix A — Defaults and presets

Every value here is a starting point, editable in the panel; none is hard-coded. They exist so the implementation never has to interpret "sensible".

### Budget presets

Selecting a preset fills all five fields; fields remain individually editable afterwards.

| Field | Cautious | Standard *(default)* | Generous |
|---|---|---|---|
| Per-turn tool-call steps | 10 | 20 | 30 |
| Per-turn wall-clock | 3 min | 5 min | 10 min |
| Per-turn tokens | 50k | 100k | 200k |
| Per-student daily allowance | 100k | 250k | 500k |
| Per-classroom daily cap | 1M | 2.5M | 5M |

### Other defaults

- **Budget day** — allowances and caps reset at midnight in the classroom's timezone (§10).
- **Image generation** — token-equivalent per generated image: 10k tokens, panel-editable, debited against the student allowance and classroom cap (§15).
- **Attachments** — images ≤ 5 MB, text/code files ≤ 256 KB, at most 5 attachments per message. Default allowed types: PNG, JPEG, WebP, and plain-text/code files.
- **Login rate limiting** — per credential digest: after 5 consecutive failures within 15 minutes, progressive delay starting at 1 s and doubling to a 60 s ceiling. Per IP: at most 30 attempts per 15-minute window, then refusal until the window passes. Failure responses are uniform in both content and timing behaviour.
- **Sessions** — student sliding expiry 14 days (§7); educator sliding expiry 7 days (§7).
- **Retention** — conversations 30 days (§16); creations kept until deleted (§16).
- **Full-text search** — FTS5 with the `unicode61` tokenizer, `remove_diacritics 2`, so Danish text searches forgivingly.
- **Cost display** — per-alias prices are USD per million tokens, input and output separately; a single filled price applies to both directions. Exchange rate defaults to 7.00 DKK/USD, panel-editable; estimates are display-only (§10).
- **Backups** — nightly, last 14 days retained on the backup volume.
