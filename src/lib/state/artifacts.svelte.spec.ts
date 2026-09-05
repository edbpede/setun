import { describe, expect, it } from "vitest";
import { type ArtifactView, ArtifactWorkspace, CONSOLE_KEPT } from "./artifacts.svelte";

/**
 * The workspace's own state machine (PRD §13, §20, §22).
 *
 * Three stages and one fraction, with no geometry anywhere near them: what is on
 * screen is one value, and whether that is drawn as two columns or a sheet is
 * the shell's business. These assertions are what keep it that way.
 */

const BASE_VERSION = {
  id: "version-1",
  revision: 1,
  source: "<button>Klik</button>",
  entry: "index.html",
  files: { "index.html": "<button>Klik</button>" },
  authoredBy: "model" as const,
  createdAt: new Date(0).toISOString(),
};

function artifact(overrides: Partial<ArtifactView> = {}): ArtifactView {
  return {
    id: "artifact-1",
    language: "html",
    title: "Klikkeren",
    ...overrides,
    // Merged after the spread, not before it: an override that names `latest`
    // states only the fields it cares about, and replacing the whole of it would
    // leave the artifact without the files every reader now expects.
    latest: { ...BASE_VERSION, ...overrides.latest },
  };
}

describe("the workspace stage", () => {
  it("keeps a newer restore when an older save has identical files but another entry or tag", () => {
    const workspace = new ArtifactWorkspace();
    const files = { "index.html": "<p>home</p>", "other.html": "<p>other</p>" };
    workspace.items = [artifact({ latest: { ...BASE_VERSION, files } })];
    workspace.select("artifact-1");
    workspace.restore({ ...BASE_VERSION, files, entry: "other.html", language: "html" });
    workspace.applyVersion("artifact-1", { ...BASE_VERSION, files, revision: 2 });
    expect(workspace.entry).toBe("other.html");
    expect(workspace.draftReplace).not.toBeNull();

    workspace.restore({ ...BASE_VERSION, files, language: "svelte" });
    workspace.applyVersion("artifact-1", { ...BASE_VERSION, files, revision: 3, language: "html" });
    expect(workspace.language).toBe("svelte");
    expect(workspace.draftReplace).not.toBeNull();

    workspace.applyVersion("artifact-1", {
      ...BASE_VERSION,
      files,
      revision: 4,
      language: "svelte",
    });
    expect(workspace.draftReplace).toBeNull();
    workspace.applyVersion("artifact-1", { ...BASE_VERSION, files, revision: 3, language: "html" });
    expect(workspace.open?.latest.revision).toBe(4);
    expect(workspace.language).toBe("svelte");
  });

  it("starts on the conversation and nothing else", () => {
    const workspace = new ArtifactWorkspace();

    expect(workspace.stage).toBe("chat");
    expect(workspace.visible).toBe(false);
    expect(workspace.conversationVisible).toBe(true);
  });

  it("opens onto the split rather than over the conversation", () => {
    const workspace = new ArtifactWorkspace();
    workspace.items = [artifact()];

    workspace.reveal();

    // The overlay this replaces covered the composer, so every question about an
    // artifact began with putting the artifact away (§13, §20).
    expect(workspace.stage).toBe("both");
    expect(workspace.conversationVisible).toBe(true);
  });

  it("does not drop a pupil out of the build surface when something else arrives", () => {
    const workspace = new ArtifactWorkspace();
    workspace.items = [artifact()];
    workspace.setStage("build");

    workspace.reveal();

    expect(workspace.stage).toBe("build");
  });

  it("opens the one thing built, and the list when there are several", () => {
    const one = new ArtifactWorkspace();
    one.items = [artifact()];
    one.reveal();
    expect(one.openId).toBe("artifact-1");
    expect(one.tab).toBe("preview");

    const several = new ArtifactWorkspace();
    several.items = [artifact(), { ...artifact(), id: "artifact-2" }];
    several.reveal();
    // Guessing at the first row is a guess; the list is where the question is
    // actually answered (§13).
    expect(several.openId).toBeNull();
    expect(several.tab).toBe("index");
  });

  it("keeps a running artifact in the document while the pupil reads", () => {
    const workspace = new ArtifactWorkspace();
    workspace.items = [artifact()];
    workspace.select("artifact-1");

    workspace.hide();

    // Tearing the frame down to glance at the conversation throws away whatever
    // state the artifact had built up — a score, a board, a half-filled form.
    expect(workspace.stage).toBe("chat");
    expect(workspace.mounted).toBe(true);
    expect(workspace.running?.files).toEqual({ "index.html": "<button>Klik</button>" });
  });

  it("never lets the divider drag either side out of existence (§20)", () => {
    const workspace = new ArtifactWorkspace();

    workspace.setFraction(0);
    expect(workspace.fraction).toBe(0.3);

    workspace.setFraction(1);
    expect(workspace.fraction).toBe(0.72);
  });
});

