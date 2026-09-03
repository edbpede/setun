import { describe, expect, it } from "vitest";
import { type ArtifactView, ArtifactWorkspace } from "./artifacts.svelte";

/**
 * The workspace's own state machine (PRD §13, §20, §22).
 *
 * Three stages and one fraction, with no geometry anywhere near them: what is on
 * screen is one value, and whether that is drawn as two columns or a sheet is
 * the shell's business. These assertions are what keep it that way.
 */

function artifact(overrides: Partial<ArtifactView> = {}): ArtifactView {
  return {
    id: "artifact-1",
    language: "html",
    title: "Klikkeren",
    latest: {
      id: "version-1",
      revision: 1,
      source: "<button>Klik</button>",
      authoredBy: "model",
      createdAt: new Date(0).toISOString(),
      ...overrides.latest,
    },
    ...overrides,
  };
}

describe("the workspace stage", () => {
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
    expect(workspace.running).toBe("<button>Klik</button>");
  });

  it("toggles back to the conversation from either build stage", () => {
    const workspace = new ArtifactWorkspace();
    workspace.items = [artifact()];

    workspace.toggle();
    expect(workspace.stage).toBe("both");

    workspace.toggle();
    expect(workspace.stage).toBe("chat");
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
    expect(workspace.draft).toBe("<p>jeg skriver</p>");
    // But the pupil is told, so a conversation-only workspace is not a silent one.
    expect(workspace.unseen).toBe("artifact-2");
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
