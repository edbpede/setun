# Setun — Product Requirements Document

**Version:** 0.1
**Status:** Ready for implementation
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
2. The educator controls access, availability, models, tools, and budgets — from a UI, without touching a database or a terminal.
3. Students can build, run, inspect, and break code artifacts safely.
4. The application is genuinely pleasant on the classroom's actual hardware.
5. Tool use (MCP) and reusable instructions (skills) are first-class, because they are the interesting teaching material.
6. The architecture stays small enough that one person can maintain it.

## 3. Non-goals

Not an LMS, gradebook, or timetable system. No school-wide identity integration, multi-tenancy, or billing. No conversation-surveillance interface for educators. No agent marketplace, no plugin ecosystem, no RAG or document-management product. No provider-specific logic anywhere above the gateway adapter.

---

## 4. Users

**Student.** Logs in with an access code. Chats with permitted models, uses permitted tools and skills, builds and edits artifacts, generates images, manages their own conversations and creations, optionally sets a display name. Cannot see other students' data, alter classroom settings, reach the gateway directly, or use anything the educator has not enabled.

**Educator.** Conventional authenticated account. Creates classrooms, provisions and manages student credentials, opens and locks access, sets schedules, curates the model allowlist, registers MCP servers and selects individual tools, maintains the skill library, sets budgets, and views operational and aggregate usage data — never conversation contents.

---

## 5. Technology

**Runtime:** Bun
**Framework:** SvelteKit 2 with Svelte 5 (runes), `adapter-bun`
**Styling:** UnoCSS with `presetWind4`, plus `shadcn-svelte` components
**Editor:** CodeMirror 6
**Database:** SQLite via `bun:sqlite`, schema and queries through Drizzle ORM, full-text search via FTS5
**Gateway:** CLIProxyAPI, pinned version, unmodified
**Artifact compilation:** `esbuild-wasm`, lazily loaded, executed inside the sandbox origin
**Sandbox styling:** self-hosted `@unocss/runtime`
**Syntax highlighting:** Shiki, fine-grained core, JS regex engine, small language set
**Reverse proxy:** Caddy
**Testing:** Vitest for units, Playwright for end-to-end
**Containerisation:** Docker Compose — three services: application, CPA, Caddy

Deliberate omissions: no document database, no search server, no vector database, no separate API service, no heavyweight in-browser IDE, no CDN dependencies of any kind.

A single SvelteKit application serves the student UI, the educator panel, and all server logic. Server-side concerns live in clearly separated modules — gateway adapter, agent loop, MCP client, skills registry, classroom enforcement — so any of them could be extracted later without a rewrite. At pilot scale, splitting them into services now would add deployment complexity and buy nothing.

**Stack risk to validate on day one:** `shadcn-svelte` assumes Tailwind v4. UnoCSS `presetWind4` targets the same conventions but differs in theme handling and class-merge semantics. Wire up one non-trivial component before committing to the combination.

---

## 6. Architecture

The browser talks only to Setun. Setun talks to CPA over a private Docker network; CPA talks to providers. The database is a single SQLite file on a mounted volume.

Artifacts execute in an iframe served from a **separate origin** — a distinct hostname, and the only other thing Caddy exposes. CPA has no published host port and is unreachable from outside the internal network.

MCP servers are contacted server-side only. The browser never speaks MCP, never sees a provider credential, and never sees an MCP server credential.

---

## 7. Identity and authentication

**Students authenticate with a single high-entropy access code.** No username, no password, no email address — not even a synthetic one. The student record has no email field.

The code carries at least 120 bits of entropy, generated from a cryptographically secure source, encoded in Crockford Base32, and grouped for readability, because students type these on small keyboards. The visual format is presentation, not a security boundary, and may change.

The server stores a keyed digest of the code — HMAC-SHA-256 with a pepper held outside the database — uniquely indexed for direct lookup. The plaintext code is never persisted. It is displayed exactly twice: once at provisioning and once at rotation, on a printable credential card. After that screen it can only be replaced, never recovered. A short non-secret tail may be retained purely to identify a card during support.

Successful login establishes a normal session with an `HttpOnly`, `Secure`, appropriately `SameSite` cookie, scoped so the sandbox origin can never read it. Students do not re-enter the code per request.

Login is rate limited per IP and, where feasible, per credential digest, with progressive delay and uniform failure responses that never disclose whether a code exists. Rotation and disabling both invalidate existing sessions immediately.

Educator authentication is separate and conventional. For the pilot a configured admin account suffices; OIDC may be added later without affecting student auth.

---

## 8. Classrooms and availability

