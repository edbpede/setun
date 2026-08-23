import { StreamingTurn } from "./streaming-turn.svelte";

/**
 * The conversation a student is reading (PRD §10).
 *
 * Holds the active path of the message tree, not the whole tree: the tree lives
 * on the server, and the client renders one branch.
 */

export interface ChatMessage {
  readonly id: string;
  readonly role: "user" | "assistant";
  readonly text: string;
}

export class ConversationState {
  id = $state<string | null>(null);
  title = $state<string | null>(null);
  messages = $state<ChatMessage[]>([]);
  readonly turn = new StreamingTurn();

  constructor(input?: { id: string; title: string | null; messages: ChatMessage[] }) {
    if (input) {
      this.id = input.id;
      this.title = input.title;
      this.messages = input.messages;
    }
  }

  get lastMessage(): ChatMessage | undefined {
    return this.messages.at(-1);
  }

  /** True while a turn is streaming or its text is still on screen unpersisted. */
  get hasPendingAssistantText(): boolean {
    return this.turn.streaming || !this.turn.isEmpty;
  }

  appendUserMessage(text: string): ChatMessage {
    // Optimistic: the server assigns the real id, and the reload after the turn
    // reconciles it. Keyed `{#each}` needs a stable key in the meantime.
    const message: ChatMessage = { id: `pending-${crypto.randomUUID()}`, role: "user", text };
    this.messages = [...this.messages, message];
    return message;
  }

  /** Fold a finished turn's text into the message list. */
  commitAssistantMessage(id: string): void {
    if (this.turn.isEmpty) {
      this.turn.clear();
      return;
    }

    this.messages = [...this.messages, { id, role: "assistant", text: this.turn.text }];
    this.turn.clear();
  }

  replaceMessages(messages: ChatMessage[]): void {
    this.messages = messages;
  }

  /**
   * Drop everything from a message onward.
   *
   * Editing a prompt branches the tree server-side; the client shows the new
   * branch, so the old one leaves the rendered path (§10).
   */
  truncateFrom(messageId: string): void {
    const index = this.messages.findIndex((message) => message.id === messageId);
    if (index >= 0) this.messages = this.messages.slice(0, index);
  }
}
