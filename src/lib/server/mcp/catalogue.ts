import type { CatalogueHints } from "./negotiation";

/**
 * The server-wide tool-catalogue cache (PRD §11).
 *
 * "Statelessness is exploited deliberately. Because list results no longer vary
 * per connection, tool catalogues are fetched once, cached server-wide honouring
 * the advertised freshness and cache-scope hints, and filtered per classroom.
 * There is no live MCP connection per student and no per-session state to lose
 * on restart."
 *
 * On the rule against module-scope state in server modules: this is process
 * infrastructure keyed by server, not request or user state. Nothing here is
 * derived from a request, and the same entry is correct for every caller —
 * which is precisely the property §11 is exploiting. Per-request state stays on
 * `event.locals`, as it does everywhere else.
 */

export interface CatalogueEntry {
  readonly name: string;
  readonly description: string | null;
  readonly inputSchema: Record<string, unknown> | null;
}

/**
 * How long a catalogue is trusted when the server advertises no freshness.
 *
 * Not a PRD default — Appendix A pins product policy, and this is a cache
 * lifetime. Long enough that a lesson does not re-list on every turn, short
 * enough that an operator who adds a tool sees it within a lesson.
 */
export const DEFAULT_FRESHNESS_SECONDS = 15 * 60;

interface CacheEntry {
  readonly tools: readonly CatalogueEntry[];
  readonly expiresAt: number;
  /**
   * The session the entry was fetched under, for servers whose hints say the
   * catalogue is session-scoped. A new session invalidates it; a stateless
   * server records null and the field never matters.
   */
  readonly sessionId: string | null;
}

export class ToolCatalogue {
  readonly #entries = new Map<string, CacheEntry>();

  /**
   * The catalogue for one server, fetching only when the cached copy has
   * expired or belongs to a session that has been replaced.
   *
   * The fetcher is passed in rather than reached for, so this stays a cache: it
   * knows about freshness and scope, and nothing about transports.
   */
  async list(input: {
    serverKey: string;
    hints: CatalogueHints;
    sessionId: string | null;
    fetcher: () => Promise<readonly CatalogueEntry[]>;
    now?: number;
  }): Promise<readonly CatalogueEntry[]> {
    const now = input.now ?? Date.now();
    const cached = this.#entries.get(input.serverKey);

    if (cached && cached.expiresAt > now && !this.#staleSession(cached, input)) {
      return cached.tools;
    }

    const tools = await input.fetcher();
    const freshness = input.hints.freshnessSeconds ?? DEFAULT_FRESHNESS_SECONDS;

    this.#entries.set(input.serverKey, {
      tools,
      expiresAt: now + freshness * 1000,
      sessionId: input.hints.scope === "session" ? input.sessionId : null,
    });

    return tools;
  }

  #staleSession(cached: CacheEntry, input: { hints: CatalogueHints; sessionId: string | null }) {
    return input.hints.scope === "session" && cached.sessionId !== input.sessionId;
  }

  /** Drop a server's catalogue — used when an operator edits the configuration. */
  invalidate(serverKey: string): void {
    this.#entries.delete(serverKey);
  }

  clear(): void {
    this.#entries.clear();
  }
}

/** The process-wide catalogue. One per server, shared by every classroom (§11). */
export const toolCatalogue = new ToolCatalogue();

/** Normalise a `tools/list` result into catalogue entries. */
export function readToolList(raw: unknown): CatalogueEntry[] {
  const result = (raw ?? {}) as Record<string, unknown>;
  const tools = Array.isArray(result.tools) ? result.tools : [];

  return tools
    .map((entry) => (entry ?? {}) as Record<string, unknown>)
    .filter((entry) => typeof entry.name === "string" && entry.name.length > 0)
    .map((entry) => ({
      name: String(entry.name),
      description:
        typeof entry.description === "string"
          ? entry.description
          : typeof entry.title === "string"
            ? entry.title
            : null,
      inputSchema:
        entry.inputSchema && typeof entry.inputSchema === "object"
          ? (entry.inputSchema as Record<string, unknown>)
          : null,
    }));
}