A classroom is the unit of configuration: membership, model allowlist, tool allowlist, enabled skills, budgets, retention, feature toggles, and schedule.

Every classroom has an explicit **open** or **locked** state that overrides all scheduling. On top of that sits a recurring weekly schedule expressed in the classroom's IANA timezone, correct across daylight-saving transitions, plus one-off windows for homework or a substituted lesson.

The educator has two prominent controls: **Open now**, with duration options including until the end of the current scheduled window, and **Lock classroom**, which takes effect immediately. A response already streaming when the lock lands may finish; every new request is refused.

Enforcement is server-side and applies to every path that can reach a model — chat, tool execution, image generation, and any API endpoint. Hiding a control in the UI is never treated as access control.

When access is unavailable, students see a plain, friendly status screen with the next scheduled opening — never a raw authorisation error, never any infrastructure detail.

---

## 9. Model gateway

CPA is treated as an internal, replaceable gateway. Setun speaks to one endpoint shape through a single adapter module; image generation uses CPA's image endpoints through the same adapter.

Setun maintains its own **model alias table** — friendly names such as Fast, Balanced, Powerful, mapped to concrete CPA model identifiers. Students only ever see the friendly name. Classrooms allow a subset of aliases and the backend validates every request against that subset. Infrastructure can change underneath without changing classroom vocabulary or student-facing language.

CPA runs with listener authentication enabled and its management API disabled or bound to localhost, since that API can rewrite provider configuration. Its self-updating admin panel is turned off and the image version pinned.

Gateway failures produce a single student-facing message about temporary unavailability. Upstream URLs, provider identifiers, OAuth errors, tokens, and stack traces never reach the browser. Gateway health and available-model counts appear in the educator panel.

No classroom, student, or credential data is ever stored in CPA. If CPA is replaced, only the adapter changes.

**Operational note.** Where CPA is backed by subscription OAuth accounts rather than API keys, concurrency is the binding constraint: twenty students in one lesson window will hit provider rate limits. The alias table should therefore include at least one alias backed by a conventional API key, so a lesson degrades rather than fails. Separately, subscription-backed access carries no data processing agreement, which is the sharper consideration for a school; see §16.

---

## 10. Chat and the agent loop

Because MCP and skills are in scope, the core is not a stream proxy but an **agent loop**: assemble context, call the model, stream deltas to the client, execute any requested tools, append results, repeat until the model stops or a budget is exhausted. Plain chat is the zero-tool case. This is built first; everything else participates in it.

Budgets are per-classroom and cover maximum tool-call steps per turn, wall-clock time per turn, and tokens per turn. They exist because an agent loop is how a subscription's daily quota disappears in a single lesson.

Messages are stored as a **tree**, not a list. Editing a prompt or regenerating a response creates a sibling; each conversation tracks its active leaf. This costs little now and avoids a migration later.

The loop emits a **normalised internal event stream** — text delta, tool call started, tool result, usage, error, done — rather than forwarding provider events verbatim. Providers change; the internal wire format should not.

Aborting a turn cancels the in-flight upstream request and any running tool execution. The assistant message is buffered server-side as it streams, so a reloaded or discarded tab can resume the turn from the database rather than losing it. Conversation titles are generated asynchronously by a cheap model after the first exchange.

---

## 11. MCP

Setun is an MCP **client**. Students never configure servers; the educator registers them per classroom and selects which individual tools are exposed. Students see only that certain capabilities are available.

**Protocol support.** The internal model targets the `2026-07-28` revision, with older revisions handled by adapters at the transport edge rather than by a union-of-all-versions abstraction. On registration the client probes `server/discover` for version and capability negotiation and falls back to the legacy handshake if that is unsupported; the negotiated version is stored per server and displayed in the educator panel. Compatibility handling covers the absent result-type field on older results, legacy session semantics, and both the old and renumbered error-code ranges.

**Transport.** Streamable HTTP only. The deprecated HTTP+SSE transport is not implemented. Stdio servers, if ever needed, run as separate pinned containers on the internal network and are addressed over HTTP — educator-supplied stdio configuration would amount to remote code execution on the host and is not supported.

**Statelessness is exploited deliberately.** Because list results no longer vary per connection, tool catalogues are fetched once, cached server-wide honouring the advertised freshness and cache-scope hints, and filtered per classroom. There is no live MCP connection per student and no per-session state to lose on restart.

**Multi-round-trip requests** fold into the agent loop: an interim result requesting input is either answered automatically from classroom policy or surfaced to the student, then the original request is retried with the responses attached.

