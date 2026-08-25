import { describe, expect, it } from "bun:test";
import { describeCause, redactCredentials, redactHeaders } from "./logging";

/**
 * Log hygiene (PRD §16, §21, §22).
 *
 * "Credentials are redacted everywhere, including in gateway headers and error
 * paths" (§16), and "production errors expose no stack traces or infrastructure
 * detail" (§21). Both are properties of what reaches a log line, so they are
 * tested at the function every error path funnels through.
 */

describe("redactCredentials", () => {
  it("removes a bearer token quoted in an upstream body", () => {
    const redacted = redactCredentials(
      'upstream said: 401 {"error":"invalid"} for Authorization: Bearer sk-live-abc123def456',
    );

    expect(redacted).not.toContain("sk-live-abc123def456");
    expect(redacted).toContain("[redacted]");
  });

  it("removes a provider key quoted without a header around it", () => {
    expect(redactCredentials("key sk_test_9f8e7d6c5b4a3210 rejected")).not.toContain(
      "9f8e7d6c5b4a3210",
    );
  });

  it("removes credentials embedded in a URL, which is how a transport failure quotes one", () => {
    const redacted = redactCredentials("connect ECONNREFUSED https://bob:hunter2@mcp.example.org/");

    expect(redacted).not.toContain("hunter2");
    expect(redacted).toContain("https://[redacted]@mcp.example.org/");
  });

  it("leaves ordinary text alone", () => {
    expect(redactCredentials("gateway unavailable after 3 attempts")).toBe(
      "gateway unavailable after 3 attempts",
    );
  });
});

describe("redactHeaders", () => {
  it("replaces sensitive values rather than dropping the header", () => {
    const redacted = redactHeaders(
      new Headers({ authorization: "Bearer sk-abc", "content-type": "application/json" }),
    );

    expect(redacted.authorization).toBe("[redacted]");
    expect(redacted["content-type"]).toBe("application/json");
  });

  it("matches case-insensitively, because a header name is not case sensitive", () => {
    expect(redactHeaders({ "X-Api-Key": "secret-value" })["X-Api-Key"]).toBe("[redacted]");
  });
});

describe("describeCause", () => {
  it("carries the type and message, and never the stack", () => {
    const error = new TypeError("fetch failed");

    const described = describeCause(error);

    expect(described).toBe("TypeError: fetch failed");
    expect(described).not.toContain("at ");
    expect(described).not.toContain(".ts:");
  });

  it("redacts, so an error path cannot become a credential leak", () => {
    expect(
      describeCause(new Error("POST failed, authorization: Bearer sk-abc123def")),
    ).not.toContain("sk-abc123def");
  });

  it("truncates, so an error body quoting a prompt cannot smuggle it into a log (§16)", () => {
    const described = describeCause(new Error("x".repeat(5_000)));

    expect(described.length).toBeLessThan(400);
    expect(described.endsWith("…")).toBe(true);
  });

  it("describes a thrown non-error without throwing itself", () => {
    expect(describeCause({ nope: true })).toBe("[object Object]");
    expect(describeCause(undefined)).toBe("undefined");
  });
});
