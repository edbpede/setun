import adapter from "@sveltejs/adapter-node";
import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";

/** @type {import('@sveltejs/kit').Config} */
export default {
  preprocess: vitePreprocess(),
  // Runes are mandatory in application code (see .agents/rules/svelte5-sveltekit-app.md).
  // Dependencies keep their own mode so non-runes libraries still compile.
  compilerOptions: {
    runes: ({ filename }) => (filename.split(/[/\\]/).includes("node_modules") ? undefined : true),
  },
  kit: {
    // Production runs `bun ./build/index.js` (PRD §5).
    adapter: adapter(),
  },
};
