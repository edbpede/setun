import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { allowAlias } from "../db/queries/classroom-aliases";
import { createConversation } from "../db/queries/conversations";
import { createAlias } from "../db/queries/model-aliases";
import { createTestDatabase, seedTestFixtures } from "../db/testing";
import { GatewayAdapter } from "../gateway/adapter";
import { streamingResponse, stubFetch } from "../gateway/testing";
import { resolveSkills } from "../skills/registry";
import { FileStore } from "../storage/files";
import { generateImage, generationAliases } from "./image-generation";
import { TurnInteractionRegistry } from "./interactions";
import { runTurn } from "./loop";
import { buildToolSet, GENERATE_IMAGE_TOOL, type ToolContext } from "./tools";

/**
 * Image generation (plan 3.10, PRD §15, §22).
 *
 * §22 asks for both trigger paths, a refusal on an unflagged alias, and the
 * debit. Both triggers converge on `generateImage`, so the agent-loop path is
 * exercised through the real loop and the composer path through the same
 * function the endpoint calls — which is the point §15 is making.
 */

const ROOTS: string[] = [];

function storageRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "setun-images-"));
  ROOTS.push(root);
  return root;
}

afterAll(() => {
  for (const root of ROOTS) rmSync(root, { recursive: true, force: true });
});

/** A one-pixel PNG, base64, as an image endpoint would return it. */
const PIXEL_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

function scene(options: { capable?: boolean } = {}) {
  const db = createTestDatabase();
  const fixtures = seedTestFixtures(db);

  if (options.capable !== false) {
    const painter = createAlias(db, {
      name: `Painter-${crypto.randomUUID().slice(0, 8)}`,
      gatewayModelId: "image-model",
      dialect: "openai",
      supportsImageGeneration: true,
    });
    allowAlias(db, { classroomId: fixtures.classroom.id, modelAliasId: painter.id });
  }

  const gateway = stubFetch((call) => {
    if (call.url.endsWith("/v1/images/generations")) {
      return new Response(JSON.stringify({ data: [{ b64_json: PIXEL_BASE64 }] }), {
        headers: { "content-type": "application/json" },
      });
    }

    // The chat leg: ask for the image tool once, then answer.
    return streamingResponse([
      JSON.stringify({
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call-1",
                  function: {
                    name: GENERATE_IMAGE_TOOL,
                    arguments: JSON.stringify({ prompt: "en kat der koder" }),
                  },
                },
              ],
            },
          },
        ],
      }),
      JSON.stringify({ choices: [], usage: { prompt_tokens: 5, completion_tokens: 1 } }),
      "[DONE]",
    ]);
  });

  const adapter = new GatewayAdapter({
    baseUrl: "http://cpa:8317",
    listenerKey: "k",
    fetch: gateway.fetch,
  });

  return { db, fixtures, adapter, gateway, files: new FileStore(storageRoot()) };
}

function usageRows(db: ReturnType<typeof createTestDatabase>) {
  return db.$client
    .query("SELECT studentId, inputTokens, outputTokens, estimated FROM usage_event")
    .all() as { studentId: string; inputTokens: number; outputTokens: number; estimated: number }[];
}

