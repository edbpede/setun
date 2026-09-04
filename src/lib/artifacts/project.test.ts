import { describe, expect, it } from "bun:test";
import {
  asProjectFiles,
  buildFileTree,
  defaultPathFor,
  diffFileLists,
  entryOf,
  findProjectFile,
  isProjectPath,
  kindOf,
  lineCount,
  normaliseProjectPath,
  PROJECT_FILE_MAX_BYTES,
  PROJECT_MAX_FILES,
  resolveRelative,
  runnableLanguageOf,
  sameFiles,
} from "./project";

/**
 * An artifact as a small project of files (PRD §13, §21, §22).
 *
 * The path rules are the security surface: everything a model writes and
 * everything a browser posts arrives here, and a path that escapes the project
 * must be refused rather than repaired.
 */

describe("isProjectPath", () => {
  it("accepts a relative path with a known extension", () => {
    expect(isProjectPath("App.tsx")).toBe(true);
    expect(isProjectPath("src/components/Timeline.svelte")).toBe(true);
    expect(isProjectPath("data/events.json")).toBe(true);
  });

  it("refuses anything that could leave the project (§21)", () => {
    expect(isProjectPath("../secrets.ts")).toBe(false);
    expect(isProjectPath("src/../../etc/passwd.json")).toBe(false);
    expect(isProjectPath("/etc/hosts.json")).toBe(false);
    expect(isProjectPath("src\\App.tsx")).toBe(false);
    expect(isProjectPath("./App.tsx")).toBe(false);
  });

  it("refuses a dotfile, which the leading-character rule already covers", () => {
    expect(isProjectPath(".env.json")).toBe(false);
  });

  it("refuses an extension that is not one of ours", () => {
    expect(isProjectPath("run.sh")).toBe(false);
    expect(isProjectPath("App")).toBe(false);
  });

  it("refuses a path too long or too deep to read", () => {
    expect(isProjectPath(`${"a".repeat(200)}.ts`)).toBe(false);
    expect(isProjectPath("a/b/c/d/e/f/g/h/i.ts")).toBe(false);
  });

  it("refuses anything that is not a string", () => {
    expect(isProjectPath(null)).toBe(false);
    expect(isProjectPath(42)).toBe(false);
  });
});

describe("normaliseProjectPath", () => {
  it("tidies the shapes a model actually writes", () => {
    expect(normaliseProjectPath("  ./src//App.tsx ")).toBe("src/App.tsx");
    expect(normaliseProjectPath("src\\App.tsx")).toBe("src/App.tsx");
  });

  /** A guessed path is a file the pupil cannot find (§13). */
  it("gives up rather than repairing something that escapes", () => {
    expect(normaliseProjectPath("../App.tsx")).toBeNull();
    expect(normaliseProjectPath("App.exe")).toBeNull();
  });
});

describe("kindOf and runnableLanguageOf", () => {
  it("names the kind from the extension", () => {
    expect(kindOf("src/App.tsx")).toBe("tsx");
    expect(kindOf("styles.CSS")).toBe("css");
    expect(kindOf("notes.txt")).toBeNull();
  });

  it("only the five recognised tags are rendered or compiled (§13)", () => {
    expect(runnableLanguageOf("App.tsx")).toBe("tsx");
    expect(runnableLanguageOf("index.html")).toBe("html");
    expect(runnableLanguageOf("image.svg")).toBe("svg");
    expect(runnableLanguageOf("styles.css")).toBeNull();
    expect(runnableLanguageOf("data.ts")).toBeNull();
  });

  it("puts a single-file artifact of each language somewhere conventional", () => {
    expect(defaultPathFor("html")).toBe("index.html");
    expect(defaultPathFor("tsx")).toBe("App.tsx");
    expect(defaultPathFor("svelte")).toBe("App.svelte");
  });
});

describe("entryOf", () => {
  const files = { "src/App.tsx": "a", "src/data.ts": "b", "styles.css": "c" };

  it("honours what the model marked", () => {
    expect(entryOf({ ...files, "other.tsx": "d" }, { explicit: "other.tsx" })).toBe("other.tsx");
  });

  it("ignores a mark on a file that cannot run", () => {
    expect(entryOf(files, { explicit: "styles.css" })).toBe("src/App.tsx");
  });

  it("keeps the previous revision's entry when it is still there", () => {
    expect(entryOf({ ...files, "Other.tsx": "d" }, { previous: "Other.tsx" })).toBe("Other.tsx");
  });

  it("falls back to a conventional name", () => {
    expect(entryOf(files)).toBe("src/App.tsx");
  });

  /**
   * A compiled project often carries an html shell that is not what runs, while
   * an html project never carries an App.tsx.
   */
  it("prefers the component entry over an html shell", () => {
    expect(entryOf({ "App.tsx": "a", "index.html": "b" })).toBe("App.tsx");
  });

  it("falls back to the first runnable file the model wrote this time", () => {
    const written = { "page.html": "a", "other.html": "b" };

    expect(entryOf(written, { writtenOrder: ["other.html", "page.html"] })).toBe("other.html");
  });

  it("is null when there is nothing to render", () => {
    expect(entryOf({ "styles.css": "a", "data.ts": "b" })).toBeNull();
  });
});

