import { McpError } from "../protocol";

/**
 * Result normalisation across revisions (PRD §11).
 *
 * "Compatibility handling covers the absent result-type field on older
 * results…" — so a content item that arrived without a `type` is read as text
 * here, at the transport edge, and every caller above sees one shape.
 *
 * This module also decides what an elicitation may ask for, because §11 draws
 * two hard lines around it: only the flat primitives, and "nothing resembling a
 * credential prompt is ever displayed".
 */

export type McpContentItem =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "image"; readonly data: string; readonly mediaType: string }
  | { readonly type: "resource"; readonly uri: string; readonly text: string | null };

/** The restricted input types of §11: free text, number, boolean, single choice. */
export type ElicitationFieldType = "text" | "number" | "boolean" | "choice";

export interface ElicitationField {
  readonly name: string;
  readonly label: string;
  readonly type: ElicitationFieldType;
  readonly required: boolean;
  /** Present only for `choice`; the single-choice options (§11). */
  readonly options?: readonly string[];
}

export interface McpElicitation {
  readonly message: string;
  readonly fields: readonly ElicitationField[];
}

export interface McpToolResult {
  readonly content: readonly McpContentItem[];
  readonly isError: boolean;
  readonly structured?: unknown;
  /** Present when the server asked for input before it can finish (§11). */
  readonly elicitation: McpElicitation | null;
}

/**
 * Words that make a prompt a credential prompt.
 *
 * §11 is unconditional: "Nothing resembling a credential prompt is ever
 * displayed." A server that asks for one is refused whole rather than having the
 * offending field quietly removed — a form missing the field the server needed
 * would be answered wrongly, and the student would be none the wiser.
 */
const CREDENTIAL_WORDS = [
  "password",
  "passphrase",
  "secret",
  "token",
  "api key",
  "apikey",
  "api-key",
  "credential",
  "private key",
  "access code",
  "adgangskode",
  "kodeord",
  "login",
  "sign in",
  "otp",
  "2fa",
  "pin code",
];

export class CredentialPromptRefused extends McpError {
  constructor(detail: string) {
    super("invalid-request", detail);
    this.name = "CredentialPromptRefused";
  }
}

function looksLikeCredentialPrompt(text: string): boolean {
  const haystack = text.toLowerCase();
  return CREDENTIAL_WORDS.some((word) => haystack.includes(word));
}

/** Normalise one `tools/call` result, whichever revision produced it. */
export function normaliseToolResult(raw: unknown): McpToolResult {
  const result = (raw ?? {}) as Record<string, unknown>;
  const items = Array.isArray(result.content) ? result.content : [];

  return {
    content: items
      .map(normaliseContentItem)
      .filter((item): item is McpContentItem => item !== null),
    isError: result.isError === true,
    structured: result.structuredContent,
    elicitation: normaliseElicitation(result),
  };
}

/**
 * One content item.
 *
 * The absent `type` of older revisions means text — that is the only shape those
 * revisions could produce without it.
 */
function normaliseContentItem(raw: unknown): McpContentItem | null {
  if (typeof raw === "string") return { type: "text", text: raw };
  if (!raw || typeof raw !== "object") return null;

  const item = raw as Record<string, unknown>;
  const type = typeof item.type === "string" ? item.type : "text";

  switch (type) {
    case "text":
      return { type: "text", text: String(item.text ?? "") };
    case "image":
      return {
        type: "image",
        data: String(item.data ?? ""),
        mediaType: String(item.mimeType ?? item.mediaType ?? "application/octet-stream"),
      };
    case "resource": {
      const resource = (item.resource ?? item) as Record<string, unknown>;
      return {
        type: "resource",
        uri: String(resource.uri ?? ""),
        text: typeof resource.text === "string" ? resource.text : null,
      };
    }
    default:
      // An item type this revision does not model. Dropped rather than guessed
      // at: a half-understood attachment is worse than an absent one.
      return null;
  }
}

/**
 * Read an interim result that is asking the student for input (§11).
 *
 * Both placements are accepted — top level and `_meta` — because that is where
 * the two revisions put it, and the caller should not have to know which
 * answered.
 */
function normaliseElicitation(result: Record<string, unknown>): McpElicitation | null {
  const meta = (result._meta ?? {}) as Record<string, unknown>;
  const raw = (result.elicitation ?? meta.elicitation) as Record<string, unknown> | undefined;
  if (!raw || typeof raw !== "object") return null;

  const message = String(raw.message ?? "");
  const schema = (raw.requestedSchema ?? raw.schema ?? {}) as Record<string, unknown>;
  const properties = (schema.properties ?? {}) as Record<string, unknown>;
  const required = new Set(Array.isArray(schema.required) ? schema.required.map(String) : []);

  if (looksLikeCredentialPrompt(message)) {
    throw new CredentialPromptRefused("elicitation message reads as a credential prompt");
  }

  const fields: ElicitationField[] = [];
  for (const [name, definition] of Object.entries(properties)) {
    const field = normaliseField(name, definition, required.has(name));
    if (!field) continue;

    if (looksLikeCredentialPrompt(`${field.name} ${field.label}`)) {
      throw new CredentialPromptRefused(`elicitation field '${field.name}' asks for a credential`);
    }
    fields.push(field);
  }

  return { message, fields };
}

/** One elicitation field, restricted to the flat primitives of §11. */
function normaliseField(name: string, raw: unknown, required: boolean): ElicitationField | null {
  if (!raw || typeof raw !== "object") return null;

  const definition = raw as Record<string, unknown>;
  const label = String(definition.title ?? definition.description ?? name);

  if (Array.isArray(definition.enum)) {
    return { name, label, type: "choice", required, options: definition.enum.map(String) };
  }

  switch (definition.type) {
    case "string":
      return { name, label, type: "text", required };
    case "number":
    case "integer":
      return { name, label, type: "number", required };
    case "boolean":
      return { name, label, type: "boolean", required };
    default:
      // "nothing richer" (§11): objects, arrays and unions are not offered.
      return null;
  }
}
