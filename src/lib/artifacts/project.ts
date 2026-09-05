import { type ArtifactLanguage, isArtifactLanguage } from "./types";

/**
 * An artifact as a small project of files (PRD §13).
 *
 * One artifact used to be one blob of source, and the model was told to "write
 * the COMPLETE file again" every time. A pupil asking for a timeline of NATO
 * exercises got a thousand-line page: data, components and styles in one file,
 * rewritten whole on every change, at a cost that grew with the work.
 *
 * So an artifact is a set of files under relative paths, with one of them the
 * entry — the file that is rendered or compiled. Everything else is reached from
 * it by a relative import, which is a rule the bundler in the sandbox enforces
 * and this module states.
 *
 * Dependency-free on purpose: this is imported by the application, by the
 * server, and by the sandbox, which is a separate Vite build outside SvelteKit
 * and may import nothing that reaches into `$lib` or `$app`.
 */

/** Every extension a project file may have. The entry must be a runnable one. */
export const PROJECT_FILE_KINDS = [
  "tsx",
  "ts",
  "jsx",
  "js",
  "css",
  "json",
  "svelte",
  "html",
  "svg",
  "md",
] as const;

export type ProjectFileKind = (typeof PROJECT_FILE_KINDS)[number];

/** Path → source. Paths are relative, `/`-separated, and normalised. */
export type ProjectFiles = Readonly<Record<string, string>>;

/** What a version holds: the files, and which of them is rendered (§13). */
export interface ProjectSnapshot {
  readonly entry: string;
  readonly files: ProjectFiles;
}

/**
 * The caps.
 *
 * A project is a pupil's page, not a repository. The per-file cap is the one
 * that matters for the editor's sake; the total is what bounds a conversation's
 * page data, which travels whole on every load.
 */
export const PROJECT_MAX_FILES = 64;
export const PROJECT_FILE_MAX_BYTES = 256_000;
export const PROJECT_MAX_BYTES = 1_000_000;
export const PROJECT_PATH_MAX = 120;
export const PROJECT_MAX_SEGMENTS = 8;

/**
 * One path segment.
 *
 * Deliberately narrower than a filesystem allows: it must begin with a letter or
 * digit, which rules out `.`, `..` and dotfiles in one rule rather than three,
 * and it holds no separator of any kind, so a path cannot be made to mean
 * something outside the project by encoding.
 */
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function extensionOf(path: string): string {
  const at = path.lastIndexOf(".");
  return at === -1 ? "" : path.slice(at + 1).toLowerCase();
}

/** The kind a path names, or null when the extension is not one of ours. */
export function kindOf(path: string): ProjectFileKind | null {
  const extension = extensionOf(path);
  return (PROJECT_FILE_KINDS as readonly string[]).includes(extension)
    ? (extension as ProjectFileKind)
    : null;
}

/**
 * Whether a string is a path a project file may live at.
 *
 * Relative, `/`-separated, no `.` or `..` anywhere, a known extension, and short
 * enough to read. Everything a model writes goes through this, and a path that
 * fails is treated as absent rather than repaired — a guessed path is a file the
 * pupil cannot find (§13, §21).
 */
export function isProjectPath(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (value.length === 0 || value.length > PROJECT_PATH_MAX) return false;
  if (value.startsWith("/") || value.includes("\\")) return false;
  if (kindOf(value) === null) return false;

  const segments = value.split("/");
  if (segments.length > PROJECT_MAX_SEGMENTS) return false;

  return segments.every((segment) => SEGMENT.test(segment));
}

/**
 * Tidy a path a model wrote, or null when nothing valid is left of it.
 *
 * Models write `./src/App.tsx` and `src//App.tsx` and `  App.tsx `. Those are
 * the same file, and normalising them here is what stops one project holding
 * three copies of it.
 */
export function normaliseProjectPath(value: unknown): string | null {
  if (typeof value !== "string") return null;

  const cleaned = value
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .split("/")
    .filter((segment) => segment.length > 0 && segment !== ".")
    .join("/");

  return isProjectPath(cleaned) ? cleaned : null;
}

/**
 * The artifact language a file is rendered or compiled as, or null when it is
 * only ever imported by another file (§13).
 *
 * The five recognised tags and nothing else: a project whose entry is a `.css`
 * file has nothing to show.
 */
