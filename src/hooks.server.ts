import type { Handle } from "@sveltejs/kit";
import { sequence } from "@sveltejs/kit/hooks";
import { getTextDirection } from "$lib/paraglide/runtime";
import { paraglideMiddleware } from "$lib/paraglide/server";
import { resolveStudentSession, SESSION_COOKIE_NAME } from "$lib/server/auth/sessions";
import { getDb } from "$lib/server/boot";

const handleParaglide: Handle = ({ event, resolve }) =>
  paraglideMiddleware(event.request, ({ request, locale }) => {
    event.request = request;

    return resolve(event, {
      transformPageChunk: ({ html }) =>
        html
          .replace("%paraglide.lang%", locale)
          .replace("%paraglide.dir%", getTextDirection(locale)),
    });
  });

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
  const token = event.cookies.get(SESSION_COOKIE_NAME);

  event.locals.student = null;
  event.locals.sessionToken = null;

  if (token) {
    const resolved = resolveStudentSession(getDb(), token);
    if (resolved) {
      event.locals.student = resolved.student;
      event.locals.sessionToken = token;
    } else {
      event.cookies.delete(SESSION_COOKIE_NAME, { path: "/" });
    }
  }

  return resolve(event);
};

export const handle: Handle = sequence(handleParaglide, handleSession);
