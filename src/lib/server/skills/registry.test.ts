import { describe, expect, it } from "bun:test";
import { buildSystemPrompt } from "../agent/system-prompt";
import { createSkill, grantSkill, revokeSkill, updateSkill } from "../db/queries/skills";
import { createStudent } from "../db/queries/students";
import { createTestDatabase, seedTestFixtures } from "../db/testing";
import { LOAD_SKILL_TOOL, loadSkill, resolveSkills, skillIndexEntries } from "./registry";

/**
 * Skill resolution, the prompt index and the load tool
 * (plan 3.7, 3.8, 3.9, PRD §12, §21, §22).
 *
 * Two of these are §22 security tests: a disabled skill must be absent from the
 * prompt *and* refused by the load tool, and one student's skills must not reach
 * another's conversations. Both are asserted against the resolution itself,
 * because that is the single place either could go wrong.
 */

function fixtures() {
  const db = createTestDatabase();
  const base = seedTestFixtures(db);
  const other = createStudent(db, {
    classroomId: base.classroom.id,
    label: "keen-lynx",
    credentialDigest: crypto.randomUUID(),
    credentialHint: "WXYZ",
  });

  return { db, ...base, other };
}

function resolveFor(
  db: ReturnType<typeof createTestDatabase>,
  classroomId: string,
  studentId: string,
  authoringPolicy: "immediate" | "pre-approval" | "disabled" = "immediate",
) {
  return resolveSkills(db, { classroomId, studentId, authoringPolicy });
}

describe("library skill enablement (§12)", () => {
  it("resolves a skill enabled and granted to the whole class", () => {
    const { db, classroom, student } = fixtures();
    const written = createSkill(db, {
      origin: "panel",
      name: "danskstil",
      description: "Sådan skriver du en dansk stil",
      body: "Start med en indledning.",
      enabled: true,
    });
    grantSkill(db, { classroomId: classroom.id, skillId: written.id });

    const resolved = resolveFor(db, classroom.id, student.id);
    expect(resolved.skills.map((skill) => skill.name)).toEqual(["danskstil"]);
  });

  it("keeps a skill granted to one student away from another (§12)", () => {
    const { db, classroom, student, other } = fixtures();
    const written = createSkill(db, {
      origin: "panel",
      name: "ekstra-hjaelp",
      description: "Ekstra stilladsering",
      body: "Forklar hvert trin.",
      enabled: true,
    });
    grantSkill(db, { classroomId: classroom.id, skillId: written.id, studentId: student.id });

    expect(resolveFor(db, classroom.id, student.id).skills).toHaveLength(1);
    expect(resolveFor(db, classroom.id, other.id).skills).toHaveLength(0);
  });

  it("drops a skill once the grant is revoked", () => {
    const { db, classroom, student } = fixtures();
    const written = createSkill(db, {
      origin: "panel",
      name: "danskstil",
      description: "d",
      body: "b",
      enabled: true,
    });
    grantSkill(db, { classroomId: classroom.id, skillId: written.id });
    revokeSkill(db, { classroomId: classroom.id, skillId: written.id });

    expect(resolveFor(db, classroom.id, student.id).skills).toHaveLength(0);
  });

  it("never resolves a skill that arrived disabled, however it was granted (§12, §21)", () => {
    const { db, classroom, student } = fixtures();
    // Uploaded and imported text arrives disabled, by the column default.
    const uploaded = createSkill(db, {
      origin: "upload",
      name: "importeret",
      description: "Fra en fil",
      body: "Gør sådan her.",
    });
    grantSkill(db, { classroomId: classroom.id, skillId: uploaded.id });

    const resolved = resolveFor(db, classroom.id, student.id);
    expect(resolved.skills).toHaveLength(0);

    // Absent from the prompt…
    expect(buildSystemPrompt({ skillIndex: skillIndexEntries(resolved) })).not.toContain(
      "importeret",
    );
    // …and refused by the load tool, which reads the same resolution (§22).
    const loaded = loadSkill(resolved, "importeret");
    expect(loaded.ok).toBe(false);
    expect(loaded.text).not.toContain("Gør sådan her.");

    // And it works the moment the educator switches it on.
    updateSkill(db, { skillId: uploaded.id, enabled: true });
    expect(resolveFor(db, classroom.id, student.id).skills).toHaveLength(1);
  });
});