export function runnableLanguageOf(path: string): ArtifactLanguage | null {
  const kind = kindOf(path);
  return kind !== null && isArtifactLanguage(kind) ? kind : null;
}

/** Where a single-file artifact of each language lands when the model names no path. */
const DEFAULT_PATHS: Readonly<Record<ArtifactLanguage, string>> = {
  html: "index.html",
  svg: "image.svg",
  jsx: "App.jsx",
  tsx: "App.tsx",
  svelte: "App.svelte",
};

export function defaultPathFor(language: ArtifactLanguage): string {
  return DEFAULT_PATHS[language];
}

/**
 * Where an entry is looked for, in order, when nothing names one.
 *
 * The component entries come before `index.html` because a compiled project
 * often carries an html shell that is *not* what runs, while an html project
 * never carries an `App.tsx`. Each is checked at the root and under `src/`,
 * which is where a model puts things when it thinks in projects.
 */
export const ENTRY_CANDIDATES = [
  "App.tsx",
  "src/App.tsx",
  "App.jsx",
  "src/App.jsx",
  "App.svelte",
  "src/App.svelte",
  "index.html",
  "src/index.html",
  "image.svg",
  "src/image.svg",
] as const;

/**
 * Which file this project renders (§13).
 *
 * In order: what the model marked `entry`, what the previous revision used, a
 * conventional name, the first runnable file the model wrote this time, and
 * finally the first runnable file at all. Null when the project has nothing to
 * render, which is the case a caller refuses rather than guesses at.
 */
export function entryOf(
  files: ProjectFiles,
  options: {
    readonly explicit?: string | null;
    readonly previous?: string | null;
    /** The paths this write touched, in the order the model wrote them. */
    readonly writtenOrder?: readonly string[];
  } = {},
): string | null {
  const runnable = (path: string | null | undefined) =>
    typeof path === "string" && path in files && runnableLanguageOf(path) !== null ? path : null;

  const marked = runnable(options.explicit);
  if (marked) return marked;

  const kept = runnable(options.previous);
  if (kept) return kept;

  for (const candidate of ENTRY_CANDIDATES) {
    const found = runnable(candidate);
    if (found) return found;
  }

  for (const path of options.writtenOrder ?? []) {
    const found = runnable(path);
    if (found) return found;
  }

  // Sorted, so a project with two runnable files and no convention between them
  // picks the same one every time rather than whichever the object enumerated.
  return Object.keys(files).sort().find(runnable) ?? null;
}

/**
 * Validate an untrusted value as a project's files (§21).
 *
 * The one gate everything crosses: the render protocol, the version endpoint and
 * the recorder all pass through here, so a path that escapes the project or a
 * payload that would fill the database is refused in one place. Null-prototype,
 * so a file called `__proto__` is a file rather than a way to reach `Object`.
 *
 * Null on any failure rather than a partial map: half a project is a project
 * that does not build, and a caller cannot tell which half is missing.
 */
export function asProjectFiles(value: unknown): ProjectFiles | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;

  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0 || entries.length > PROJECT_MAX_FILES) return null;

  const files: Record<string, string> = Object.create(null);
  let total = 0;

  for (const [path, source] of entries) {
    if (!isProjectPath(path) || typeof source !== "string") return null;

    const bytes = byteLength(source);
    if (bytes > PROJECT_FILE_MAX_BYTES) return null;

    total += bytes;
    if (total > PROJECT_MAX_BYTES) return null;

    // A duplicate after normalisation — `./App.tsx` beside `App.tsx` — is two
    // files claiming one path, and silently keeping the last is how a pupil
    // loses an edit.
    if (path in files) return null;
    files[path] = source;
  }

  return files;
}

/** UTF-8 length, without allocating an encoder per call. */
const ENCODER = new TextEncoder();

export function byteLength(source: string): number {
  return ENCODER.encode(source).length;
}

/** Whether two file maps hold exactly the same paths with exactly the same content. */
export function sameFiles(a: ProjectFiles, b: ProjectFiles): boolean {
  const paths = Object.keys(a);
  if (paths.length !== Object.keys(b).length) return false;

  return paths.every((path) => path in b && a[path] === b[path]);
}

/**
 * How many lines a file holds.
 *
 * For the state note, which tells the model how long each file has become —
 * the one lever, besides the prompt, against a model writing one giant file.
 */
