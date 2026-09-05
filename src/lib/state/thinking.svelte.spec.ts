import { beforeEach, describe, expect, it } from "vitest";
import { isThinkingPreference, THINKING_STORAGE_KEY, ThinkingState } from "./thinking.svelte";

/**
 * The pupil's own thinking preference (PRD §16, §20, §22).
 *
 * A device setting like the theme: stored in this browser and nowhere else, and
 * still working where a managed profile blocks site data.
 */

beforeEach(() => {
  localStorage.removeItem(THINKING_STORAGE_KEY);
});

describe("ThinkingState", () => {
  it("shows the reasoning until a pupil says otherwise", () => {
    const state = new ThinkingState();
    state.start();

    expect(state.preference).toBe("show");
    expect(state.shown).toBe(true);
  });

  it("stores a choice to hide it, and clears the key when it goes back", () => {
    const state = new ThinkingState();

    state.set("hide");
    expect(localStorage.getItem(THINKING_STORAGE_KEY)).toBe("hide");

    // The default is the absence of a choice rather than a value to read back.
    state.set("show");
    expect(localStorage.getItem(THINKING_STORAGE_KEY)).toBeNull();
  });

  it("adopts what this browser already held", () => {
    localStorage.setItem(THINKING_STORAGE_KEY, "hide");

    const state = new ThinkingState();
    state.start();

    expect(state.preference).toBe("hide");
  });

  it("ignores a stored value that is not a preference", () => {
    localStorage.setItem(THINKING_STORAGE_KEY, "vielleicht");

    const state = new ThinkingState();
    state.start();

    expect(state.preference).toBe("show");
  });

  it("toggles between the two", () => {
    const state = new ThinkingState();

    state.toggle();
    expect(state.preference).toBe("hide");
    state.toggle();
    expect(state.preference).toBe("show");
  });

  it("guards the type at the edge, where an untrusted string arrives", () => {
    expect(isThinkingPreference("show")).toBe(true);
    expect(isThinkingPreference("hide")).toBe(true);
    expect(isThinkingPreference("auto")).toBe(false);
    expect(isThinkingPreference(null)).toBe(false);
  });
});
