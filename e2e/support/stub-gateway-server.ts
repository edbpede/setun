import { startStubGateway } from "./stub-gateway";

/**
 * Runs the stub gateway as a standalone process, so Playwright can manage it as
 * a `webServer` alongside the application.
 */
const port = Number(process.env.SETUN_E2E_GATEWAY_PORT ?? 4175);

const gateway = await startStubGateway({ port, delayMs: 15 });
console.info(`stub gateway listening on ${gateway.url}`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void gateway.close().then(() => process.exit(0));
  });
}
