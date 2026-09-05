import { expect, it } from "vitest";
import { inlineStaticSiblings, staticDocument } from "./document";

it("installs runtime setup outside a template containing a head tag", async () => {
  const frame = document.createElement("iframe");
  const loaded = new Promise<void>((resolve) =>
    frame.addEventListener("load", () => resolve(), { once: true }),
  );
  frame.srcdoc = staticDocument({
    language: "html",
    source:
      "<template><head></head></template><p>live</p><script>document.body.dataset.runtime = typeof window.__setunReady;</script>",
    runtimes: { modules: {}, imports: {} },
    runId: "template-test",
  });
  document.body.append(frame);
  try {
    await loaded;
    expect(frame.contentDocument?.body.dataset.runtime).toBe("function");
    expect(
      frame.contentDocument?.head.querySelector('meta[http-equiv="Content-Security-Policy"]'),
    ).not.toBeNull();
  } finally {
    frame.remove();
  }
});

it("runs deferred classic siblings after parsing, in order and before DOMContentLoaded", async () => {
  const frame = document.createElement("iframe");
  const loaded = new Promise<void>((resolve) =>
    frame.addEventListener("load", () => resolve(), { once: true }),
  );
  frame.srcdoc = inlineStaticSiblings(
    '<html><head><script defer src="first.js"></script><script defer src="second.js"></script>' +
      '<script>document.addEventListener("DOMContentLoaded", () => document.body.dataset.events += ",ready");</script>' +
      '</head><body><p id="target">ready</p></body></html>',
    "index.html",
    {
      "first.js":
        'document.body.dataset.events = document.getElementById("target") ? "first" : "early";',
      "second.js": 'document.body.dataset.events += ",second";',
    },
  );
  document.body.append(frame);
  try {
    await loaded;
    expect(frame.contentDocument?.body.dataset.events).toBe("first,second,ready");
  } finally {
    frame.remove();
  }
});