describe("following the model's writes", () => {
  it("opens the workspace on a new artifact and shows it", () => {
    const workspace = new ArtifactWorkspace();
    workspace.replace([artifact()], "c1");
    // First hydration is a page load, not a turn landing: nothing opens (§13).
    expect(workspace.visible).toBe(false);

    workspace.replace(
      [
        {
          ...artifact(),
          id: "artifact-2",
          title: "Quiz",
          latest: { ...artifact().latest, id: "v2" },
        },
        artifact(),
      ],
      "c1",
    );

    expect(workspace.visible).toBe(true);
    expect(workspace.stage).toBe("both");
    expect(workspace.openId).toBe("artifact-2");
  });

  it("opens on the first artifact of a conversation that had none", () => {
    const workspace = new ArtifactWorkspace();
    workspace.replace([], "c1");

    workspace.replace([artifact()], "c1");

    expect(workspace.visible).toBe(true);
    expect(workspace.openId).toBe("artifact-1");
  });

  it("does not open when the pupil merely switches conversation", () => {
    const workspace = new ArtifactWorkspace();
    workspace.replace([], "c1");

    workspace.replace([artifact()], "c2");

    expect(workspace.visible).toBe(false);
  });

  it("drops the unseen badge when the list it was raised over is replaced", () => {
    const workspace = new ArtifactWorkspace();
    workspace.replace([artifact()], "c1");
    workspace.select("artifact-1");
    workspace.edit("<p>jeg skriver</p>");
    workspace.replace(
      [artifact(), { ...artifact(), id: "artifact-2", latest: { ...artifact().latest, id: "v2" } }],
      "c1",
    );
    expect(workspace.unseen).toBe("artifact-2");

    // Another conversation's artifacts. The badge would otherwise go on pointing
    // at an artifact this list does not hold (§13).
    workspace.replace([{ ...artifact(), id: "artifact-9" }], "c2");

    expect(workspace.unseen).toBeNull();
  });

  it("follows the first block written of two writes in one turn", () => {
    const workspace = new ArtifactWorkspace();
    workspace.replace([artifact()]);

    // As the server hands it over: most recently written first. So the block the
    // model wrote first is the *last* element, and only the revision's own
    // timestamp says which that is (§13).
    workspace.replace([
      {
        ...artifact(),
        id: "artifact-2",
        latest: { ...artifact().latest, id: "v2", createdAt: new Date(2_000).toISOString() },
      },
      {
        ...artifact(),
        latest: {
          ...artifact().latest,
          id: "version-2",
          revision: 2,
          createdAt: new Date(1_000).toISOString(),
        },
      },
    ]);

    expect(workspace.openId).toBe("artifact-1");
  });

  it("does not take the editor out from under a draft on another artifact", () => {
    const workspace = new ArtifactWorkspace();
    workspace.replace([artifact()]);
    workspace.select("artifact-1");
    workspace.edit("<p>jeg skriver</p>");

    workspace.replace([
      artifact(),
      { ...artifact(), id: "artifact-2", latest: { ...artifact().latest, id: "v2" } },
    ]);

    expect(workspace.openId).toBe("artifact-1");
    expect(workspace.source).toBe("<p>jeg skriver</p>");
    // But the pupil is told, so a conversation-only workspace is not a silent one.
    expect(workspace.unseen).toBe("artifact-2");
  });

  it("leaves the build surface behind with the thread the pupil left", () => {
    const workspace = new ArtifactWorkspace();
    workspace.replace([artifact()], "c1");
    workspace.select("artifact-1");
    expect(workspace.stage).toBe("both");

    workspace.replace([], "c2");

    // The artifacts it was showing belong to the conversation that is gone, so a
    // split carried across the switch is a blank pane beside a new thread (§13).
    expect(workspace.stage).toBe("chat");
  });

  it("does not close the build surface when the first conversation is minted", () => {
    const workspace = new ArtifactWorkspace();
    // A first visit has no conversation until the first send makes one, so the
    // page hydrates on null and the same thread arrives named a moment later.
    workspace.replace([], null);
    workspace.setStage("build");

    workspace.replace([artifact()], "c1");

    expect(workspace.stage).toBe("build");
  });

  it("never follows the pupil's own save", () => {
    const workspace = new ArtifactWorkspace();
    workspace.replace([artifact()]);

    workspace.replace([
      {
        ...artifact(),
        latest: { ...artifact().latest, id: "version-2", revision: 2, authoredBy: "student" },
      },
    ]);

    expect(workspace.visible).toBe(false);
  });
});

