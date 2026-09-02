import { describe, expect, it } from "bun:test";
import { type FollowCandidate, followModelWrite } from "./follow";

function item(
  id: string,
  versionId: string,
  authoredBy: "model" | "student",
  createdAt = "2026-01-01T00:00:00.000Z",
): FollowCandidate {
  return { id, latest: { id: versionId, authoredBy, createdAt } };
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
    // Two lists that are equal without being the same array: an implementation
    // that only compared references would pass with `list, list`.
    const previous = [item("a", "v1", "model"), item("b", "v3", "student")];
    const next = [item("a", "v1", "model"), item("b", "v3", "student")];

    expect(followModelWrite(previous, next)).toBeNull();
  });

  it("never follows the pupil's own revision", () => {
    expect(followModelWrite([item("a", "v1", "model")], [item("a", "v2", "student")])).toBeNull();
  });

  it("follows nothing before anything has been hydrated", () => {
    expect(followModelWrite(null, [item("a", "v1", "model")])).toBeNull();
  });

  it("follows the first artifact of a conversation that had none", () => {
    // Not the same as "not hydrated": this is where the first thing is built.
    expect(followModelWrite([], [item("a", "v1", "model")])).toBe("a");
  });

  it("takes the first of two writes in one message, not the first of the list", () => {
    // The list arrives most-recently-written first, so the block the model wrote
    // first is the *last* element — the revision's own timestamp is what says so.
    const next = [
      item("b", "v1", "model", "2026-01-01T00:00:01.000Z"),
      item("a", "v2", "model", "2026-01-01T00:00:00.500Z"),
    ];

    expect(followModelWrite([item("a", "v1", "model")], next)).toBe("a");
  });

  it("falls to the later element when two writes share a millisecond", () => {
    const next = [item("b", "v1", "model"), item("a", "v2", "model")];

    expect(followModelWrite([item("a", "v1", "model")], next)).toBe("a");
  });
});
