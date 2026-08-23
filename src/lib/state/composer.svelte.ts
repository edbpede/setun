/**
 * Composer state (PRD §10, §20).
 *
 * Drafts survive tab discard on the target hardware, so the draft is mirrored to
 * session storage rather than held only in memory (§20).
 */

const DRAFT_KEY_PREFIX = "setun:draft:";

export class ComposerState {
  draft = $state("");
  /** Set while editing an existing prompt; the send becomes a sibling (§10). */
  editingMessageId = $state<string | null>(null);
  #conversationId: string | null = null;

  get canSend(): boolean {
    return this.draft.trim().length > 0;
  }

  get isEditing(): boolean {
    return this.editingMessageId !== null;
  }

  /** Bind the composer to a conversation and restore any draft it had. */
  attach(conversationId: string | null): void {
    this.#conversationId = conversationId;
    this.draft = this.#readDraft();
    this.editingMessageId = null;
  }

  setDraft(value: string): void {
    this.draft = value;
    this.#writeDraft(value);
  }

  beginEdit(messageId: string, text: string): void {
    this.editingMessageId = messageId;
    this.setDraft(text);
  }

  cancelEdit(): void {
    this.editingMessageId = null;
    this.setDraft("");
  }

  /** Take the draft for sending and clear it. */
  take(): { text: string; editOfMessageId: string | null } {
    const text = this.draft.trim();
    const editOfMessageId = this.editingMessageId;

    this.editingMessageId = null;
    this.setDraft("");

    return { text, editOfMessageId };
  }

  #storageKey(): string | null {
    return this.#conversationId ? `${DRAFT_KEY_PREFIX}${this.#conversationId}` : null;
  }

  #readDraft(): string {
    const key = this.#storageKey();
    if (!key || typeof sessionStorage === "undefined") return "";
    return sessionStorage.getItem(key) ?? "";
  }

  #writeDraft(value: string): void {
    const key = this.#storageKey();
    if (!key || typeof sessionStorage === "undefined") return;

    if (value.length === 0) sessionStorage.removeItem(key);
    else sessionStorage.setItem(key, value);
  }
}
