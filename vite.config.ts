import { paraglideVitePlugin } from "@inlang/paraglide-js";
import { sveltekit } from "@sveltejs/kit/vite";
import { playwright } from "@vitest/browser-playwright";
import UnoCSS from "unocss/vite";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // UnoCSS must come before sveltekit() — the order matters for HMR.
  plugins: [
    UnoCSS(),
    sveltekit(),
    paraglideVitePlugin({
      project: "./project.inlang",
      outdir: "./src/lib/paraglide",
      emitTsDeclarations: true,
    }),
  ],
  test: {
    expect: { requireAssertions: true },
    // The server project is reserved for suites needing Vite resolution; pure
    // server logic lives in `bun test`, so it is legitimately empty for now.
    passWithNoTests: true,
    projects: [
      {
        extends: "./vite.config.ts",
        test: {
          name: "client",
          browser: {
            enabled: true,
            provider: playwright(),
            instances: [{ browser: "chromium", headless: true }],
          },
          // Component behaviour only. Pure logic belongs to `bun test` (PRD §22).
          include: ["src/**/*.svelte.spec.ts"],
          exclude: ["src/lib/server/**"],
          setupFiles: ["vitest-browser-svelte", "./src/test/vitest-setup-client.ts"],
        },
      },
      {
        extends: "./vite.config.ts",
        test: {
          name: "server",
          environment: "node",
          // Reserved for suites that need Vite resolution (virtual modules,
          // `$app/*`, `$env/*`). Plain server logic runs under `bun test`.
          include: ["src/**/*.spec.ts"],
          exclude: ["src/**/*.svelte.spec.ts"],
        },
      },
    ],
  },
});