describe("choosing an artifact", () => {
  it("keeps the pupil's unsaved edit when they pick the one already open", () => {
    const workspace = new ArtifactWorkspace();
    workspace.replace([artifact()], "c1");
    workspace.select("artifact-1");
    workspace.edit("<button>Klik mig</button>");

    // The Builds index lists the artifact the pupil is already on, and tapping
    // that row used to throw their work away without saying so (§13).
    workspace.select("artifact-1");

    expect(workspace.source).toBe("<button>Klik mig</button>");
    expect(workspace.dirty).toBe(true);
  });

  it("clears the draft the model's own revision supersedes", () => {
    const workspace = new ArtifactWorkspace();
    workspace.replace([artifact()], "c1");
    workspace.select("artifact-1");
    workspace.edit("<button>Klik mig</button>");

    workspace.replace(
      [
        {
          ...artifact(),
          latest: {
            ...artifact().latest,
            id: "version-2",
            revision: 2,
            source: "<h1>Nyt</h1>",
            files: { "index.html": "<h1>Nyt</h1>" },
          },
        },
      ],
      "c1",
    );

    // The revision it was based on is gone, so the draft goes with it.
    expect(workspace.drafts).toEqual({});
    expect(workspace.running?.files).toEqual({ "index.html": "<h1>Nyt</h1>" });
  });

  it("starts a different artifact from scratch", () => {
    const workspace = new ArtifactWorkspace();
    workspace.replace([artifact(), { ...artifact(), id: "artifact-2" }], "c1");
    workspace.select("artifact-1");
    workspace.edit("<button>Klik mig</button>");

    workspace.select("artifact-2");

    expect(workspace.openId).toBe("artifact-2");
    expect(workspace.drafts).toEqual({});
  });
});

describe("what the artifact printed", () => {
  const line = (text: string) => ({ level: "log" as const, text });

  it("says nothing was dropped when nothing was", () => {
    const workspace = new ArtifactWorkspace();

    workspace.appendConsole(Array.from({ length: CONSOLE_KEPT }, (_, at) => line(`linje ${at}`)));

    // Exactly the number kept is exactly the number printed: telling a pupil
    // their earlier output is gone sends them looking for something to fix.
    expect(workspace.consoleLines).toHaveLength(CONSOLE_KEPT);
    expect(workspace.consoleTruncated).toBe(false);
  });

  it("says so once a line has actually gone", () => {
    const workspace = new ArtifactWorkspace();

    workspace.appendConsole(
      Array.from({ length: CONSOLE_KEPT + 1 }, (_, at) => line(`linje ${at}`)),
    );

    expect(workspace.consoleLines).toHaveLength(CONSOLE_KEPT);
    expect(workspace.consoleTruncated).toBe(true);
    // The newest are the useful ones (§13).
    expect(workspace.consoleLines[CONSOLE_KEPT - 1].text).toBe(`linje ${CONSOLE_KEPT}`);
  });
});