describe("student-authored skills (§12, §21)", () => {
  it("applies only to their own conversations", () => {
    const { db, classroom, student, other } = fixtures();
    createSkill(db, {
      origin: "student",
      ownerStudentId: student.id,
      name: "min-stil",
      description: "Min egen stil",
      body: "Svar altid med en analogi.",
      enabled: true,
    });

    expect(resolveFor(db, classroom.id, student.id).skills.map((s) => s.name)).toEqual([
      "min-stil",
    ]);
    // The other pupil's resolution cannot see it, and neither can their loader.
    const otherResolved = resolveFor(db, classroom.id, other.id);
    expect(otherResolved.skills).toHaveLength(0);
    expect(loadSkill(otherResolved, "min-stil").ok).toBe(false);
    expect(loadSkill(otherResolved, "min-stil").text).not.toContain("analogi");
  });

  it("sits inactive while it awaits approval (§12)", () => {
    const { db, classroom, student } = fixtures();
    const written = createSkill(db, {
      origin: "student",
      ownerStudentId: student.id,
      name: "min-stil",
      description: "Min egen stil",
      body: "Svar altid med en analogi.",
      enabled: true,
      approvalState: "pending",
    });

    expect(resolveFor(db, classroom.id, student.id, "pre-approval").skills).toHaveLength(0);

    updateSkill(db, { skillId: written.id, approvalState: "approved" });
    expect(resolveFor(db, classroom.id, student.id, "pre-approval").skills).toHaveLength(1);
  });

  it("stops applying when the classroom turns authoring off entirely (§12)", () => {
    const { db, classroom, student } = fixtures();
    createSkill(db, {
      origin: "student",
      ownerStudentId: student.id,
      name: "min-stil",
      description: "Min egen stil",
      body: "b",
      enabled: true,
    });

    expect(resolveFor(db, classroom.id, student.id, "immediate").skills).toHaveLength(1);
    expect(resolveFor(db, classroom.id, student.id, "disabled").skills).toHaveLength(0);
  });
});

describe("the prompt index and the load tool (§10, §12)", () => {
  it("injects the name and one line, and names the tool that reads the rest", () => {
    const { db, classroom, student } = fixtures();
    const written = createSkill(db, {
      origin: "panel",
      name: "danskstil",
      description: "Sådan skriver du en dansk stil",
      body: "Start med en indledning. Så tre afsnit.",
      enabled: true,
    });
    grantSkill(db, { classroomId: classroom.id, skillId: written.id });

    const resolved = resolveFor(db, classroom.id, student.id);
    const prompt = buildSystemPrompt({ skillIndex: skillIndexEntries(resolved) });

    expect(prompt).toContain("danskstil: Sådan skriver du en dansk stil");
    expect(prompt).toContain(LOAD_SKILL_TOOL);
    // The body costs nothing until it is loaded (§12).
    expect(prompt).not.toContain("Start med en indledning.");
  });

  it("returns the body and its bundled resources when loaded by name", () => {
    const { db, classroom, student } = fixtures();
    const written = createSkill(db, {
      origin: "panel",
      name: "danskstil",
      description: "d",
      body: "Start med en indledning.",
      resources: [{ name: "eksempel.md", text: "En god indledning lyder sådan." }],
      enabled: true,
    });
    grantSkill(db, { classroomId: classroom.id, skillId: written.id });

    const loaded = loadSkill(resolveFor(db, classroom.id, student.id), "danskstil");

    expect(loaded.ok).toBe(true);
    expect(loaded.text).toContain("Start med en indledning.");
    expect(loaded.text).toContain("En god indledning lyder sådan.");
  });

  it("tells the model what is available when it asks for something that is not", () => {
    const { db, classroom, student } = fixtures();
    const loaded = loadSkill(resolveFor(db, classroom.id, student.id), "findes-ikke");

    expect(loaded.ok).toBe(false);
    expect(loaded.text).toContain("findes-ikke");
  });

  it("appends no skills section when nothing is active", () => {
    const { db, classroom, student } = fixtures();
    const prompt = buildSystemPrompt({
      skillIndex: skillIndexEntries(resolveFor(db, classroom.id, student.id)),
    });

    expect(prompt).not.toContain("Skills available");
  });
});
