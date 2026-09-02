import { describe, expect, it } from "bun:test";
import { type BuildTarget, buildReportFor } from "./build-report";

const target: BuildTarget = {
  id: "a1",
  latest: { id: "v1", source: "<p>hi</p>", buildStatus: null, buildMessage: null },
};

describe("buildReportFor", () => {
  it("reports a failure of the stored source", () => {
    expect(
      buildReportFor(target, { source: "<p>hi</p>", status: "failed", message: "boom" }),
    ).toEqual({ artifactId: "a1", versionId: "v1", status: "failed", message: "boom" });
  });

  it("reports a success the same way", () => {
    expect(buildReportFor(target, { source: "<p>hi</p>", status: "ok", message: null })).toEqual({
      artifactId: "a1",
      versionId: "v1",
      status: "ok",
      message: null,
    });
  });

  it("reports nothing for a draft the version does not hold", () => {
    expect(
      buildReportFor(target, { source: "<p>udkast</p>", status: "failed", message: "boom" }),
    ).toBeNull();
  });

  it("reports nothing when the status is already what is stored", () => {
    const stored: BuildTarget = {
      id: "a1",
      latest: { id: "v1", source: "<p>hi</p>", buildStatus: "ok", buildMessage: null },
    };

    expect(buildReportFor(stored, { source: "<p>hi</p>", status: "ok", message: null })).toBeNull();
  });

  it("reports a change of status on the same version", () => {
    const stored: BuildTarget = {
      id: "a1",
      latest: { id: "v1", source: "<p>hi</p>", buildStatus: "ok", buildMessage: null },
    };

    expect(
      buildReportFor(stored, { source: "<p>hi</p>", status: "failed", message: "boom" })?.status,
    ).toBe("failed");
  });

  it("reports a page that mounted and then threw over one recorded as ok", () => {
    const stored: BuildTarget = {
      id: "a1",
      latest: { id: "v1", source: "<p>hi</p>", buildStatus: "ok", buildMessage: null },
    };

    // The mount ack recorded `ok`; the click handler threw a moment later. The
    // model has to be told the second thing, or it is told a working page.
    expect(
      buildReportFor(stored, { source: "<p>hi</p>", status: "threw", message: "TypeError" }),
    ).toEqual({ artifactId: "a1", versionId: "v1", status: "threw", message: "TypeError" });
  });

  it("reports nothing when a throw is already what is stored", () => {
    const stored: BuildTarget = {
      id: "a1",
      latest: { id: "v1", source: "<p>hi</p>", buildStatus: "threw", buildMessage: "TypeError" },
    };

    // A rAF loop that throws every frame is one PATCH, not sixty a second.
    expect(
      buildReportFor(stored, { source: "<p>hi</p>", status: "threw", message: "TypeError" }),
    ).toBeNull();
  });

  it("caps the message, which is a prompt line and not a log", () => {
    const report = buildReportFor(target, {
      source: "<p>hi</p>",
      status: "failed",
      message: "x".repeat(5_000),
    });

    expect(report?.message).toHaveLength(2_000);
  });

  it("reports nothing without an open artifact or an outcome", () => {
    expect(buildReportFor(null, { source: "", status: "ok", message: null })).toBeNull();
    expect(buildReportFor(target, null)).toBeNull();
  });
});
