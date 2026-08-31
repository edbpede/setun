import { existsSync } from "node:fs";
import type { ReadStream, WriteStream } from "node:tty";
import {
  EDUCATOR_PASSWORD_MAX_LENGTH,
  EDUCATOR_PASSWORD_MIN_LENGTH,
  EDUCATOR_USERNAME_MAX_LENGTH,
} from "../src/lib/server/auth/credentials";
import {
  EducatorRecoveryError,
  generateEducatorPassword,
  recoverEducatorCredential,
  type EducatorRecoveryResult,
} from "../src/lib/server/auth/recovery";
import { createDatabase } from "../src/lib/server/db/client";

const EXIT_SUCCESS = 0;
const EXIT_FAILURE = 1;
const EXIT_USAGE = 2;
const EXIT_INTERRUPTED = 130;

export interface RecoveryTerminal {
  readonly interactive: boolean;
  readLine(prompt: string): Promise<string>;
  readSecret(prompt: string): Promise<string>;
  writeLine(value: string): void;
  writeError(value: string): void;
}

export interface RecoveryCliDependencies {
  readonly terminal: RecoveryTerminal;
  readonly recover: (input: { username: string; password: string }) => Promise<EducatorRecoveryResult>;
  readonly generatePassword?: () => string;
}

class InterruptedError extends Error {}

function usage(terminal: RecoveryTerminal): void {
  terminal.writeLine("Usage: recover-educator [--generate]");
  terminal.writeLine("  default      prompt for a new password without terminal echo");
  terminal.writeLine("  --generate   generate a secure password and show it once after success");
}

function validUsername(username: string): boolean {
  return username.length > 0 && username.length <= EDUCATOR_USERNAME_MAX_LENGTH;
}

function validPassword(password: string): boolean {
  return (
    password.length >= EDUCATOR_PASSWORD_MIN_LENGTH &&
    password.length <= EDUCATOR_PASSWORD_MAX_LENGTH
  );
}

/** Drive the user-facing CLI independently of the real terminal and database. */
export async function runEducatorRecoveryCli(
  args: readonly string[],
  dependencies: RecoveryCliDependencies,
): Promise<number> {
  const { terminal } = dependencies;
  const options = args.filter((argument) => argument !== "--");

  if (options.includes("--help") || options.includes("-h")) {
    usage(terminal);
    return EXIT_SUCCESS;
  }
  if (options.some((argument) => argument !== "--generate") || options.length > 1) {
    usage(terminal);
    return EXIT_USAGE;
  }
  if (!terminal.interactive) {
    terminal.writeError("Recovery requires an interactive terminal.");
    return EXIT_USAGE;
  }

  try {
    const username = (await terminal.readLine("New educator username: ")).trim();
    if (!validUsername(username)) {
      terminal.writeError(
        `Username must contain 1 to ${EDUCATOR_USERNAME_MAX_LENGTH} characters.`,
      );
      return EXIT_USAGE;
    }

    const generated = options[0] === "--generate";
    let password: string;

    if (generated) {
      password = (dependencies.generatePassword ?? generateEducatorPassword)();
      if (!validPassword(password)) {
        terminal.writeError("The password generator returned an invalid password.");
        return EXIT_FAILURE;
      }
    } else {
      password = await terminal.readSecret("New password: ");
      if (!validPassword(password)) {
        terminal.writeError(
          `Password must contain ${EDUCATOR_PASSWORD_MIN_LENGTH} to ${EDUCATOR_PASSWORD_MAX_LENGTH} characters.`,
        );
        return EXIT_USAGE;
      }

      const confirmation = await terminal.readSecret("Confirm new password: ");
      if (password !== confirmation) {
        terminal.writeError("Passwords did not match; no changes were made.");
        return EXIT_USAGE;
      }
    }

    const result = await dependencies.recover({ username, password });
    terminal.writeLine(
      `Educator credentials reset; ${result.invalidatedSessions} educator session(s) invalidated.`,
    );

    if (generated) {
      terminal.writeLine("Generated password (shown once):");
      terminal.writeLine(password);
    }

    return EXIT_SUCCESS;
  } catch (error) {
    if (error instanceof InterruptedError) {
      terminal.writeError("Recovery cancelled; no changes were made.");
      return EXIT_INTERRUPTED;
    }
    if (error instanceof EducatorRecoveryError) {
      terminal.writeError(
        error.reason === "no_educator"
          ? "No educator account exists. Complete first-run setup instead."
          : "The educator account state is inconsistent; no changes were made.",
      );
      return EXIT_FAILURE;
    }

    const code =
      typeof error === "object" && error !== null && "code" in error
        ? String(error.code)
        : undefined;
    terminal.writeError(
      code === "SQLITE_BUSY" || code === "SQLITE_LOCKED"
        ? "The database is busy. Try again; no changes were made."
        : "Recovery failed; no credential or session change was committed.",
    );
    return EXIT_FAILURE;
  }
}

