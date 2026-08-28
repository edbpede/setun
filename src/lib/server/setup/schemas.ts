import * as v from "valibot";
import * as m from "$lib/paraglide/messages";
import { ianaTimezone } from "../classroom/schemas";
import { INTERFACE_LANGUAGES, SESSION_POLICIES } from "../db/schema";

/**
 * Validation for the first-run wizard's forms (PRD §5, §6.2, §7, §8).
 *
 * "Every form action and every API endpoint validates its input through a
 * Valibot schema, no exceptions" (§5) — and that applies with more force here
 * than anywhere, because these are the only forms in Setun that a request
 * reaches before any account exists.
 *
 * Separate from `$lib/server/classroom/schemas` because the audience is
 * different: those are the educator panel's forms, edited by somebody who is
 * already signed in. These belong to a surface that exists for one afternoon and
 * then returns `404` forever. The model alias step is the exception and reuses
 * the panel's `AliasSchema` unchanged — an alias is an alias, and a second
 * definition of it would drift.
 */

/**
 * The bootstrap token as typed.
 *
 * Bounded rather than exact: normalisation strips hyphens, spaces and tabs
 * before the format is checked, so the submitted string is legitimately longer
 * than the canonical one. The upper bound is only there so a huge field cannot
 * make the server normalise a megabyte — the real check is
 * `BootstrapTokenHolder.verify`, and a failure here produces the same opaque
 * `invalid_token` a wrong token does (§21).
 */
export const ClaimSchema = v.object({
  token: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(200)),
});

/** Recovery with the operator credential, once one exists. Shaped like the login form. */
export const RecoverSchema = v.object({
  username: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(200)),
  password: v.pipe(v.string(), v.minLength(1), v.maxLength(1_000)),
});

/**
 * The minimum length of the operator password.
 *
 * Twelve characters, and no composition rules. There is exactly one account, it
 * is argon2id-hashed, and the login path is rate limited on both axes — length
 * is the only knob that meaningfully moves the work an attacker must do, and a
 * rule demanding a symbol mostly produces a password with a symbol on the end.
 */
export const EDUCATOR_PASSWORD_MIN_LENGTH = 12;

/**
 * The operator account, as the wizard collects it.
 *
 * The confirmation field is forwarded so the error lands on the field that is
 * wrong rather than on the form as a whole: this is the one password in Setun
 * that cannot be reset from inside the application, so a typo made twice is
 * worth catching here (§7).
 */
export const SetupEducatorSchema = v.pipe(
  v.object({
    username: v.pipe(
      v.string(),
      v.trim(),
      v.minLength(1, m.validation_username_required()),
      v.maxLength(200),
    ),
    password: v.pipe(
      v.string(),
      v.minLength(EDUCATOR_PASSWORD_MIN_LENGTH, m.validation_password_too_short()),
      v.maxLength(1_000),
    ),
    confirmPassword: v.pipe(v.string(), v.maxLength(1_000)),
  }),
  v.forward(
    v.check((input) => input.password === input.confirmPassword, m.validation_passwords_differ()),
    ["confirmPassword"],
  ),
);

/**
 * The first classroom (§8).
 *
 * Only the settings an educator would regret discovering later: the room's name,
 * its timezone, the language its pupils see, and how long a session lasts.
 * Everything else on a classroom has an Appendix A default that the schema
 * itself supplies, and a panel page that edits it — a wizard that asked for all
 * thirty would be a worse version of that page.
 */
export const SetupClassroomSchema = v.object({
  name: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(120)),
  timezone: v.optional(ianaTimezone, "Europe/Copenhagen"),
  interfaceLanguage: v.optional(v.picklist(INTERFACE_LANGUAGES), "da"),
  sessionPolicy: v.optional(v.picklist(SESSION_POLICIES), "sliding"),
  sessionSlidingDays: v.optional(
    v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(365)),
    14,
  ),
  /**
   * The educator's explicit acknowledgement for a model with no data processing
   * agreement (§16).
   *
   * It lives on this form rather than on the alias form because it is a decision
   * about a *classroom*: "the decision is made deliberately, per classroom, by
   * the person accountable for it". Step 4 is where the alias is granted to the
   * room, so step 4 is where the acknowledgement belongs. The server refuses the
   * grant without it.
   */
  confirmNoDpa: v.optional(v.boolean(), false),
});

/**
 * The gateway step's only input: an explicit decision to carry on.
 *
 * A literal rather than a flag, because there is nothing to be false here — the
 * button that submits it *is* the acknowledgement, and a request without it is a
 * request that did not come from the button. What the acknowledgement means is
 * decided by the server's own probe, not by anything the browser reports about
 * the gateway (§9, §21).
 */
export const GatewayContinueSchema = v.object({
  acknowledged: v.literal("true"),
});
