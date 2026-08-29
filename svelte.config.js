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
    /**
     * Production runs `bun ./server.js`, which loads this output (PRD §5).
     *
     * `out` is normally `build/`, and every path that names it — the Dockerfile,
     * the Playwright `webServer` commands, `.gitignore` — assumes that. It is
     * overridable only so the dev suite can give each of its instances a
     * directory of its own: `vite build` empties `out` before it writes, so two
     * instances sharing one would have the second delete the files the first is
     * still serving. Unset, which is every case but that one, nothing moves.
     */
    adapter: adapter({ out: process.env.SETUN_BUILD_DIR || "build" }),
  },
};
