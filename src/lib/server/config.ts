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
  /**
   * The operator account, seeded at first boot. Re-seeding these and restarting
   * is the password-recovery path — there is no in-application reset (§7, §6.2).
   */
  educatorUsername: nonEmpty("SETUN_EDUCATOR_SEED_USERNAME is required"),
  educatorPassword: nonEmpty("SETUN_EDUCATOR_SEED_PASSWORD is required"),
  /** Shared with CPA; the only thing authenticating the gateway (§9). */
  cpaListenerKey: nonEmpty("SETUN_CPA_LISTENER_KEY is required"),
  cpaBaseUrl: v.pipe(nonEmpty("SETUN_CPA_BASE_URL is required"), v.url()),
  appOrigin: v.pipe(nonEmpty("SETUN_APP_ORIGIN is required"), v.url()),
  /** A distinct host from the app origin — artifacts are isolated by origin (§14). */
  sandboxOrigin: v.pipe(nonEmpty("SETUN_SANDBOX_ORIGIN is required"), v.url()),
  databasePath: nonEmpty("SETUN_DATABASE_PATH is required"),
  /**
   * Where attachments and generated images are written (§15, §21).
   *
   * Outside any web root by construction: nothing serves this directory, and
   * every read goes through an owner-scoped endpoint.
   */
  storagePath: nonEmpty("SETUN_STORAGE_PATH is required"),
  /**
   * Where the nightly snapshot job writes (§21, Appendix A).
   *
   * A separate volume from the database in Compose, so a lost database file does
   * not take its own backups with it.
   */
  backupPath: nonEmpty("SETUN_BACKUP_PATH is required"),
  /**
   * The on-disk MCP server configuration, the third operator file of §6.2.
   *
   * Optional: a deployment that uses no tools has no file to point at, and
   * requiring one would fail boot over a feature it does not use (§11).
   */
  mcpConfigPath: v.optional(v.string()),
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
    educatorUsername: env.SETUN_EDUCATOR_SEED_USERNAME,
    educatorPassword: env.SETUN_EDUCATOR_SEED_PASSWORD,
    cpaListenerKey: env.SETUN_CPA_LISTENER_KEY,
    cpaBaseUrl: env.SETUN_CPA_BASE_URL ?? "http://localhost:8317",
    appOrigin: env.SETUN_APP_ORIGIN ?? "http://localhost:5173",
    sandboxOrigin: env.SETUN_SANDBOX_ORIGIN ?? "http://localhost:5174",
    databasePath: env.SETUN_DATABASE_PATH ?? "./data/setun.sqlite",
    storagePath: env.SETUN_STORAGE_PATH ?? "./data/storage",
    backupPath: env.SETUN_BACKUP_PATH ?? "./data/backups",
    mcpConfigPath: env.SETUN_MCP_CONFIG_PATH,
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

/**
 * The raw environment, for the few modules that resolve names out of it.
 *
 * The MCP configuration references credentials *by variable name* (§11), so the
 * name is only known at runtime and cannot be a field on the schema above. This
 * keeps the `$env` import in the one module that already owns it.
 */
export function credentialEnvironment(): Readonly<Record<string, string | undefined>> {
  return env;
}

let cached: ServerConfig | null = null;

/** The validated configuration. Throws on first access if the environment is incomplete. */
export function getConfig(): ServerConfig {
  cached ??= validateConfig();
  return cached;
}
