import { describe, expect, it } from "bun:test";
import {
  runEducatorRecoveryCli,
  type RecoveryCliDependencies,
  type RecoveryTerminal,
} from "./recover-educator";

const PASSWORD = "interactive-password";
const GENERATED_PASSWORD = "G".repeat(43);

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
