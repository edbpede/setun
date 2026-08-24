import presetWind4 from "@unocss/preset-wind4";
import initUnocssRuntime from "@unocss/runtime";

/**
 * Utility CSS inside artifacts (PRD §13).
 *
 * "Utility CSS inside artifacts comes from a self-hosted UnoCSS runtime. No
 * public CDN is contacted at any point during normal operation." The preset is
 * the one the application itself uses, so a class a pupil sees in Setun means
 * the same thing in the thing they build.
 */
initUnocssRuntime({ defaults: { presets: [presetWind4()] } });