**Security posture.** Tool results are untrusted input — students will discover prompt injection through fetched content, which is a good lesson, but it means no MCP server may hold privileges over application data, and no student credential is ever passed into a tool call. Elicitation is rendered with unmissable server attribution and a restricted set of renderable input types; nothing resembling a credential prompt is displayed. Header injection derived from tool parameters is disabled or strictly allowlisted per server. Sampling, roots, and logging are deprecated upstream and are not implemented — sampling in particular would let a third-party server spend the class's model quota. Long-running task extensions are out of scope for the pilot.

A curated ten to fifteen tools across three or four servers is a rich classroom. Breadth is not a goal.

---

## 12. Skills

A skill is a name, a description, an instruction body, and optional bundled reference material. Skill names and one-line descriptions are injected into the system prompt; the full body is retrieved on demand through an internal load tool, so skills cost almost nothing until used. They travel through the same registry, allowlist, and execution path as MCP tools.

Skills are enabled per classroom. The schema reserves a marker for executable skills, but code-executing skills — which would require per-session containers, filesystems, and resource limits — are explicitly deferred.

**Students may author skills.** Writing a skill, observing how the model's behaviour changes, and iterating is among the better available lessons in how these systems work, and it gives the student dashboard something substantial to hold. Student-authored skills apply only to that student's conversations.

---

## 13. Artifacts

Artifacts are detected by the renderer from fenced code blocks with recognised language tags. No tool call, no model-side capability, no special protocol — this works with any model the gateway offers.

**Tier 0 — static.** HTML, CSS, and JavaScript render immediately in a sandboxed iframe with no build step. Most classroom work lands here, and it costs nothing to run.

**Tier 1 — compiled.** TypeScript, JSX, and Svelte compile through `esbuild-wasm` in a worker inside the sandbox origin, against pinned self-hosted ESM runtimes. The compiler is fetched only when a student first opens a non-static artifact, and cached thereafter. Compilation is triggered by an explicit **Run** action or a heavily debounced idle, never per keystroke.

Students edit artifact source in CodeMirror; edits recompile locally with no model request. Every edit is versioned, which yields undo, a diff view — *what did the AI actually change?* is a good discussion prompt — and a creations gallery.

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

Image generation runs through the gateway adapter and is subject to the same classroom enablement, allowlist, and budget rules as text. Generated images are stored locally and served from Setun; no external image URL is ever handed to the browser. Images appear in the student's creations gallery alongside artifacts.

---

## 16. Privacy and data protection

No real-world identifying information is required or requested. Optional display names are exactly that. Student records contain a pseudonymous label, a credential digest, and usage counters.

Students see only their own conversations. **Educators have no interface for reading student conversations** — the pilot deliberately omits one. Educator views show account state, activity timestamps, request and token counts, and budget consumption.

Application logs at normal levels contain no prompt or response content. They carry internal identifiers, request identifiers, model aliases, latency, status, and token counts. Credentials are redacted everywhere, including in gateway headers and error paths.

Students can delete their own conversations and creations. Conversation retention is server-enforced and configurable per classroom, defaulting to thirty days. Classroom deletion clearly distinguishes disabling, removal from a class, and permanent deletion.

**Provider-side data protection is a separate, explicit decision.** The architecture above governs what *Setun* collects. It does not govern what the model provider receives, and subscription-backed access typically comes with no data processing agreement. In a school context involving minors, free-text prompts are personal data regardless of how pseudonymous the account is. This must be decided deliberately — by choosing appropriately governed provider access, or by scoping what the pilot is used for — rather than discovered later.

---

## 17. Educator panel

A dense, single-operator tool. It provides:

- Dashboard: classroom state, active students, gateway health, current window, usage against budget, and a one-click lock.
- Classroom configuration: open and lock, weekly schedule, temporary windows, model allowlist, feature toggles, retention, and budgets.
- Roster: per-student status, usage, last activity, with disable, enable, rotate credential, remove, and delete actions.
- Provisioning: batch creation of pseudonymous accounts and printable credential cards.
- MCP: registered servers, negotiated protocol version, reachability, per-tool enablement.
- Skills: the shared library, per-classroom enablement, and review of student-authored skills.

**Open decision.** Whether MCP servers and skills are authored freely through the panel, or defined in version-controlled configuration on disk with the panel only toggling them per classroom. The second is markedly safer and simpler; the first is what an educator will want by the third week. Recommendation for v0.1: file-defined servers with panel-side toggling, and panel-authored skills — skills are inert text, servers are network endpoints.

---

## 18. Student dashboard

Deliberately thin: account status, classroom open or closed with the next window, allowance used, conversation list, creations gallery, and the student's own skills.

Its purpose is partly transparency — everything the system knows about a student is visible to that student, and none of it is their real name.

