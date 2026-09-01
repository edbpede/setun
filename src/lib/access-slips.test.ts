import { describe, expect, it } from "bun:test";
import {
  ACCESS_SLIPS_PER_PAGE,
  accessSlipFilename,
  accessSlipLoginUrl,
  createQrPath,
  fitTextSize,
  paginateAccessSlips,
  QR_QUIET_ZONE_MODULES,
} from "./access-slips";

const cards = Array.from({ length: 18 }, (_, index) => ({
  label: `pupil-${index}`,
  code: `CODE-${index}`,
  hint: `${index}`,
}));

describe("access slip layout helpers", () => {
  it("paginates into eight slips without dropping a partial page", () => {
    expect(ACCESS_SLIPS_PER_PAGE).toBe(8);
    expect(paginateAccessSlips(cards).map((page) => page.length)).toEqual([8, 8, 2]);
    expect(paginateAccessSlips(cards.slice(0, 1)).map((page) => page.length)).toEqual([1]);
    expect(paginateAccessSlips([])).toEqual([]);
  });

  it("uses code-free, filesystem-safe filenames for both scopes", () => {
    expect(
      accessSlipFilename({ scope: "student", classroomName: "7. B/Øst", nickname: "Mødig Odder" }),
    ).toBe("setun-7-b-ost-modig-odder-access-slip.pdf");
    expect(accessSlipFilename({ scope: "classroom", classroomName: "7. B/Øst" })).toBe(
      "setun-7-b-ost-access-slips.pdf",
    );
    expect(accessSlipFilename({ scope: "student", classroomName: "***" })).toBe(
      "setun-classroom-student-access-slip.pdf",
    );
  });

  it("shrinks long labels and codes but never below the readable floor", () => {
    expect(fitTextSize("short", { maxWidth: 50, preferred: 5, minimum: 2 })).toBe(5);
    expect(
      fitTextSize("an-extraordinarily-long-pseudonymous-label", {
        maxWidth: 40,
        preferred: 5,
        minimum: 2,
      }),
    ).toBeGreaterThanOrEqual(2);
    expect(fitTextSize("x".repeat(200), { maxWidth: 40, preferred: 5, minimum: 2 })).toBe(2);
  });

  it("constructs a fragment-only QR URL", () => {
    const result = accessSlipLoginUrl("https://setun.example.org/base", "AAAA-BBBB");
    const url = new URL(result);
    expect(url.origin + url.pathname).toBe("https://setun.example.org/login");
    expect(url.search).toBe("");
    expect(url.hash).toBe("#code=AAAA-BBBB");
  });

  it("creates a local vector QR path with a four-module quiet zone", () => {
    const qr = createQrPath("https://setun.example.org/login#code=AAAA-BBBB");
    expect(QR_QUIET_ZONE_MODULES).toBe(4);
    expect(qr.path).toMatch(/^M/);
    expect(qr.path).not.toContain("https://");
    expect(qr.size).toBeGreaterThan(QR_QUIET_ZONE_MODULES * 2);
  });
});
