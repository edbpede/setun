import { describe, expect, it } from "bun:test";
import { EventEmitter } from "node:events";
import type { ReadStream, WriteStream } from "node:tty";
import {
  EDUCATOR_PASSWORD_MAX_LENGTH,
  EDUCATOR_PASSWORD_MIN_LENGTH,
  EDUCATOR_USERNAME_MAX_LENGTH,
} from "../src/lib/server/auth/credentials";
import {
  processTerminal,
  runEducatorRecoveryCli,
  type RecoveryCliDependencies,
  type RecoveryTerminal,
} from "./recover-educator";

const PASSWORD = "interactive-password";
const GENERATED_PASSWORD = "G".repeat(43);

class FakeInput extends EventEmitter {
  isTTY = true;
  isRaw = false;

  setRawMode(enabled: boolean): this {
    this.isRaw = enabled;
    return this;
  }

  setEncoding(): this {
    return this;
  }

  resume(): this {
    return this;
  }

  pause(): this {
    return this;
  }
}

class FakeOutput {
  isTTY = true;
  value = "";

  write(value: string): boolean {
    this.value += value;
    return true;
  }
}

function terminal(input: {
  lines?: string[];
  secrets?: string[];
  interactive?: boolean;
} = {}): RecoveryTerminal & { output: string[]; errors: string[]; secretPrompts: string[] } {
  const lines = [...(input.lines ?? [])];
  const secrets = [...(input.secrets ?? [])];
  const output: string[] = [];
  const errors: string[] = [];
  const secretPrompts: string[] = [];

  return {
    interactive: input.interactive ?? true,
    output,
    errors,
    secretPrompts,
    readLine: () => Promise.resolve(lines.shift() ?? ""),
    readSecret: (prompt) => {
      secretPrompts.push(prompt);
      return Promise.resolve(secrets.shift() ?? "");
    },
    writeLine: (value) => output.push(value),
    writeError: (value) => errors.push(value),
  };
}

describe("runEducatorRecoveryCli", () => {
  it("shows help without opening recovery", async () => {
    for (const option of ["--help", "-h"]) {
      const io = terminal({ interactive: false });
      let invoked = false;

      const code = await runEducatorRecoveryCli([option], {
        terminal: io,
        recover: () => {
          invoked = true;
          return Promise.resolve({ invalidatedSessions: 0 });
        },
      });

      expect(code).toBe(0);
      expect(invoked).toBe(false);
      expect(io.output[0]).toBe("Usage: recover-educator [--generate]");
    }
  });

  it("performs an interactive reset with two hidden password prompts", async () => {
    const io = terminal({ lines: ["new-educator"], secrets: [PASSWORD, PASSWORD] });
    let recovered: { username: string; password: string } | undefined;

    const code = await runEducatorRecoveryCli([], {
      terminal: io,
      recover: (input) => {
        recovered = input;
        return Promise.resolve({ invalidatedSessions: 2 });
      },
    });

    expect(code).toBe(0);
    expect(recovered).toEqual({ username: "new-educator", password: PASSWORD });
    expect(io.secretPrompts).toHaveLength(2);
    expect([...io.output, ...io.errors].join("\n")).not.toContain(PASSWORD);
  });

  it("prints an automatically generated password exactly once after success", async () => {
    const io = terminal({ lines: ["new-educator"] });
    let recovered: { username: string; password: string } | undefined;
    const dependencies: RecoveryCliDependencies = {
      terminal: io,
      generatePassword: () => GENERATED_PASSWORD,
      recover: (input) => {
        recovered = input;
        return Promise.resolve({ invalidatedSessions: 0 });
      },
    };

    const code = await runEducatorRecoveryCli(["--generate"], dependencies);
    const output = io.output.join("\n");

    expect(code).toBe(0);
    expect(recovered?.password).toBe(GENERATED_PASSWORD);
    expect(output.split(GENERATED_PASSWORD)).toHaveLength(2);
    expect(io.secretPrompts).toHaveLength(0);
  });

  it("rejects password arguments before invoking recovery", async () => {
    const io = terminal();
    let invoked = false;

    const code = await runEducatorRecoveryCli(["--password", PASSWORD], {
      terminal: io,
      recover: () => {
        invoked = true;
        return Promise.resolve({ invalidatedSessions: 0 });
      },
    });

    expect(code).toBe(2);
    expect(invoked).toBe(false);
  });

  it("rejects invalid usernames before invoking recovery", async () => {
    for (const username of ["", "x".repeat(EDUCATOR_USERNAME_MAX_LENGTH + 1)]) {
      const io = terminal({ lines: [username] });
      let invoked = false;

      const code = await runEducatorRecoveryCli(["--generate"], {
        terminal: io,
        generatePassword: () => GENERATED_PASSWORD,
        recover: () => {
          invoked = true;
          return Promise.resolve({ invalidatedSessions: 0 });
        },
      });

      expect(code).toBe(2);
      expect(invoked).toBe(false);
    }
  });

  it("rejects out-of-range passwords before invoking recovery", async () => {
    for (const password of [
      "x".repeat(EDUCATOR_PASSWORD_MIN_LENGTH - 1),
      "x".repeat(EDUCATOR_PASSWORD_MAX_LENGTH + 1),
    ]) {
      const io = terminal({ lines: ["new-educator"], secrets: [password] });
      let invoked = false;

      const code = await runEducatorRecoveryCli([], {
        terminal: io,
        recover: () => {
          invoked = true;
          return Promise.resolve({ invalidatedSessions: 0 });
        },
      });

      expect(code).toBe(2);
      expect(invoked).toBe(false);
    }
  });

  it("rejects mismatched confirmation before invoking recovery", async () => {
    const io = terminal({
      lines: ["new-educator"],
      secrets: [PASSWORD, "different-password"],
    });
    let invoked = false;

    const code = await runEducatorRecoveryCli([], {
      terminal: io,
      recover: () => {
        invoked = true;
        return Promise.resolve({ invalidatedSessions: 0 });
      },
    });

    expect(code).toBe(2);
    expect(invoked).toBe(false);
    expect(io.errors).toEqual(["Passwords did not match; no changes were made."]);
  });

  it("refuses a non-interactive terminal with a usage exit code", async () => {
    const io = terminal({ interactive: false });

    const code = await runEducatorRecoveryCli([], {
      terminal: io,
      recover: () => Promise.resolve({ invalidatedSessions: 0 }),
    });

    expect(code).toBe(2);
    expect(io.errors).toEqual(["Recovery requires an interactive terminal."]);
  });
});

describe("processTerminal", () => {
  it("discards complete ANSI editing sequences even across chunks", async () => {
    const input = new FakeInput();
    const output = new FakeOutput();
    const terminal = processTerminal(
      input as unknown as ReadStream,
      output as unknown as WriteStream,
      new FakeOutput() as unknown as WriteStream,
    );

    const value = terminal.readLine("Prompt: ");
    input.emit("data", "new");
    input.emit("data", "\u001b");
    input.emit("data", "[D");
    input.emit("data", "-educator\u001b[H\u001bOF\r");

    await expect(value).resolves.toBe("new-educator");
    expect(output.value).not.toContain("[D");
  });
});
