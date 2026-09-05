import { describe, expect, it } from "bun:test";
import { type BuildTarget, buildReportFor } from "./build-report";

const target: BuildTarget = {
  id: "a1",
  language: "html",
  latest: {
    id: "v1",
    entry: "index.html",
    files: { "index.html": "<p>hi</p>" },
    buildStatus: null,
    buildMessage: null,
  },
};

describe("buildReportFor", () => {
  it("does not report the same files run from a different entry", () => {
    const files = { "index.html": "<p>home</p>", "other.html": "<p>other</p>" };
    expect(
      buildReportFor(
        { ...target, latest: { ...target.latest, files } },
        { entry: "other.html", files, language: "html", status: "ok", message: null },
      ),
    ).toBeNull();
  });

  it("reports a failure of the stored source", () => {
    expect(
      buildReportFor(target, {
        entry: "index.html",
        files: { "index.html": "<p>hi</p>" },
        language: "html",
        status: "failed",
        message: "boom",
      }),
    ).toEqual({ artifactId: "a1", versionId: "v1", status: "failed", message: "boom" });
  });

  it("reports a success the same way", () => {
    expect(
      buildReportFor(target, {
        entry: "index.html",
        files: { "index.html": "<p>hi</p>" },
        language: "html",
        status: "ok",
        message: null,
      }),
    ).toEqual({
      artifactId: "a1",
      versionId: "v1",
      status: "ok",
      message: null,
    });
  });

  it("reports nothing for a draft the version does not hold", () => {
    expect(
      buildReportFor(target, {
        entry: "index.html",
        files: { "index.html": "<p>udkast</p>" },
        language: "html",
        status: "failed",
        message: "boom",
      }),
    ).toBeNull();
  });

  it("reports nothing when the status is already what is stored", () => {
    const stored: BuildTarget = {
      id: "a1",
      language: "html",
      latest: {
        id: "v1",
        entry: "index.html",
        files: { "index.html": "<p>hi</p>" },
        buildStatus: "ok",
        buildMessage: null,
      },
    };

    expect(
      buildReportFor(stored, {
        entry: "index.html",
        files: { "index.html": "<p>hi</p>" },
        language: "html",
        status: "ok",
        message: null,
      }),
    ).toBeNull();
  });

  it("reports a change of status on the same version", () => {
    const stored: BuildTarget = {
      id: "a1",
      language: "html",
      latest: {
        id: "v1",
        entry: "index.html",
        files: { "index.html": "<p>hi</p>" },
        buildStatus: "ok",
        buildMessage: null,
      },
    };

    expect(
      buildReportFor(stored, {
        entry: "index.html",
        files: { "index.html": "<p>hi</p>" },
        language: "html",
        status: "failed",
        message: "boom",
      })?.status,
    ).toBe("failed");
  });

  it("reports a page that mounted and then threw over one recorded as ok", () => {
    const stored: BuildTarget = {
      id: "a1",
      language: "html",
      latest: {
        id: "v1",
        entry: "index.html",
        files: { "index.html": "<p>hi</p>" },
        buildStatus: "ok",
        buildMessage: null,
      },
    };

    // The mount ack recorded `ok`; the click handler threw a moment later. The
    // model has to be told the second thing, or it is told a working page.
    expect(
      buildReportFor(stored, {
        entry: "index.html",
        files: { "index.html": "<p>hi</p>" },
        language: "html",
        status: "threw",
        message: "TypeError",
      }),
    ).toEqual({ artifactId: "a1", versionId: "v1", status: "threw", message: "TypeError" });
  });

  it("reports nothing when a throw is already what is stored", () => {
    const stored: BuildTarget = {
      id: "a1",
      language: "html",
      latest: {
        id: "v1",
        entry: "index.html",
        files: { "index.html": "<p>hi</p>" },
        buildStatus: "threw",
        buildMessage: "TypeError",
      },
    };

    // A rAF loop that throws every frame is one PATCH, not sixty a second.
    expect(
      buildReportFor(stored, {
        entry: "index.html",
        files: { "index.html": "<p>hi</p>" },
        language: "html",
        status: "threw",
        message: "TypeError",
      }),
    ).toBeNull();
  });

  it("reports nothing while the run's tag is not the one the version holds", () => {
    // A Restore brings back a source the artifact already holds under another
    // tag. The revision recording the new tag is still on its way to the server
    // while the frame is already running it — and without the tag in the
    // identity the html run's result lands on the svelte version it replaced.
    const rewritten: BuildTarget = {
      id: "a1",
      language: "svelte",
      latest: {
        id: "v3",
        entry: "index.html",
        files: { "index.html": "<p>hi</p>" },
        language: "svelte",
        buildStatus: null,
      },
    };

    expect(
      buildReportFor(rewritten, {
        entry: "index.html",
        files: { "index.html": "<p>hi</p>" },
        language: "html",
        status: "failed",
        message: "boom",
      }),
    ).toBeNull();

    // And once the html revision is stored, the same outcome reports onto it.
    const restored: BuildTarget = {
      id: "a1",
      language: "svelte",
      latest: {
        id: "v4",
        entry: "index.html",
        files: { "index.html": "<p>hi</p>" },
        language: "html",
        buildStatus: null,
      },
    };

    expect(
      buildReportFor(restored, {
        entry: "index.html",
        files: { "index.html": "<p>hi</p>" },
        language: "html",
        status: "failed",
        message: "boom",
      })?.versionId,
    ).toBe("v4");
  });

  it("reads a version with no tag of its own as the artifact's own", () => {
    // Every row that predates the column, which must keep reporting as it did.
    expect(
      buildReportFor(target, {
        entry: "index.html",
        files: { "index.html": "<p>hi</p>" },
        language: "html",
        status: "ok",
        message: null,
      })?.versionId,
    ).toBe("v1");
  });

  it("caps the message, which is a prompt line and not a log", () => {
    const report = buildReportFor(target, {
      entry: "index.html",
      files: { "index.html": "<p>hi</p>" },
      language: "html",
      status: "failed",
      message: "x".repeat(5_000),
    });

    expect(report?.message).toHaveLength(2_000);
  });

  it("reports nothing without an open artifact or an outcome", () => {
    expect(
      buildReportFor(null, {
        entry: "index.html",
        files: {},
        language: "html",
        status: "ok",
        message: null,
      }),
    ).toBeNull();
    expect(buildReportFor(target, null)).toBeNull();
  });
});
