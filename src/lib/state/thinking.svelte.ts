import { getContext, setContext } from "svelte";

/**
 * Whether a pupil wants to watch the model reason (PRD §20).
 *
 * Some pupils read the summary and learn from it; others find a block of the
 * model talking to itself above every answer distracting. So it is a switch, and
 * it belongs to the device rather than to the account — exactly as the theme
 * does, and for the same reason: nothing about how a pupil likes to read is
 * recorded against them (§16).
 *
 * The classroom's policy sits above this and is enforced on the server. Where
 * the policy is `shown` or `hidden` this preference is not consulted and the
 * control is not offered — a switch that decides nothing is worse than none.
 *
 * Unlike the theme there is no boot script in `src/app.html`: thinking does not
 * affect first paint, so reading the preference in a client effect is soon
 * enough.
 */

export const THINKING_PREFERENCES = ["show", "hide"] as const;
export type ThinkingPreference = (typeof THINKING_PREFERENCES)[number];

export const THINKING_STORAGE_KEY = "setun:thinking";

export function isThinkingPreference(value: unknown): value is ThinkingPreference {
  return typeof value === "string" && (THINKING_PREFERENCES as readonly string[]).includes(value);
}

/**
 * Storage, where the browser allows it.
 *
 * `localStorage` does not merely return null where site data is blocked — the
 * property access itself throws, and a managed Chromebook profile can be
 * configured that way. A blocked browser gets a preference that works for as
 * long as the document lives rather than an effect that dies on its first line.
 */
function readStoredPreference(): string | null {
  try {
    return localStorage.getItem(THINKING_STORAGE_KEY);
  } catch {
    return null;
  }
}

function writeStoredPreference(preference: ThinkingPreference): void {
  try {
    // `show` is the default, so it is stored as the absence of a choice rather
    // than as a value nobody has to read back.
    if (preference === "show") localStorage.removeItem(THINKING_STORAGE_KEY);
    else localStorage.setItem(THINKING_STORAGE_KEY, preference);
  } catch {
    // Nothing persists. The choice still holds for this document, which is the
    // part the pupil asked for.
  }
}

export class ThinkingState {
  preference = $state<ThinkingPreference>("show");

  get shown(): boolean {
    return this.preference === "show";
  }

  /**
   * Adopt the stored preference.
   *
   * No work at all on the server, where there is no storage to read; the default
   * is what SSR renders, and the effect corrects it on the client if it differs.
   */
  start(): void {
    if (typeof window === "undefined") return;

    const stored = readStoredPreference();
    if (isThinkingPreference(stored)) this.preference = stored;
  }

  set(preference: ThinkingPreference): void {
    this.preference = preference;
    writeStoredPreference(preference);
  }

  toggle(): void {
    this.set(this.preference === "show" ? "hide" : "show");
  }
}

const THINKING_KEY = Symbol("setun:thinking");

/**
 * One instance per render, held in context.
 *
 * A module-level singleton in a `.svelte.ts` file is shared across every SSR
 * request on the server, which is the one thing this container must not be.
 */
export function provideThinking(): ThinkingState {
  return setContext(THINKING_KEY, new ThinkingState());
}

export function getThinking(): ThinkingState {
  return getContext<ThinkingState>(THINKING_KEY);
}
