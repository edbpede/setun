/**
 * Student first-login introduction — scaffold only (PRD §16, §18).
 *
 * TODO(phase-7): nothing here is implemented, nothing imports it, and nothing
 * writes `student.onboardedAt`. This module exists so the phase that builds the
 * experience has a shape to build against and a column to write, rather than a
 * schema migration landing in the middle of feature work.
 *
 * **What it is for.** A pupil's very first sign-in is the one moment they are
 * paying attention to what this thing is, and the only moment Setun gets to say
 * what it does with what they type. §16 makes that a substantive obligation
 * rather than a nicety: the design is pseudonymous, the educator can see usage
 * and allowance and account state, the educator **cannot** see conversation
 * contents — "educators have no interface for reading student conversations, the
 * pilot deliberately omits one" — and content safety is provider-level by
 * explicit decision. A pupil who learns that on day one behaves differently from
 * one who assumes their teacher is reading along, and both of those are worse
 * than a pupil who was simply told.
 *
 * **The §16 constraint on the flow itself.** Nothing collected here may be
 * personal data. The display-name step is optional, freely changeable and freely
 * clearable, and the record it writes to is the same nullable column §16 already
 * calls "optional display names are exactly that". No email, no real name, no
 * class list import, no "tell us about yourself".
 *
 * The intended flow, the privacy statement in full, and the questions still open
 * are written up in `docs/setun-student-onboarding.md`.
 */

/**
 * The screens the introduction is expected to have, in order.
 *
 * A union rather than an enum so it serialises as itself, matching how every
 * other ordered set in this codebase is typed.
 *
 * TODO(phase-7): the set is a design proposal, not a commitment. `instructions`
 * in particular only appears when the educator has authored classroom
 * instructions, which is the first thing the implementing phase has to decide
 * how to express.
 */
export const STUDENT_ONBOARDING_STEPS = [
  /** What Setun is, in a pupil's words. */
  "welcome",
  /** The §16 statement: what is stored, who sees what, and for how long. */
  "privacy",
  /** Optional display name — set, change or clear, now or never. */
  "display-name",
  /** Confirm the interface language, overriding the classroom default (§8, §18). */
  "language",
  /** A short tour: chat, creations, skills, the allowance meter (§18). */
  "tour",
  /** Acknowledge the educator's classroom instructions, when there are any (§10). */
  "instructions",
] as const;

export type StudentOnboardingStep = (typeof STUDENT_ONBOARDING_STEPS)[number];

/**
 * What the student dashboard and the login success path will need to know.
 *
 * TODO(phase-7): the shape is deliberately minimal — whether to show the
 * introduction at all, and where to resume it. Resume position should be derived
 * from persisted state exactly as the operator wizard's is, so a closed tab costs
 * nothing.
 */
export interface StudentOnboardingState {
  /** False once `student.onboardedAt` is set. */
  readonly required: boolean;
  readonly step: StudentOnboardingStep;
}

/**
 * TODO(phase-7): the resolver that produces the state above belongs here, beside
 * the shape it returns.
 *
 * It is deliberately absent rather than stubbed. A stub returning
 * `required: false` would be a caller-shaped hole that silently disables the
 * introduction if somebody wires it up early — and an absent function is a
 * compile error at the moment the phase starts, which is the correct amount of
 * pressure.
 */