function optionalValue(raw: string | undefined): string | undefined {
  const trimmed = raw?.trim();
  return trimmed ? trimmed : undefined;
}

function configuredSeed(environment: NodeJS.ProcessEnv): { username: string; password: string } | undefined {
  const username = optionalValue(environment.SETUN_EDUCATOR_SEED_USERNAME);
  const password = optionalValue(environment.SETUN_EDUCATOR_SEED_PASSWORD);

  if ((username === undefined) !== (password === undefined)) {
    throw new Error("incomplete_seed");
  }
  return username === undefined || password === undefined ? undefined : { username, password };
}

function processTerminal(
  input: ReadStream = process.stdin,
  output: WriteStream = process.stdout,
  error: WriteStream = process.stderr,
): RecoveryTerminal {
  const read = (prompt: string, hidden: boolean): Promise<string> => {
    if (!input.isTTY || !output.isTTY) return Promise.reject(new Error("not_tty"));

    return new Promise((resolve, reject) => {
      let value = "";
      const wasRaw = input.isRaw;
      output.write(prompt);
      input.setRawMode(true);
      input.setEncoding("utf8");
      input.resume();

      const finish = (result?: string, failure?: Error) => {
        input.off("data", onData);
        input.setRawMode(Boolean(wasRaw));
        input.pause();
        output.write("\n");
        if (failure) reject(failure);
        else resolve(result ?? "");
      };

      const onData = (chunk: string | Buffer) => {
        for (const character of String(chunk)) {
          if (character === "\u0003" || character === "\u0004") {
            finish(undefined, new InterruptedError());
            return;
          }
          if (character === "\r" || character === "\n") {
            finish(value);
            return;
          }
          if (character === "\u007f" || character === "\b") {
            const characters = Array.from(value);
            if (characters.length === 0) continue;
            characters.pop();
            value = characters.join("");
            if (!hidden) output.write("\b \b");
            continue;
          }
          if (character >= " ") {
            value += character;
            if (!hidden) output.write(character);
          }
        }
      };

      input.on("data", onData);
    });
  };

  return {
    interactive: Boolean(input.isTTY && output.isTTY),
    readLine: (prompt) => read(prompt, false),
    readSecret: (prompt) => read(prompt, true),
    writeLine: (value) => {
      output.write(`${value}\n`);
    },
    writeError: (value) => {
      error.write(`${value}\n`);
    },
  };
}

async function main(): Promise<number> {
  const terminal = processTerminal();
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    return runEducatorRecoveryCli(args, {
      terminal,
      recover: () => Promise.reject(new Error("help does not open the database")),
    });
  }

  const options = args.filter((argument) => argument !== "--");
  if (
    !terminal.interactive ||
    options.some((argument) => argument !== "--generate") ||
    options.length > 1
  ) {
    return runEducatorRecoveryCli(args, {
      terminal,
      recover: () => Promise.reject(new Error("invalid usage does not open the database")),
    });
  }

  let seed: { username: string; password: string } | undefined;
  try {
    seed = configuredSeed(process.env);
  } catch {
    terminal.writeError(
      "SETUN_EDUCATOR_SEED_USERNAME and SETUN_EDUCATOR_SEED_PASSWORD must be set together.",
    );
    return EXIT_USAGE;
  }

  const databasePath = optionalValue(process.env.SETUN_DATABASE_PATH) ?? "./data/setun.sqlite";
  if (databasePath === ":memory:" || !existsSync(databasePath)) {
    terminal.writeError("The configured Setun database does not exist; no changes were made.");
    return EXIT_FAILURE;
  }

  const db = createDatabase(databasePath);
  try {
    return await runEducatorRecoveryCli(args, {
      terminal,
      recover: (input) => recoverEducatorCredential(db, { ...input, configuredSeed: seed }),
    });
  } finally {
    db.$client.close();
  }
}

if (import.meta.main) process.exitCode = await main();
