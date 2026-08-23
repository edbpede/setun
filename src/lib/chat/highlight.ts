import { createHighlighterCore, type HighlighterCore } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";

/**
 * Syntax highlighting (PRD §5, §20).
 *
 * Shiki's fine-grained core with the JavaScript regex engine and a small
 * language set — the full bundle is several megabytes of WASM and grammars, and
 * the chat route has a 250 KB gzipped budget (§20).
 *
 * Loaded lazily on first use, so a conversation with no code in it never pays
 * for the highlighter at all.
 */

/** Deliberately short: the languages a lesson actually produces (§5). */
const LANGUAGES = {
  html: () => import("@shikijs/langs/html"),
  css: () => import("@shikijs/langs/css"),
  javascript: () => import("@shikijs/langs/javascript"),
  typescript: () => import("@shikijs/langs/typescript"),
  python: () => import("@shikijs/langs/python"),
  json: () => import("@shikijs/langs/json"),
  markdown: () => import("@shikijs/langs/markdown"),
  svelte: () => import("@shikijs/langs/svelte"),
} as const;

export type HighlightLanguage = keyof typeof LANGUAGES;

const ALIASES: Record<string, HighlightLanguage> = {
  js: "javascript",
  jsx: "javascript",
  ts: "typescript",
  tsx: "typescript",
  py: "python",
  md: "markdown",
  sh: "javascript",
};

let highlighter: HighlighterCore | null = null;
let loading: Promise<HighlighterCore> | null = null;

/** Resolve a fence tag to a supported language, or null to leave it plain. */
export function resolveLanguage(tag: string | undefined): HighlightLanguage | null {
  if (!tag) return null;
  const normalised = tag.toLowerCase().trim();

  if (normalised in LANGUAGES) return normalised as HighlightLanguage;
  return ALIASES[normalised] ?? null;
}

async function getHighlighter(language: HighlightLanguage): Promise<HighlighterCore> {
  loading ??= createHighlighterCore({
    themes: [import("@shikijs/themes/github-light")],
    langs: [],
    // The JS engine avoids shipping the Oniguruma WASM binary entirely (§20).
    engine: createJavaScriptRegexEngine(),
  });

  highlighter ??= await loading;

  if (!highlighter.getLoadedLanguages().includes(language)) {
    await highlighter.loadLanguage(await LANGUAGES[language]());
  }

  return highlighter;
}

/**
 * Highlight a closed code block, returning sanitised-by-construction HTML.
 *
 * Shiki emits its own markup from a parsed grammar rather than passing input
 * through, so the result is structural HTML around escaped text.
 *
 * Returns null when the language is unsupported or highlighting fails; the
 * caller then renders plain preformatted text, which is also what it renders
 * while a fence is still open (§20).
 */
export async function highlightCode(code: string, tag: string | undefined): Promise<string | null> {
  const language = resolveLanguage(tag);
  if (!language) return null;

  try {
    const shiki = await getHighlighter(language);
    return shiki.codeToHtml(code, { lang: language, theme: "github-light" });
  } catch {
    return null;
  }
}
