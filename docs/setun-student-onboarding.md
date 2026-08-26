# Setun — student first-login introduction

**Status:** design note. Scaffolded in Phase 6, not implemented. Deferred in PRD §24.

**What exists today:** a nullable `student.onboardedAt` column that nothing writes, a typed
shape and step union in `src/lib/server/student/onboarding.ts` with no callers, and four
`TODO(phase-7)` anchors — the student login success path, the student dashboard load, the
schema column, and that module. There is no route, no UI, and no behaviour change for a pupil.

This document says what the experience is *for* and what it must contain, so the phase that
builds it starts from a decision rather than from a blank page. It also records the questions
that are genuinely open, rather than answering them by accident.

---

## 1. Why it exists

A pupil's first sign-in is the one moment they are paying attention to what this thing is, and
the only moment Setun gets to say what it does with what they type.

PRD §16 makes that a substantive obligation rather than a nicety. Setun is pseudonymous by
design; the educator can see account state, activity, request and token counts, and allowance
consumption; the educator **cannot** read conversations, because "educators have no interface
for reading student conversations — the pilot deliberately omits one"; and content safety is
provider-level by explicit decision, with no moderation layer of Setun's own.

A pupil who has been told all of that behaves differently from one who assumes their teacher is
reading along — and both are better off than one who never finds out either way. The
introduction is where that gets said, once, in words a thirteen-year-old will read.

**The constraint on the flow itself:** nothing collected here may be personal data. There is no
email field, no real name, no class-list import, and no "tell us about yourself". The one thing
it asks for is an optional display name, which §16 already calls "exactly that" — optional,
changeable, and clearable at any time.

---

## 2. The intended flow

One screen per step, skippable as a whole or not at all — see the open questions.

**Welcome — what Setun is.** A sentence or two: this is a place to talk to AI models, build
small programs and pictures, and try things out; your teacher decided which models and tools are
available and when the class is open. Not a feature list.

**The privacy statement.** The substantive screen, and the reason the rest exists. It must say,
plainly:

- You have no account in the usual sense. No name, no email address, no phone number. The label
  you were given is a made-up word pair, and the code on your card is the whole credential.
- Your teacher can see that you signed in, how much you have used today against your allowance,
  and whether your account is active — nothing more.
- Your teacher **cannot** read your conversations. There is no screen in Setun that shows them,
  deliberately.
- What is stored: your conversations and the things you build, on this school's own server.
- For how long: conversations are deleted automatically after the period your class is set to,
  thirty days by default. The things you build are kept until you delete them — that gallery is
  yours.
- What leaves the server: what you type is sent to the model provider so it can answer. That is
  how any AI model works, and it is why your teacher chose which models this class may use.
- You can delete any conversation or creation yourself, whenever you like.

**Display name.** Optional. Set one, change it later, or clear it — from here or from the
dashboard. Say that it is visible to the teacher, and that the made-up label stays either way.

**Interface language.** Confirm the language, defaulting to the classroom's setting and
overridable per pupil (§8, §18). One control, pre-selected correctly; a pupil who does not care
presses Continue.

**A short tour.** Four things, one line each: chat, the creations gallery, skills, and the
allowance meter that shows how much of today's budget is left. Enough to know the four places
exist; not a manual.

**Classroom instructions, when there are any.** Where the educator has authored classroom
instructions (§10), acknowledge them — the pupil should know their teacher has steered the
model, and roughly how. Skipped entirely when the field is empty.

---

## 3. Open questions

Recorded rather than answered. Each changes the implementation, and each is the educator's
question as much as the implementer's.

**Is it skippable?** A pupil who skips the privacy screen has not been told the thing §16 wants
them told. A pupil who cannot skip it will click through it anyway. Options: unskippable
privacy screen and skippable everything else; a "read it later" link on the dashboard that is
always there; or fully skippable with the statement duplicated on the dashboard.

**Does it re-run after a credential rotation?** A rotated code is the same pupil with a new
card, so arguably not. But a rotation often *is* a new pupil inheriting a machine, and the
`onboardedAt` marker cannot tell the two apart. Rotation is an educator action, so the educator
could be asked at rotation time.

**Is it per-student or per-classroom-configurable?** The granularity principle (§2) says a
classroom toggle with per-student overrides. Against that: an educator who turns the privacy
statement off has turned off the thing §16 asks for, which may not be theirs to turn off. A
narrower toggle — "my class has already had this conversation offline" — might be the honest
shape.

**Where does the retention window come from?** It is per classroom and editable, so the screen
must read it rather than state thirty days. That means the copy needs a parameter, and the
Danish and English messages both need to read naturally with it.

**Does an educator need to see who has completed it?** The roster could show it. That is one
more thing on a dense screen, and it is not obvious what an educator would do with it.

---

## 4. What the implementing phase must not do

- Do not collect anything §16 would call personal data.
- Do not make the privacy statement conditional on a setting without deciding, deliberately and
  in writing, who owns that setting.
- Do not write `student.onboardedAt` from more than one place. It is the derivation for "has
  this pupil seen the introduction", and progress should be derived from persisted state exactly
  as the operator wizard's is — not carried in a session.
- Do not put the copy in components. Every string is a Paraglide message, Danish and English
  complete in the same PR (§5).
