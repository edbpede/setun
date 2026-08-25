import type { FrameLocator, Page } from "@playwright/test";
import { SANDBOX_ORIGIN } from "../../playwright.config";

/**
 * Put an artifact into the sandbox, from a page on the application origin.
 *
 * The same arrangement the application uses: an iframe pointing at the sandbox
 * hostname, sandboxed to allow scripts but *not* same-origin, driven entirely by
 * message passing (PRD §14). Injecting it from a real, signed-in application
 * page is the point of the escape suite — the session cookie is present, and the
 * artifact still cannot reach it.
 */

export const HOST_FRAME_ID = "e2e-artifact-host";

export async function mountArtifact(
  page: Page,
  input: { language: string; source: string },
): Promise<FrameLocator> {
  await page.evaluate(
    async ({ origin, language, source, id }) => {
      document.getElementById(id)?.remove();

      const frame = document.createElement("iframe");
      frame.id = id;
      frame.src = origin;
      // Scripts, but no same-origin: the frame's document gets an opaque origin.
      frame.setAttribute("sandbox", "allow-scripts");
      frame.style.cssText = "position:fixed;inset:0;width:100%;height:100%;z-index:99999";
      document.body.appendChild(frame);

      await new Promise<void>((resolve) => {
        window.addEventListener("message", function ready(event) {
          if (event.source !== frame.contentWindow) return;
          const data = event.data as { channel?: string; type?: string };
          if (data?.channel !== "setun-artifact" || data.type !== "ready") return;

          window.removeEventListener("message", ready);
          resolve();
        });
      });

      frame.contentWindow?.postMessage(
        { channel: "setun-artifact", type: "render", runId: "e2e", language, source },
        "*",
      );
    },
    { origin: SANDBOX_ORIGIN, language: input.language, source: input.source, id: HOST_FRAME_ID },
  );

  // The runner, and then the artifact's own document one frame further down.
  return page.frameLocator(`#${HOST_FRAME_ID}`).frameLocator("#stage");
}
