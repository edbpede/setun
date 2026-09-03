import { getContext, setContext } from "svelte";

/**
 * Light, dark, or whatever the device says (PRD §20).
 *
 * A Chromebook trolley lives under fluorescent light in the morning and a pupil
 * takes the same machine to a darkened room in the afternoon, so the choice is
 * genuinely three-valued: two fixed answers and "follow the device". `auto` is
 * the default, because the device already knows.
 *
 * The class on `<html>` is what `unocss-preset-shadcn` keys its dark block on,
 * so applying a preference is one class and one `color-scheme`. The same two
 * lines run in an inline script in `src/app.html` before first paint — that
 * duplication is deliberate and is the only way to avoid a flash of the wrong
 * theme; `THEME_STORAGE_KEY` is the contract between the two.
 */

export const THEME_PREFERENCES = ["light", "auto", "dark"] as const;
export type ThemePreference = (typeof THEME_PREFERENCES)[number];

/** Read by the inline boot script in `src/app.html`. Keep the two in step. */
export const THEME_STORAGE_KEY = "setun:theme";

export function isThemePreference(value: unknown): value is ThemePreference {
  return typeof value === "string" && (THEME_PREFERENCES as readonly string[]).includes(value);
}

const DARK_QUERY = "(prefers-color-scheme: dark)";

/**
 * Storage, where the browser allows it.
 *
 * `localStorage` does not merely return null where site data is blocked — the
 * property access itself throws, and a managed Chromebook profile can be
 * configured that way. The boot script in `src/app.html` already guards for it;
 * these two do the same, so a blocked browser gets a preference that works for
 * as long as the document lives rather than a layout effect that dies on the
 * first line.
 */
function readStoredPreference(): string | null {
  try {
    return localStorage.getItem(THEME_STORAGE_KEY);
  } catch {
    return null;
  }
}

function writeStoredPreference(preference: ThemePreference): void {
  try {
    // `auto` is the default, so it is stored as the absence of a choice rather
    // than as a third value nobody has to read back.
    if (preference === "auto") localStorage.removeItem(THEME_STORAGE_KEY);
    else localStorage.setItem(THEME_STORAGE_KEY, preference);
  } catch {
    // Nothing persists. The choice still paints this document, which is the
    // part the pupil asked for.
  }
}

export class ThemeState {
  preference = $state<ThemePreference>("auto");
  #systemDark = $state(false);

  /** What the document should actually be painted as. */
  get resolved(): "light" | "dark" {
    if (this.preference === "auto") return this.#systemDark ? "dark" : "light";
    return this.preference;
  }

  /**
   * Adopt the stored preference and track the device afterwards.
   *
   * Returns the teardown so a caller in an `$effect` can return it directly. No
   * work at all on the server, where there is neither a document to paint nor
   * storage to read.
   */
  start(): (() => void) | undefined {
    if (typeof window === "undefined") return;

    const stored = readStoredPreference();
    if (isThemePreference(stored)) this.preference = stored;

    const query = window.matchMedia(DARK_QUERY);
    this.#systemDark = query.matches;

    const follow = (event: MediaQueryListEvent) => {
      this.#systemDark = event.matches;
    };
    query.addEventListener("change", follow);
    return () => query.removeEventListener("change", follow);
  }

  set(preference: ThemePreference): void {
    this.preference = preference;
    writeStoredPreference(preference);
  }

  /** Reflect the resolved theme onto the document. Read reactively by an effect. */
  apply(): void {
    if (typeof document === "undefined") return;

    const resolved = this.resolved;
    document.documentElement.classList.toggle("dark", resolved === "dark");
    document.documentElement.style.colorScheme = resolved;
  }
}

const THEME_KEY = Symbol("setun:theme");

/**
 * One instance per render, held in context.
 *
 * A module-level singleton in a `.svelte.ts` file is shared across every SSR
 * request on the server, which is the one thing this container must not be.
 */
export function provideTheme(): ThemeState {
  return setContext(THEME_KEY, new ThemeState());
}

/**
 * The instance provided by the root layout.
 *
 * Named `getTheme` rather than `useTheme` because the latter reads as a React
 * hook to the linter, and this is a context read like any other.
 */
export function getTheme(): ThemeState {
  return getContext<ThemeState>(THEME_KEY);
}
