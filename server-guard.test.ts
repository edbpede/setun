import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  dropMissingEncodings,
  installServerGuard,
  isRecoverableFileError,
} from "./server-guard.js";

/**
 * A stand-in for `process` that records what was registered and whether the
 * guard tried to exit.
 *
 * The guard must never be installed on the real process here: an
 * `uncaughtException` listener registered by a test outlives the test and
 * changes how the runner reports every later failure.
 */
function stubProcess() {
  const listeners = new Map<string, (value: unknown) => void>();
  const exits: number[] = [];

  return {
    on(event: string, listener: (value: unknown) => void) {
      listeners.set(event, listener);
    },
    exit(code: number) {
      exits.push(code);
    },
    emit(event: string, value: unknown) {
      listeners.get(event)?.(value);
    },
    listeners,
    exits,
  };
}

/** The exact shape Node and Bun produce for a failed `open`. */
function fsError(code: string, syscall = "open", path = "/app/build/client/_app/x.js.br") {
  return Object.assign(new Error(`${code}: no such file or directory, ${syscall} '${path}'`), {
    code,
    syscall,
    path,
    errno: -2,
  });
}

describe("isRecoverableFileError", () => {
  test("accepts a failed read of one named file", () => {
    expect(isRecoverableFileError(fsError("ENOENT"))).toBe(true);
    expect(isRecoverableFileError(fsError("EACCES"))).toBe(true);
    expect(isRecoverableFileError(fsError("EISDIR", "read"))).toBe(true);
  });

  test("rejects resource exhaustion, where restarting is the right answer", () => {
    expect(isRecoverableFileError(fsError("EMFILE"))).toBe(false);
    expect(isRecoverableFileError(fsError("ENOMEM"))).toBe(false);
  });

  test("rejects an error that merely carries a familiar code", () => {
    // No syscall, no path — not a file read, whatever the code says.
    expect(isRecoverableFileError(Object.assign(new Error("nope"), { code: "ENOENT" }))).toBe(
      false,
    );
  });

  test("rejects ordinary faults and non-errors", () => {
    expect(isRecoverableFileError(new TypeError("undefined is not a function"))).toBe(false);
    expect(isRecoverableFileError("ENOENT")).toBe(false);
    expect(isRecoverableFileError(null)).toBe(false);
    expect(isRecoverableFileError(undefined)).toBe(false);
  });
});

describe("installServerGuard", () => {
  test("registers both process-level listeners", () => {
    const target = stubProcess();
    installServerGuard(target as unknown as NodeJS.Process);

    expect([...target.listeners.keys()].sort()).toEqual([
      "uncaughtException",
      "unhandledRejection",
    ]);
  });

  test("a missing static asset does not end the process", () => {
    const target = stubProcess();
    installServerGuard(target as unknown as NodeJS.Process);

    target.emit("uncaughtException", fsError("ENOENT"));
    target.emit("unhandledRejection", fsError("ENOENT"));

    expect(target.exits).toEqual([]);
  });

  test("anything else still exits, as before", () => {
    const target = stubProcess();
    installServerGuard(target as unknown as NodeJS.Process);

    target.emit("uncaughtException", new TypeError("boom"));

    expect(target.exits).toEqual([1]);
  });
});

/**
 * A build directory holding one chunk, its gzip sibling, and deliberately no
 * Brotli sibling — the exact divergence that took the server down.
 */
function clientDir() {
  const root = mkdtempSync(join(tmpdir(), "setun-guard-"));
  const chunks = join(root, "_app", "immutable", "chunks");
  mkdirSync(chunks, { recursive: true });
  writeFileSync(join(chunks, "a.js"), "export const a = 1;");
  writeFileSync(join(chunks, "a.js.gz"), "gz");
  writeFileSync(join(chunks, "both.js"), "export const b = 1;");
  writeFileSync(join(chunks, "both.js.br"), "br");
  writeFileSync(join(chunks, "both.js.gz"), "gz");
  return root;
}

function request(url: string, accept?: string) {
  return { url, headers: accept === undefined ? {} : { "accept-encoding": accept } };
}

describe("dropMissingEncodings", () => {
  const dir = clientDir();

  test("leaves the header alone when every asked-for variant is on disk", () => {
    const req = request("/_app/immutable/chunks/both.js", "br, gzip");
    dropMissingEncodings(req, dir);

    expect(req.headers["accept-encoding"]).toBe("br, gzip");
  });

  test("drops only the encoding whose file is missing", () => {
    const req = request("/_app/immutable/chunks/a.js", "br, gzip");
    dropMissingEncodings(req, dir);

    expect(req.headers["accept-encoding"]).toBe("gzip");
  });

  test("falls back to identity rather than leaving the header empty", () => {
    const req = request("/_app/immutable/chunks/a.js?v=1", "br");
    dropMissingEncodings(req, dir);

    expect(req.headers["accept-encoding"]).toBe("identity");
  });

  test("matches encoding tokens whatever their case", () => {
    // adapter-node's static handler tests Brotli with `/(br|brotli)/i`, so a
    // header spelled `BR` reaches the missing `.br` file unless it is dropped
    // here too.
    const req = request("/_app/immutable/chunks/a.js", "BR");
    dropMissingEncodings(req, dir);

    expect(req.headers["accept-encoding"]).toBe("identity");

    const mixed = request("/_app/immutable/chunks/a.js", "Br;q=1.0, GZip");
    dropMissingEncodings(mixed, dir);

    expect(mixed.headers["accept-encoding"]).toBe("GZip");
  });

  test("ignores requests that are not for build assets", () => {
    const req = request("/chat", "br");
    dropMissingEncodings(req, dir);

    expect(req.headers["accept-encoding"]).toBe("br");
  });

  test("ignores a request that asks for no encoding", () => {
    const req = request("/_app/immutable/chunks/a.js");
    dropMissingEncodings(req, dir);

    expect(req.headers["accept-encoding"]).toBeUndefined();
  });

  test("survives input a client is free to send", () => {
    // `decodeURIComponent` throws on a malformed escape, and this runs inside a
    // `request` listener where an exception would reach nothing at all.
    for (const url of ["/_app/%", "/_app/%zz"]) {
      const req = request(url, "br");
      expect(() => dropMissingEncodings(req, dir)).not.toThrow();
      expect(req.headers["accept-encoding"]).toBe("br");
    }

    // A path with a null byte does not throw either; it simply matches no file,
    // and the request is served uncompressed for the static handler to 404.
    const nul = request("/_app/a\u0000b.js", "br");
    expect(() => dropMissingEncodings(nul, dir)).not.toThrow();
  });

  test("refuses to look outside the build directory", () => {
    const req = request("/_app/../../../../etc/hosts", "br");
    dropMissingEncodings(req, dir);

    expect(req.headers["accept-encoding"]).toBe("br");
  });
});