export function lineCount(source: string): number {
  if (source.length === 0) return 0;
  return source.endsWith("\n") ? source.split("\n").length - 1 : source.split("\n").length;
}

export type FileChangeKind = "added" | "modified" | "deleted" | "unchanged";

export interface FileChange {
  readonly path: string;
  readonly change: FileChangeKind;
}

/** A file identified by content, which is how a revision names what it holds. */
export interface FileRef {
  readonly path: string;
  readonly hash: string;
}

/**
 * What one revision changed, compared with the one before it (§13).
 *
 * By hash rather than by content, because the history view has the hashes and
 * not the bytes — a version list is cheap and its sources are not. Paths sorted,
 * so two runs over the same pair read the same.
 */
export function diffFileLists(
  previous: readonly FileRef[],
  next: readonly FileRef[],
): FileChange[] {
  const before = new Map(previous.map((file) => [file.path, file.hash]));
  const after = new Map(next.map((file) => [file.path, file.hash]));

  const paths = [...new Set([...before.keys(), ...after.keys()])].sort();

  return paths.map((path) => {
    const was = before.get(path);
    const now = after.get(path);

    if (was === undefined) return { path, change: "added" as const };
    if (now === undefined) return { path, change: "deleted" as const };
    return { path, change: was === now ? ("unchanged" as const) : ("modified" as const) };
  });
}

/** A folder in the file tree, or one of its files. */
export type FileTreeNode =
  | { readonly kind: "file"; readonly name: string; readonly path: string }
  | {
      readonly kind: "folder";
      readonly name: string;
      readonly path: string;
      readonly children: FileTreeNode[];
    };

/**
 * Group paths into the tree the Build panel shows.
 *
 * Folders before files and each group sorted by name, so a project reads the
 * same however its paths happened to be enumerated.
 */
export function buildFileTree(paths: readonly string[]): FileTreeNode[] {
  const root: FileTreeNode[] = [];

  for (const path of [...paths].sort()) {
    const segments = path.split("/");
    let level = root;
    let prefix = "";

    segments.forEach((name, index) => {
      prefix = prefix ? `${prefix}/${name}` : name;

      if (index === segments.length - 1) {
        level.push({ kind: "file", name, path });
        return;
      }

      const existing = level.find(
        (node): node is Extract<FileTreeNode, { kind: "folder" }> =>
          node.kind === "folder" && node.name === name,
      );

      if (existing) {
        level = existing.children;
        return;
      }

      const folder = { kind: "folder" as const, name, path: prefix, children: [] };
      level.push(folder);
      level = folder.children;
    });
  }

  return sortTree(root);
}

function sortTree(nodes: FileTreeNode[]): FileTreeNode[] {
  nodes.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "folder" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  for (const node of nodes) {
    if (node.kind === "folder") sortTree(node.children);
  }

  return nodes;
}

/**
 * Resolve a relative import against the file that wrote it.
 *
 * Null when it would leave the project, which the bundler reports to the pupil
 * as an import it cannot follow rather than reaching for something outside
 * (§13, §21).
 */
export function resolveRelative(importer: string, specifier: string): string | null {
  const base = importer.split("/").slice(0, -1);
  const parts = [...base, ...specifier.replace(/\\/g, "/").split("/")];
  const resolved: string[] = [];

  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (resolved.length === 0) return null;
      resolved.pop();
      continue;
    }
    resolved.push(part);
  }

  return resolved.length > 0 ? resolved.join("/") : null;
}

/** The extensions an import may leave off, in the order they are tried. */
const IMPLIED_EXTENSIONS = [".tsx", ".ts", ".jsx", ".js", ".svelte", ".json", ".css"] as const;

/**
 * Find the file an import means.
 *
 * Exact match first, then the extensions a model leaves off, then `index.*` in a
 * folder of that name — the three shapes JavaScript projects actually use. Null
 * when there is nothing, which the bundler turns into an error naming the files
 * the project does have.
 */
export function findProjectFile(files: ProjectFiles, path: string): string | null {
  if (Object.hasOwn(files, path)) return path;

  for (const extension of IMPLIED_EXTENSIONS) {
    const candidate = `${path}${extension}`;
    if (Object.hasOwn(files, candidate)) return candidate;
  }

  for (const extension of IMPLIED_EXTENSIONS) {
    const candidate = `${path}/index${extension}`;
    if (Object.hasOwn(files, candidate)) return candidate;
  }

  return null;
}
