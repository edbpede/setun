import { getWordlist, type WordlistLocale } from "./wordlists";

/**
 * Pseudonymous student labels (PRD §7, §17).
 *
 * A word pair from the shipped localised lists, unique within a classroom. This
 * is the student's whole identity in the interface — there is no name and no
 * email to fall back on (§16).
 */

/**
 * How many random draws before falling back to a numeric suffix.
 *
 * With 2304 combinations and a classroom of tens, a collision is rare; the
 * fallback exists so provisioning cannot fail or loop, however full the list is.
 */
const MAX_RANDOM_ATTEMPTS = 40;

function pick<T>(items: readonly T[]): T {
  return items[Math.floor(Math.random() * items.length)];
}

/**
 * A label not present in `taken`.
 *
 * The caller supplies the classroom's existing labels; uniqueness is also
 * enforced by a composite unique index, so a race loses at the database rather
 * than silently duplicating.
 */
export function generateLabel(
  locale: WordlistLocale,
  taken: ReadonlySet<string> = new Set(),
): string {
  const { adjectives, nouns } = getWordlist(locale);

  for (let attempt = 0; attempt < MAX_RANDOM_ATTEMPTS; attempt++) {
    const candidate = `${pick(adjectives)}-${pick(nouns)}`;
    if (!taken.has(candidate)) return candidate;
  }

  // Exhausted the random draws: walk the space deterministically, then suffix.
  for (const adjective of adjectives) {
    for (const noun of nouns) {
      const candidate = `${adjective}-${noun}`;
      if (!taken.has(candidate)) return candidate;
    }
  }

  let suffix = 2;
  const base = `${pick(adjectives)}-${pick(nouns)}`;
  while (taken.has(`${base}-${suffix}`)) suffix++;
  return `${base}-${suffix}`;
}
