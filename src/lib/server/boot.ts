import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { seedEducator } from "./auth/educator";
import { seedDevelopmentData } from "./auth/seed";
import { getConfig } from "./config";
import { type AppDatabase, createDatabase } from "./db/client";
import { applyMigrations } from "./db/migrate";
import { markStreamingTurnsInterrupted } from "./db/queries/turns";
import { GatewayAdapter } from "./gateway/adapter";

/**
 * The composition root (PRD §6, §6.2).
 *
 * The boot sequence, in the order §6 requires: validate the environment, apply
 * migrations *before* the listener accepts anything, then mark turns left
 * in-flight by the previous process as interrupted so resume shows a cut-short
 * notice instead of waiting on a producer that no longer exists (§10).
 *
 * Everything the request path needs is constructed once here and reached
 * through the accessors below — never rebuilt per request, and never mutated.
 */

interface Services {
  readonly db: AppDatabase;
  readonly adapter: GatewayAdapter;
}

let services: Services | null = null;

function boot(): Services {
  // Throws with every missing variable listed, rather than starting degraded (§6.2).
  const config = getConfig();

  if (config.databasePath !== ":memory:") {
    mkdirSync(dirname(config.databasePath), { recursive: true });
  }

  const db = createDatabase(config.databasePath);

  // Before the listener starts: no request may observe an unmigrated schema (§6).
  applyMigrations(db);

  const interrupted = markStreamingTurnsInterrupted(db);
  if (interrupted > 0) {
    console.info(`marked ${interrupted} in-flight turn(s) interrupted after restart`);
  }

  // The operator account, from deployment configuration, on every boot: this is
  // the documented password-recovery path, so it must take effect on a restart
  // and not only on a first boot (§7, §6.2).
  void seedEducator(db, {
    username: config.educatorUsername,
    password: config.educatorPassword,
  }).then((result) => {
    if (result.seeded) console.info(`seeded educator account '${config.educatorUsername}'`);
  });

  // An empty database gets one classroom and one student so M1 is verifiable
  // before the Phase 5 provisioning UI. The code is printed once and never
  // stored (§7); the promise is deliberately not awaited, because boot must not
  // block the listener on it.
  void seedDevelopmentData(db, { pepper: config.studentCodePepper }).then((result) => {
    if (!result.seeded) return;
    console.info(
      [
        "",
        "  Setun seeded an empty database.",
        `  Classroom:   Pilotklasse`,
        `  Student:     ${result.studentLabel}`,
        `  Access code: ${result.accessCode}`,
        "  This code is shown once and is not recoverable.",
        "",
      ].join("\n"),
    );
  });

  return {
    db,
    adapter: new GatewayAdapter({
      baseUrl: config.cpaBaseUrl,
      listenerKey: config.cpaListenerKey,
    }),
  };
}

function getServices(): Services {
  services ??= boot();
  return services;
}

export function getDb(): AppDatabase {
  return getServices().db;
}

export function getGatewayAdapter(): GatewayAdapter {
  return getServices().adapter;
}
