import { fail, redirect } from "@sveltejs/kit";
import * as v from "valibot";
import { attemptStudentLogin } from "$lib/server/auth/login";
import { SESSION_COOKIE_NAME, STUDENT_SESSION_TTL_DAYS } from "$lib/server/auth/sessions";
import { getDb } from "$lib/server/boot";
import { getConfig } from "$lib/server/config";
import type { Actions, PageServerLoad } from "./$types";

/**
 * Student login (PRD §7).
 *
 * A trivial form, so a plain progressively-enhanced action rather than Superforms
 * (§5) — but still Valibot-validated, because every action validates through a
 * schema without exception (§5).
 *
 * The route is thin by design: it parses, delegates the decision to
 * `$lib/server/auth`, and shapes the response. There is exactly one failure
 * branch here, so there is nothing for the response to disclose (§7, §21).
 */

/** Length is unbounded on purpose: normalisation strips separators before the check. */
const LoginSchema = v.object({
  code: v.pipe(v.string(), v.trim(), v.minLength(1)),
});

export const load: PageServerLoad = ({ locals }) => {
  // Already signed in: nothing to do here.
  if (locals.student) redirect(303, "/chat");
  return {};
};

export const actions: Actions = {
  default: async ({ request, cookies, getClientAddress, url }) => {
    const form = await request.formData();
    const parsed = v.safeParse(LoginSchema, { code: form.get("code") });

    if (!parsed.success) {
      // Same shape as a rejected code: a malformed submission must not be
      // distinguishable from a wrong one (§7).
      return fail(400, { failed: true });
    }

    const result = await attemptStudentLogin(getDb(), {
      code: parsed.output.code,
      ip: getClientAddress(),
      pepper: getConfig().studentCodePepper,
    });

    if (!result.ok) return fail(401, { failed: true });

    // TODO(phase-7): the student first-login introduction begins here — this is
    // the one path that knows a sign-in *just succeeded*, which is what
    // distinguishes "has never seen it" from "is signed in and browsing". The
    // decision (and the redirect target) belongs in
    // `$lib/server/student/onboarding`; `docs/setun-student-onboarding.md` has
    // the intended flow and the open questions. Nothing is wired up yet, and
    // students land on /chat exactly as before.
    cookies.set(SESSION_COOKIE_NAME, result.session.token, {
      path: "/",
      httpOnly: true,
      sameSite: "lax",
      // Host-only and scoped to this path: the sandbox origin is a different
      // host and can never read it (§7, §14, §21).
      secure: url.protocol === "https:",
      maxAge: STUDENT_SESSION_TTL_DAYS * 24 * 60 * 60,
    });

    redirect(303, "/chat");
  },
};
