import * as m from "$lib/paraglide/messages";
import { getLocale } from "$lib/paraglide/runtime";
import type { SetupStep } from "$lib/server/setup/state";

/**
 * The wizard's shared text lookups (PRD §5, §6.2).
 *
 * "All user-facing text flows through Paraglide messages — never string literals
 * in components." Two of the wizard's strings are chosen by a code the server
 * sent rather than by which branch of a template is rendering, so the mapping
 * lives here instead of being repeated in every component that has to make it.
 *
 * A code with no message maps to null rather than to itself: an unrecognised
 * failure code shown verbatim would be an internal identifier on a screen (§21).
 */

const STEP_LABELS: Record<SetupStep, () => string> = {
  educator: m.setup_step_educator,
  gateway: m.setup_step_gateway,
  alias: m.setup_step_alias,
  classroom: m.setup_step_classroom,
  students: m.setup_step_students,
  finish: m.setup_step_finish,
};

export function setupStepLabel(step: SetupStep): string {
  return STEP_LABELS[step]();
}

const ERROR_MESSAGES: Record<string, () => string> = {
  invalid_token: m.setup_error_invalid_token,
  rate_limited: m.setup_error_rate_limited,
  setup_claimed: m.setup_error_setup_claimed,
  claim_lost: m.setup_error_claim_lost,
  invalid_credentials: m.setup_error_invalid_credentials,
  no_educator: m.setup_error_no_educator,
  educator_seeded: m.setup_error_educator_seeded,
  no_dpa_unconfirmed: m.setup_error_no_dpa_unconfirmed,
  incomplete: m.setup_error_incomplete,
  classroom_missing: m.setup_error_classroom_missing,
  alias_missing: m.setup_error_classroom_missing,
  invalid: m.setup_error_invalid,
};

export function setupErrorMessage(code: string | null | undefined): string | null {
  if (!code) return null;
  return ERROR_MESSAGES[code]?.() ?? null;
}

/**
 * One field's error, as a sentence.
 *
 * Two kinds of string reach a Superforms error slot here: a code the route
 * attached to refuse a step, and a schema's own message. The first is looked up;
 * the second is already prose and travels unchanged.
 */
export function setupFieldError(errors: string[] | undefined): string | null {
  const first = errors?.[0];
  if (!first) return null;
  return setupErrorMessage(first) ?? first;
}

/** A claim's lapse time, in the reader's own locale and to the minute. */
export function formatClaimTime(iso: string): string {
  return new Intl.DateTimeFormat(getLocale(), { hour: "2-digit", minute: "2-digit" }).format(
    new Date(iso),
  );
}
