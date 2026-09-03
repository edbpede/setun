import { afterEach, describe, expect, it } from "vitest";
import { isThemePreference, THEME_STORAGE_KEY, ThemeState } from "./theme.svelte";

/**
 * Light, dark, or follow the device (PRD §20, §22).
 *
 * The preference lives in this browser and nowhere else, so the assertions are
 * about what is stored and what the document ends up wearing — not about a
 * server that never hears any of it (§16).
 */

afterEach(() => {
  localStorage.removeItem(THEME_STORAGE_KEY);
  document.documentElement.classList.remove("dark");
  document.documentElement.style.removeProperty("color-scheme");
});

describe("ThemeState", () => {
  it("follows the device until a pupil says otherwise", () => {
    const theme = new ThemeState();
    theme.start();

    expect(theme.preference).toBe("auto");
    expect(theme.resolved).toBe(
      matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light",
    );
  });

  it("keeps an explicit choice, and stores it in this browser only", () => {
    const theme = new ThemeState();
    theme.start();

    theme.set("dark");

    expect(theme.resolved).toBe("dark");
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");

    // `auto` is the default, so it is stored as the absence of a choice rather
    // than as a third value anybody has to read back.
    theme.set("auto");
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
  });

  it("adopts what the boot script already read", () => {
    localStorage.setItem(THEME_STORAGE_KEY, "light");

    const theme = new ThemeState();
    theme.start();

    expect(theme.preference).toBe("light");
    expect(theme.resolved).toBe("light");
  });

  it("paints the document, class and colour scheme together", () => {
    const theme = new ThemeState();
    theme.start();

    theme.set("dark");
    theme.apply();
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(document.documentElement.style.colorScheme).toBe("dark");

    theme.set("light");
    theme.apply();
    expect(document.documentElement.classList.contains("dark")).toBe(false);
    expect(document.documentElement.style.colorScheme).toBe("light");
  });

  it("ignores a stored value it does not recognise", () => {
    localStorage.setItem(THEME_STORAGE_KEY, "sepia");

    const theme = new ThemeState();
    theme.start();

    expect(isThemePreference("sepia")).toBe(false);
    expect(theme.preference).toBe("auto");
  });
});
