import { expect, it } from "bun:test";
import { encodeArtifactEdit } from "./artifact-edit";

it("does not split an astral character at the title length boundary", () => {
  const encoded = encodeArtifactEdit({
    type: "artifact-edit",
    artifactId: "artifact",
    versionId: "version",
    language: "html",
    title: `${"a".repeat(119)}😀tail`,
    source: "<p>hello</p>",
  });
  expect(encoded.split("\n")[2]).toContain(`"${"a".repeat(119)}😀"`);
  expect(encoded).not.toContain("\\ud83d");
  expect(encoded).not.toContain("tail");
});

it("keeps title metadata on one line and quotes embedded delimiters", () => {
  const encoded = encodeArtifactEdit({
    type: "artifact-edit",
    artifactId: "artifact",
    versionId: "version",
    language: "html",
    title: 'A "title"\nNew line',
    source: "<p>hello</p>",
  });
  expect(encoded.split("\n")[2]).toBe(
    '[The student\'s edited version of the html artifact "A \\"title\\" New line".',
  );
});
