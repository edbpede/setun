/**
 * Recognising the database's own refusals (PRD §6.1, §21).
 *
 * Some constraints are the schema stating a rule the panel also has to state in
 * words: an alias name is unique, and an alias that a pupil has actually used
 * cannot simply vanish from under its usage rows. Left unhandled, both surface
 * as a 500 and an operator log line, and the educator sees a button that appears
 * to do nothing at all.
 *
 * Matching on the driver's code rather than the message text: the message names
 * the table and column and is not a stable interface, while the codes are.
 */

/** SQLite's extended result codes, as Bun reports them on a thrown error. */
const UNIQUE = "SQLITE_CONSTRAINT_UNIQUE";
const PRIMARY_KEY = "SQLITE_CONSTRAINT_PRIMARYKEY";
const FOREIGN_KEY = "SQLITE_CONSTRAINT_FOREIGNKEY";

function codeOf(cause: unknown): string {
  if (typeof cause !== "object" || cause === null) return "";
  const code = (cause as { code?: unknown }).code;
  return typeof code === "string" ? code : "";
}

/** A row already exists with the value a unique index protects. */
export function isUniqueViolation(cause: unknown): boolean {
  const code = codeOf(cause);
  return code === UNIQUE || code === PRIMARY_KEY;
}

/** Something still references the row, and the schema declines to orphan it. */
export function isForeignKeyViolation(cause: unknown): boolean {
  return codeOf(cause) === FOREIGN_KEY;
}
