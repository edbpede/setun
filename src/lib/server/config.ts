import * as v from "valibot";
import { env } from "$env/dynamic/private";

/**
 * Required environment, validated at boot (PRD §6.2).
 *
 * "Absence of a required variable fails boot with a clear message rather than
 * starting degraded."
 *
 * Read through `$env/dynamic/private` rather than `process.env`: the module is
 * server-only by construction, so a component importing this is a build error
 * rather than a leaked secret.
 *
 * Validation is lazy and cached rather than performed at import time, so
 * importing a server module in a test does not require a populated environment.
 */

const nonEmpty = (description: string) =>
  v.pipe(v.string(description), v.trim(), v.minLength(1, description));

const ConfigSchema = v.object({
  /** Pepper for the student-code HMAC. Changing it invalidates every code (§7). */
  studentCodePepper: nonEmpty("SETUN_STUDENT_CODE_PEPPER is required"),
  /** Shared with CPA; the only thing authenticating the gateway (§9). */
  cpaListenerKey: nonEmpty("SETUN_CPA_LISTENER_KEY is required"),
  cpaBaseUrl: v.pipe(nonEmpty("SETUN_CPA_BASE_URL is required"), v.url()),
  appOrigin: v.pipe(nonEmpty("SETUN_APP_ORIGIN is required"), v.url()),
  /** A distinct host from the app origin — artifacts are isolated by origin (§14). */
  sandboxOrigin: v.pipe(nonEmpty("SETUN_SANDBOX_ORIGIN is required"), v.url()),
  databasePath: nonEmpty("SETUN_DATABASE_PATH is required"),
});

export type ServerConfig = v.InferOutput<typeof ConfigSchema>;

export class ConfigurationError extends Error {
  constructor(issues: string[]) {
    super(
      `Setun cannot start — invalid configuration:\n${issues.map((i) => `  - ${i}`).join("\n")}`,
    );
    this.name = "ConfigurationError";
  }
}

/** Development defaults exist only for values with no security meaning. */
function readEnvironment() {
  return {
    studentCodePepper: env.SETUN_STUDENT_CODE_PEPPER,
    cpaListenerKey: env.SETUN_CPA_LISTENER_KEY,
    cpaBaseUrl: env.SETUN_CPA_BASE_URL ?? "http://localhost:8317",
    appOrigin: env.SETUN_APP_ORIGIN ?? "http://localhost:5173",
    sandboxOrigin: env.SETUN_SANDBOX_ORIGIN ?? "http://localhost:5174",
    databasePath: env.SETUN_DATABASE_PATH ?? "./data/setun.sqlite",
  };
}

/**
 * Validate the environment, listing every problem at once.
 *
 * One variable at a time would mean an operator fixes one, restarts, and
 * discovers the next; §6.2 asks for a clear failure, not a scavenger hunt.
 */
export function validateConfig(raw: Record<string, unknown> = readEnvironment()): ServerConfig {
  const result = v.safeParse(ConfigSchema, raw);
  if (result.success) return result.output;

  const issues = result.issues.map((issue) => {
    const path = issue.path?.map((segment) => String(segment.key)).join(".") ?? "config";
    return `${path}: ${issue.message}`;
  });
  throw new ConfigurationError(issues);
}

let cached: ServerConfig | null = null;

/** The validated configuration. Throws on first access if the environment is incomplete. */
export function getConfig(): ServerConfig {
  cached ??= validateConfig();
  return cached;
}
