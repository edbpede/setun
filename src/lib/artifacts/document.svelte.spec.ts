import { expect, it } from "vitest";
import { inlineStaticSiblings } from "./document";

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
