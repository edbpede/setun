/** Shared policy and cryptography for the single educator credential. */

export const EDUCATOR_USERNAME_MAX_LENGTH = 200;
export const EDUCATOR_PASSWORD_MIN_LENGTH = 12;
export const EDUCATOR_PASSWORD_MAX_LENGTH = 1_000;

/** Argon2id is the only password-storage path used by Setun. */
export function hashEducatorPassword(password: string): Promise<string> {
  return Bun.password.hash(password, { algorithm: "argon2id" });
}

function configuredSeedValue(input: { username: string; password: string }): string {
  return `setun-educator-seed-v1:${JSON.stringify([input.username, input.password])}`;
}

/**
 * Remember a deployment seed without storing either field in recoverable form.
 *
 * Recovery records this hash so an unchanged seed cannot overwrite the new
 * credential at the next boot. Argon2id is intentional here too: a database
 * copy must not turn a weak legacy seed password into a cheap offline target.
 */
export function hashConfiguredEducatorSeed(input: {
  username: string;
  password: string;
}): Promise<string> {
  return Bun.password.hash(configuredSeedValue(input), { algorithm: "argon2id" });
}

export async function matchesConfiguredEducatorSeed(
  input: { username: string; password: string },
  hash: string,
): Promise<boolean> {
  try {
    return await Bun.password.verify(configuredSeedValue(input), hash);
  } catch {
    // A malformed marker must never make the installation unbootable. Treat it
    // as stale and let the configured seed repair the credential normally.
    return false;
  }
}
