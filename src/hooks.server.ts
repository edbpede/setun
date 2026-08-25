import type { Handle, HandleServerError } from "@sveltejs/kit";
import { sequence } from "@sveltejs/kit/hooks";
import { cookieName, getTextDirection } from "$lib/paraglide/runtime";
import { paraglideMiddleware } from "$lib/paraglide/server";
import { resolveEducatorSession } from "$lib/server/auth/educator";
import {
  EDUCATOR_SESSION_COOKIE_NAME,
  resolveStudentSession,
  SESSION_COOKIE_NAME,
} from "$lib/server/auth/sessions";
import { getDb } from "$lib/server/boot";
import { studentInterfaceLanguage } from "$lib/server/classroom/settings";
import { describeCause, log } from "$lib/server/logging";

/**
 * Resolve the session cookie into request-scoped state (PRD §7).
 *
 * Request state lives on `event.locals`, typed in `app.d.ts` — never at module
 * scope in a server module, where it would leak between users.
 *
 * A cookie that no longer resolves (expired, invalidated by rotation or
 * force-logout, or belonging to a disabled student) is cleared here, so a stale
 * browser stops presenting it rather than retrying every request.
 */
const handleSession: Handle = async ({ event, resolve }) => {
  const db = getDb();

  event.locals.student = null;
  event.locals.educator = null;
  event.locals.sessionToken = null;

  const token = event.cookies.get(SESSION_COOKIE_NAME);
  if (token) {
    const resolved = resolveStudentSession(db, token);
    if (resolved) {
      event.locals.student = resolved.student;
      event.locals.sessionToken = token;
    } else {
      event.cookies.delete(SESSION_COOKIE_NAME, { path: "/" });
    }
  }

  // Resolved independently of the student session: the two namespaces are
  // separate, and an educator signing in must not disturb a pupil's session on
  // the same machine (§7, §21).
  const educatorToken = event.cookies.get(EDUCATOR_SESSION_COOKIE_NAME);
  if (educatorToken) {
    const educator = resolveEducatorSession(db, educatorToken);
    if (educator) {
      event.locals.educator = educator;
    } else {
      event.cookies.delete(EDUCATOR_SESSION_COOKIE_NAME, { path: "/" });
    }
  }

  return resolve(event);
};

/**
 * Interface language (PRD §8, §18).
 *
 * "Interface language is a classroom setting… and each student may override it
 * for themselves… The educator panel follows the educator's own preference."
 *
 * So a signed-in pupil's locale comes from their record and their classroom, and
 * everyone else keeps whatever Paraglide would have resolved on its own. The
 * preference is delivered by rewriting the request's own locale cookie rather
 * than by a global override: `paraglideMiddleware` then resolves it through its
 * configured cookie strategy, per request, with nothing shared between
 * concurrent server renders.
 *
 * This runs after `handleSession` because it needs the resolved student.
 */
const handleLocale: Handle = ({ event, resolve }) => {
  const student = event.locals.student;
  const preferred = student ? studentInterfaceLanguage(getDb(), student) : null;

  const request = preferred ? withLocaleCookie(event.request, preferred) : event.request;
  event.request = request;

  return paraglideMiddleware(request, ({ request: localised, locale }) => {
    event.request = localised;

    return resolve(event, {
      transformPageChunk: ({ html }) =>
        html
          .replace("%paraglide.lang%", locale)
          .replace("%paraglide.dir%", getTextDirection(locale)),
    });
  });
};

/**
 * A copy of the request whose locale cookie says `locale`.
 *
 * Headers on a `Request` are immutable, so the header is rebuilt rather than
 * mutated. Only the locale cookie is replaced; every other cookie — the session
 * cookies above among them — travels untouched.
 */
function withLocaleCookie(request: Request, locale: string): Request {
  const existing = request.headers.get("cookie") ?? "";
  const others = existing
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.length > 0 && !part.startsWith(`${cookieName}=`));

  const headers = new Headers(request.headers);
  headers.set("cookie", [...others, `${cookieName}=${locale}`].join("; "));

  return new Request(request, { headers });
}

export const handle: Handle = sequence(handleSession, handleLocale);

/**
 * What an unexpected failure tells the browser, and what it tells the log
 * (PRD §16, §21).
 *
 * "Production errors expose no stack traces or infrastructure detail" (§21), and
 * `App.Error` is `{ message: string }` for exactly that reason: the shape has no
 * field a detail could travel in even by accident.
 *
 * The operator side gets the route, the request id SvelteKit generated, and one
 * redacted line describing the failure — never a stack, and never a body, which
 * on this application would be somebody's prompt (§16).
 */
export const handleError: HandleServerError = ({ error, event, status, message }) => {
  // Expected HTTP outcomes — a 404 from `error()`, a guard's refusal — are not
  // faults and do not deserve an operator line each.
  if (status !== 500) return { message };

  log.error("request failed", {
    route: event.route.id,
    method: event.request.method,
    cause: describeCause(error),
  });

  // Deliberately not `message`: SvelteKit's default for a 500 is already
  // generic, and restating it here means a future change upstream cannot start
  // leaking through this hook.
  return { message: "Internal Error" };
};
