/**
 * Composer state (PRD §10, §15, §20).
 *
 * Drafts survive tab discard on the target hardware, so the draft is mirrored to
 * session storage rather than held only in memory (§20).
 *
 * Attachments are held here only as the server's own record of them: the upload
 * happens as the pupil picks the file, so what the composer carries is a list of
 * identifiers the send endpoint will claim, never bytes (§10).
 */

const DRAFT_KEY_PREFIX = "setun:draft:";

/** One uploaded file, as the upload endpoint described it back (§10). */
export interface ComposerAttachment {
  readonly id: string;
  readonly filename: string;
  readonly kind: "image" | "text";
  readonly mediaType: string;
  readonly byteSize: number;
}

/** What pressing send does: write a message, or generate a picture (§15). */
export type ComposerMode = "text" | "image";

export class ComposerState {
  draft = $state("");
  /** Set while editing an existing prompt; the send becomes a sibling (§10). */
  editingMessageId = $state<string | null>(null);
  /** Uploaded and waiting for the message that will carry them (§10). */
  attachments = $state<ComposerAttachment[]>([]);
  /** The composer's explicit image mode, the second trigger path of §15. */
  mode = $state<ComposerMode>("text");
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
    this.attachments = [];
    this.mode = "text";
  }

  /**
   * Rebind to a conversation that did not exist when the pupil started typing.
   *
   * The first message of a visit is composed before there is anything to compose
   * into: the conversation is minted on send, and the draft, the attachments and
   * the image mode all belong to the words already on screen. `attach` would
   * discard every one of them, because it exists for the opposite case — moving
   * to a conversation that has its own draft to restore.
   *
   * The draft follows to the new storage key, so a tab discarded between the
   * mint and the send still comes back with the message in it (§20).
   */
  adopt(conversationId: string): void {
    if (this.#conversationId === conversationId) return;

    const draft = this.draft;
    this.#writeDraft("");
    this.#conversationId = conversationId;
    this.#writeDraft(draft);
  }

  addAttachment(attachment: ComposerAttachment): void {
    this.attachments = [...this.attachments, attachment];
  }

  removeAttachment(attachmentId: string): void {
    this.attachments = this.attachments.filter((file) => file.id !== attachmentId);
  }

  /** Adopt what the server says is still pending — the truth after a reload. */
  setAttachments(attachments: readonly ComposerAttachment[]): void {
    this.attachments = [...attachments];
  }

  toggleMode(): void {
    this.mode = this.mode === "image" ? "text" : "image";
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
    // The identifiers travel with the send; the server claims the rows.
    this.attachments = [];

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
