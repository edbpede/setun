import { describe, expect, it } from "bun:test";
import { type FollowCandidate, followModelWrite } from "./follow";

function item(id: string, versionId: string, authoredBy: "model" | "student"): FollowCandidate {
  return { id, latest: { id: versionId, authoredBy } };
}

describe("followModelWrite", () => {
  it("follows a newly written artifact", () => {
    const previous = [item("a", "v1", "model")];
    const next = [item("b", "v1", "model"), item("a", "v1", "model")];

    expect(followModelWrite(previous, next)).toBe("b");
  });

  it("follows a revision of an artifact that already existed", () => {
    expect(followModelWrite([item("a", "v1", "model")], [item("a", "v2", "model")])).toBe("a");
  });

  it("follows nothing when nothing changed", () => {
    const list = [item("a", "v1", "model"), item("b", "v3", "student")];

    expect(followModelWrite(list, list)).toBeNull();
  });

  it("never follows the pupil's own revision", () => {
    expect(followModelWrite([item("a", "v1", "model")], [item("a", "v2", "student")])).toBeNull();
  });

  it("follows nothing on the first hydration", () => {
    expect(followModelWrite([], [item("a", "v1", "model")])).toBeNull();
  });

  it("takes the first of two writes in one message, which is recording order", () => {
    const next = [item("a", "v2", "model"), item("b", "v1", "model")];

    expect(followModelWrite([item("a", "v1", "model")], next)).toBe("a");
  });
});