---

## 19. Data model

Tables, described in prose to keep implementation free:

- **Classroom** — name, state, timezone, schedule, temporary windows, retention, budgets, feature flags.
- **Student** — classroom reference, pseudonymous label, optional display name, status, credential digest and hint, timestamps.
- **Session** — student reference, expiry, invalidation marker.
- **Educator** — conventional account record.
- **Conversation** — owner, title, model alias, active leaf, timestamps.
- **Message** — conversation, parent, role, content parts, tool calls and results, usage, timestamps.
- **Artifact** and **ArtifactVersion** — conversation and message references, type, source, ordered revisions.
- **GeneratedImage** — owner, prompt reference, local storage path.
- **McpServer** and **McpTool** — endpoint, credential reference, negotiated protocol version, per-tool enablement.
- **Skill** — owner (library or student), body, resources, enablement.
- **ModelAlias** — friendly name, gateway model identifier, availability.
- **UsageEvent** — student, model alias, tokens, tool calls, timestamp.

Allowlists are join tables between Classroom and ModelAlias, McpTool, and Skill respectively.

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

Credentials use cryptographically secure randomness; plaintext codes are never stored and never logged; the login endpoint is rate limited; sessions use secure cookies unavailable to the sandbox origin; rotation and disabling invalidate sessions immediately.

Classroom availability, model allowlists, tool allowlists, and budgets are enforced server-side and verified against direct API access. Educator endpoints require an educator role. Student-to-student isolation is tested.

The gateway has listener authentication, no public endpoint, and no exposed management API. Provider and MCP credentials never reach the browser. Production errors expose no stack traces or infrastructure detail.

Artifacts execute on an isolated origin under a restrictive policy, with escape attempts covered by automated tests and no external network access. No CDN is required for normal operation.

Backups have been restored successfully at least once.

---

## 22. Testing

Unit coverage for credential generation, hashing and rotation; schedule and timezone resolution including daylight-saving boundaries; allowlist and budget resolution; MCP protocol version negotiation and legacy normalisation; agent-loop termination conditions.

Integration coverage for the full path from student request through Setun to the gateway, including streaming, aborts, tool execution round trips, multi-round-trip input requests, and error propagation.

Security coverage for authentication failures and brute force, revoked credentials, disabled accounts, sessions after rotation, out-of-hours API access, cross-student access, disabled models and tools, and the full artifact escape suite.

End-to-end coverage with Playwright for three flows: a student logging in, chatting, building and editing an artifact, and logging out; an educator creating a classroom, provisioning students, opening, locking, and rotating a credential; and a scheduling flow verifying that requests are refused when closed, succeed when opened, and are refused again after locking — all asserted at the API level, not only in the UI.

---

## 23. Milestones

**M1 — Core loop.** Project skeleton, database and schema, student authentication and sessions, gateway adapter, agent loop with the zero-tool case, streaming chat, message tree, persistence. A student can log in and chat.

**M2 — Classroom.** Classroom model, membership, open and lock, weekly schedules, temporary windows, model aliases and allowlists, budgets, server-side enforcement across every path, student closed screen.

**M3 — Tools.** MCP client with `2026-07-28` support and legacy adapters, server registration and tool allowlisting, tool execution inside the agent loop, elicitation handling, skills registry and student authoring, image generation.

**M4 — Build.** Artifact detection, sandbox origin and policy, Tier 0 rendering, CodeMirror editing, versioning and diff, Tier 1 compilation, creations gallery, escape test suite.

**M5 — Console and hardening.** Educator panel, student dashboard, credential cards, retention enforcement, rate limiting, log review, backup and restore rehearsal, Chromebook performance pass, Playwright suite, operator documentation.

Pilot-ready at the end of M5.

---

## 24. Deferred

Assignments and lesson presets. Artifact export as a downloadable project. Expiring lesson-scoped accounts. QR credential login. An educational model-information panel. Side-by-side model comparison — cheap once the agent loop exists, and strong teaching material. Prompt and context inspection. Executable skills with a code sandbox. MCP long-running task extensions. OIDC for educators.

---

## 25. Definition of done

An educator opens the panel and presses **Open classroom**. Students open their Chromebooks, enter a pseudonymous code, and begin. One asks for an interactive page showing how a neural network passes information between layers, and receives a working application they can read, change, break, and argue with. At the end of the lesson the educator presses **Lock classroom**, and new requests stop — verifiably, at the API, not only in the interface.

No student supplied a name, an email address, or a phone number to participate. No provider credential left the server. No generated code could reach the authenticated application. And the whole thing runs on three containers and a single database file.

