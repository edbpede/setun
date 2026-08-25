/**
 * One printable credential card (PRD §7, §17).
 *
 * Shared between the provisioning route that mints it and the component that
 * prints it, and deliberately not under `$lib/server`: a card is three strings
 * with no server logic in it, and the code inside one exists only for the length
 * of the response that created it. It is never persisted and never logged (§7).
 */
export interface CredentialCard {
  readonly label: string;
  /** Grouped for reading aloud. Shown at provisioning and rotation only (§7). */
  readonly code: string;
  /** The non-secret tail, which the roster also shows so a card can be matched (§7). */
  readonly hint: string;
}