describe("asProjectFiles", () => {
  it("accepts a valid project", () => {
    expect(asProjectFiles({ "App.tsx": "a", "src/data.ts": "b" })).toEqual({
      "App.tsx": "a",
      "src/data.ts": "b",
    });
  });

  /** So a file called `__proto__` is a file rather than a way to reach Object. */
  it("returns a null-prototype map", () => {
    const files = asProjectFiles({ "App.tsx": "a" });

    expect(Object.getPrototypeOf(files)).toBeNull();
  });

  it("refuses a path that escapes the project (§21)", () => {
    expect(asProjectFiles({ "../secrets.ts": "a" })).toBeNull();
  });

  it("refuses anything that is not a map of strings", () => {
    expect(asProjectFiles(null)).toBeNull();
    expect(asProjectFiles([])).toBeNull();
    expect(asProjectFiles({})).toBeNull();
    expect(asProjectFiles({ "App.tsx": 42 })).toBeNull();
  });

  it("refuses a project over the caps", () => {
    const many = Object.fromEntries(
      Array.from({ length: PROJECT_MAX_FILES + 1 }, (_, at) => [`f${at}.ts`, "x"]),
    );
    expect(asProjectFiles(many)).toBeNull();

    expect(asProjectFiles({ "App.tsx": "x".repeat(PROJECT_FILE_MAX_BYTES + 1) })).toBeNull();
  });

  it("refuses a project whose files together are too large", () => {
    const heavy = Object.fromEntries(
      Array.from({ length: 8 }, (_, at) => [`f${at}.ts`, "x".repeat(PROJECT_FILE_MAX_BYTES)]),
    );

    expect(asProjectFiles(heavy)).toBeNull();
  });
});

describe("sameFiles and lineCount", () => {
  it("compares paths and content together", () => {
    expect(sameFiles({ a: "1" }, { a: "1" })).toBe(true);
    expect(sameFiles({ a: "1" }, { a: "2" })).toBe(false);
    expect(sameFiles({ a: "1" }, { a: "1", b: "2" })).toBe(false);
  });

  it("counts the lines the state note quotes", () => {
    expect(lineCount("")).toBe(0);
    expect(lineCount("en")).toBe(1);
    expect(lineCount("en\nto")).toBe(2);
    expect(lineCount("en\nto\n")).toBe(2);
  });
});

describe("diffFileLists", () => {
  it("names what a revision added, changed, removed and left alone", () => {
    const previous = [
      { path: "App.tsx", hash: "1" },
      { path: "old.ts", hash: "2" },
      { path: "styles.css", hash: "3" },
    ];
    const next = [
      { path: "App.tsx", hash: "9" },
      { path: "new.ts", hash: "4" },
      { path: "styles.css", hash: "3" },
    ];

    expect(diffFileLists(previous, next)).toEqual([
      { path: "App.tsx", change: "modified" },
      { path: "new.ts", change: "added" },
      { path: "old.ts", change: "deleted" },
      { path: "styles.css", change: "unchanged" },
    ]);
  });

  it("reads a first revision as all additions", () => {
    expect(diffFileLists([], [{ path: "App.tsx", hash: "1" }])).toEqual([
      { path: "App.tsx", change: "added" },
    ]);
  });
});

describe("buildFileTree", () => {
  it("groups paths into folders, folders before files", () => {
    expect(buildFileTree(["styles.css", "src/App.tsx", "src/lib/data.ts"])).toEqual([
      {
        kind: "folder",
        name: "src",
        path: "src",
        children: [
          {
            kind: "folder",
            name: "lib",
            path: "src/lib",
            children: [{ kind: "file", name: "data.ts", path: "src/lib/data.ts" }],
          },
          { kind: "file", name: "App.tsx", path: "src/App.tsx" },
        ],
      },
      { kind: "file", name: "styles.css", path: "styles.css" },
    ]);
  });
});

describe("resolveRelative", () => {
  it("resolves against the file that wrote the import", () => {
    expect(resolveRelative("src/App.tsx", "./data")).toBe("src/data");
    expect(resolveRelative("src/lib/a.ts", "../data")).toBe("src/data");
    expect(resolveRelative("App.tsx", "./src/data.ts")).toBe("src/data.ts");
  });

  /** An import that leaves the project is one the bundler refuses (§21). */
  it("is null when it would climb out of the project", () => {
    expect(resolveRelative("App.tsx", "../secrets")).toBeNull();
    expect(resolveRelative("src/App.tsx", "../../etc/passwd")).toBeNull();
  });
});

describe("findProjectFile", () => {
  const files = {
    "src/data.ts": "a",
    "src/ui/index.tsx": "b",
    "styles.css": "c",
  };

  it("takes an exact path first", () => {
    expect(findProjectFile(files, "styles.css")).toBe("styles.css");
  });

  it("adds the extension a model left off", () => {
    expect(findProjectFile(files, "src/data")).toBe("src/data.ts");
  });

  it("finds a folder's index file", () => {
    expect(findProjectFile(files, "src/ui")).toBe("src/ui/index.tsx");
  });

  it("is null for a file the project does not have", () => {
    expect(findProjectFile(files, "src/missing")).toBeNull();
  });
});
