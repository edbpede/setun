import { describe, expect, it } from "bun:test";
import { GatewayAdapter } from "./adapter";
import { checkGatewayHealth } from "./health";
import { stubFetch } from "./testing";

/**
 * Gateway reachability (plan 2.6, PRD §9, §17, §21).
 *
 * The assertions are as much about what does *not* come back as what does: an
 * unreachable gateway must yield the same two fields as a reachable one, with no
 * status code, upstream URL or error text riding along (§9, §21).
 */

function adapterOver(responder: Parameters<typeof stubFetch>[0]) {
  return new GatewayAdapter({
    baseUrl: "http://cpa:8317",
    listenerKey: "listener-key",
    fetch: stubFetch(responder).fetch,
  });
}

const modelsResponse = (ids: string[]) =>
  new Response(JSON.stringify({ data: ids.map((id) => ({ id })) }), {
    headers: { "content-type": "application/json" },
  });

describe("checkGatewayHealth", () => {
  it("reports the model count from a gateway that answers", async () => {
    const health = await checkGatewayHealth(adapterOver(() => modelsResponse(["a", "b", "c"])));

    expect(health).toEqual({ reachable: true, modelCount: 3 });
  });

  it("reports a reachable gateway serving nothing", async () => {
    const health = await checkGatewayHealth(adapterOver(() => modelsResponse([])));

    expect(health).toEqual({ reachable: true, modelCount: 0 });
  });

  it("reports an unreachable gateway without leaking why (§9, §21)", async () => {
    const health = await checkGatewayHealth(
      adapterOver(() => {
        throw new Error("connect ECONNREFUSED 172.18.0.3:8317");
      }),
    );

    // Two fields, and nothing else — no host, no port, no message.
    expect(health).toEqual({ reachable: false, modelCount: 0 });
    expect(Object.keys(health)).toEqual(["reachable", "modelCount"]);
  });

  it("treats an upstream error status as unreachable rather than throwing", async () => {
    const health = await checkGatewayHealth(
      adapterOver(() => new Response("upstream key rejected", { status: 401 })),
    );

    expect(health).toEqual({ reachable: false, modelCount: 0 });
  });

  it("gives up rather than holding a panel load open on a hanging gateway", async () => {
    const health = await checkGatewayHealth(
      adapterOver(
        () =>
          new Promise<Response>(() => {
            // Never resolves: the gateway accepted the connection and went quiet.
          }),
      ),
      20,
    );

    expect(health).toEqual({ reachable: false, modelCount: 0 });
  });
});
