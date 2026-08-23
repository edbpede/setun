import { type ParsedSkillFile, parseSkillFile } from "./uploads";

/**
 * Browsing and importing from the skills.sh registry (PRD §12).
 *
 * "Imported from the skills.sh registry, which the panel can browse server-side
 * (a preliminary, best-effort integration — the registry format is compatible
 * with Setun's skill model, but the integration degrades to manual upload if the
 * registry changes)."
 *
 * Best-effort is the contract, so every failure here has exactly one outcome:
 * the panel says the registry could not be reached and offers the upload form
 * instead. Nothing about a lesson depends on a third party answering.
 *
 * The fetch is server-side, and what comes back is untrusted text handled the
 * same way an uploaded file is — parsed, never evaluated, and stored disabled.
 */

const REGISTRY_BASE = "https://skills.sh";

/** Short, because an educator is waiting and the fallback is one form away. */
const TIMEOUT_MS = 5_000;

export interface RegistryEntry {
  readonly id: string;
  readonly name: string;
  readonly description: string;
}

export type RegistryResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: "unavailable" };

const UNAVAILABLE = { ok: false, reason: "unavailable" } as const;

export interface RegistryOptions {
  readonly fetch?: typeof globalThis.fetch;
  readonly baseUrl?: string;
}

/** Search the registry. An empty list is a real answer; a failure is not. */
export async function searchRegistry(
  query: string,
  options: RegistryOptions = {},
): Promise<RegistryResult<RegistryEntry[]>> {
  const payload = await getJson(
    `${options.baseUrl ?? REGISTRY_BASE}/api/skills?q=${encodeURIComponent(query)}`,
    options,
  );
  if (!payload) return UNAVAILABLE;

  const entries = Array.isArray(payload)
    ? payload
    : Array.isArray((payload as { skills?: unknown }).skills)
      ? ((payload as { skills: unknown[] }).skills as unknown[])
      : null;

  // A shape this code does not recognise is the documented degradation case,
  // not something to guess at (§12).
  if (!entries) return UNAVAILABLE;

  return {
    ok: true,
    value: entries
      .map((entry) => (entry ?? {}) as Record<string, unknown>)
      .filter((entry) => typeof entry.name === "string")
      .map((entry) => ({
        id: String(entry.id ?? entry.slug ?? entry.name),
        name: String(entry.name),
        description: String(entry.description ?? ""),
      }))
      .slice(0, 50),
  };
}

/**
 * Fetch one entry's text and parse it as a skill file.
 *
 * The same parser the upload path uses, because §12 treats both as untrusted
 * content of the same kind — and because two parsers would eventually disagree
 * about what a skill file is.
 */
export async function importSkill(
  id: string,
  options: RegistryOptions = {},
): Promise<RegistryResult<ParsedSkillFile>> {
  const payload = await getJson(
    `${options.baseUrl ?? REGISTRY_BASE}/api/skills/${encodeURIComponent(id)}`,
    options,
  );
  if (!payload || typeof payload !== "object") return UNAVAILABLE;

  const entry = payload as Record<string, unknown>;
  const text =
    typeof entry.body === "string"
      ? entry.body
      : typeof entry.content === "string"
        ? entry.content
        : null;
  if (!text) return UNAVAILABLE;

  const parsed = parseSkillFile(String(entry.name ?? id), text);
  if (!parsed.ok) return UNAVAILABLE;

  return {
    ok: true,
    value: {
      ...parsed.skill,
      name: typeof entry.name === "string" ? entry.name.slice(0, 60) : parsed.skill.name,
      description:
        typeof entry.description === "string"
          ? entry.description.slice(0, 200)
          : parsed.skill.description,
    },
  };
}

/** One request, one timeout, and no failure that reaches a caller as an exception. */
async function getJson(url: string, options: RegistryOptions): Promise<unknown | null> {
  const request = options.fetch ?? globalThis.fetch;

  try {
    const response = await request(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    // An unreachable third-party registry is an ordinary state of the world,
    // and the panel already says so in words an educator can act on.
    return null;
  }
}