describe("the composer's explicit image mode (§15)", () => {
  it("generates, stores locally, and debits the fixed token-equivalent", async () => {
    const { db, fixtures, adapter, files } = scene();

    const result = await generateImage({
      db,
      adapter,
      files,
      classroom: fixtures.classroom,
      studentId: fixtures.student.id,
      prompt: "en kat der koder",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Appendix A: 10k tokens per image, panel-editable.
    expect(result.tokensDebited).toBe(10_000);
    expect(result.image.prompt).toBe("en kat der koder");

    // The bytes are on disk under the storage root, not in the database, and no
    // provider URL was recorded anywhere (§15, §21).
    const bytes = await files.read(result.image.storagePath);
    expect(bytes?.byteLength).toBeGreaterThan(0);
    expect(JSON.stringify(result.image)).not.toContain("http");

    const rows = usageRows(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ studentId: fixtures.student.id, outputTokens: 10_000 });
    // A policy figure, not a gateway-reported one (§10, §15).
    expect(rows[0].estimated).toBe(1);
  });

  it("honours a panel-edited token-equivalent", async () => {
    const { db, fixtures, adapter, files } = scene();

    const result = await generateImage({
      db,
      adapter,
      files,
      classroom: { ...fixtures.classroom, imageTokenEquivalent: 25_000 },
      studentId: fixtures.student.id,
      prompt: "en kat",
    });

    expect(result.ok && result.tokensDebited).toBe(25_000);
    expect(usageRows(db)[0].outputTokens).toBe(25_000);
  });

  it("refuses before any gateway call when no alias carries the flag (§15)", async () => {
    const { db, fixtures, adapter, files, gateway } = scene({ capable: false });

    expect(generationAliases(db, fixtures.classroom.id)).toEqual([]);

    const result = await generateImage({
      db,
      adapter,
      files,
      classroom: fixtures.classroom,
      studentId: fixtures.student.id,
      prompt: "en kat",
    });

    expect(result).toEqual({ ok: false, refusal: "no-generation-alias" });
    // Nothing reached CPA, and nothing was debited.
    expect(gateway.calls).toHaveLength(0);
    expect(usageRows(db)).toHaveLength(0);
  });

  it("refuses an alias the classroom may not use, however it was named (§15, §21)", async () => {
    const { db, fixtures, adapter, files, gateway } = scene();

    // Flagged, available — and belonging to no classroom's allowlist.
    const elsewhere = createAlias(db, {
      name: "Elsewhere",
      gatewayModelId: "other-image-model",
      dialect: "openai",
      supportsImageGeneration: true,
    });

    const result = await generateImage({
      db,
      adapter,
      files,
      classroom: fixtures.classroom,
      studentId: fixtures.student.id,
      prompt: "en kat",
      modelAliasId: elsewhere.id,
    });

    expect(result).toEqual({ ok: false, refusal: "alias-not-capable" });
    expect(gateway.calls).toHaveLength(0);
    expect(usageRows(db)).toHaveLength(0);
  });

  it("refuses an allowlisted alias that is not flagged for generation (§15)", async () => {
    const { db, fixtures, adapter, files, gateway } = scene();

    const result = await generateImage({
      db,
      adapter,
      files,
      classroom: fixtures.classroom,
      studentId: fixtures.student.id,
      prompt: "en kat",
      // The fixtures' plain text alias, allowlisted but not generation-capable.
      modelAliasId: fixtures.alias.id,
    });

    expect(result).toEqual({ ok: false, refusal: "alias-not-capable" });
    expect(gateway.calls).toHaveLength(0);
  });
});

describe("the agent-loop trigger (§15)", () => {
  it("generates through the same path and announces the image to the student", async () => {
    const { db, fixtures, adapter, files } = scene();

    const conversation = createConversation(db, {
      studentId: fixtures.student.id,
      modelAliasId: fixtures.alias.id,
    });

    const context: ToolContext = {
      db,
      adapter,
      files,
      mcp: null,
      classroom: fixtures.classroom,
      studentId: fixtures.student.id,
      conversationId: conversation.id,
      skills: resolveSkills(db, {
        classroomId: fixtures.classroom.id,
        studentId: fixtures.student.id,
        authoringPolicy: "immediate",
      }),
    };

    const events = [];
    for await (const event of runTurn({
      adapter,
      dialect: "openai",
      model: "test-model",
      path: [{ role: "user", parts: [{ type: "text", text: "Tegn en kat" }] }],
      tooling: {
        tools: buildToolSet(context),
        context,
        mode: "open",
        turnId: crypto.randomUUID(),
        interactions: new TurnInteractionRegistry(),
      },
    })) {
      events.push(event);
    }

    const generated = events.find((event) => event.type === "image-generated");
    expect(generated).toMatchObject({ prompt: "en kat der koder" });

    // Debited against the same student and classroom as the composer path.
    const rows = usageRows(db);
    expect(rows.some((row) => row.outputTokens === 10_000)).toBe(true);
  });

  it("is not offered at all where no generation-capable alias is allowlisted (§15)", () => {
    const { db, fixtures, adapter, files } = scene({ capable: false });

    const context: ToolContext = {
      db,
      adapter,
      files,
      mcp: null,
      classroom: fixtures.classroom,
      studentId: fixtures.student.id,
      conversationId: crypto.randomUUID(),
      skills: resolveSkills(db, {
        classroomId: fixtures.classroom.id,
        studentId: fixtures.student.id,
        authoringPolicy: "immediate",
      }),
    };

    expect(buildToolSet(context).find(GENERATE_IMAGE_TOOL)).toBeUndefined();
  });
});
