import QRCode from "qrcode";
import type { CredentialCard } from "$lib/credentials";

export const ACCESS_SLIPS_PER_PAGE = 8;
export const QR_QUIET_ZONE_MODULES = 4;

export type AccessSlipScope = "student" | "classroom";

export interface QrPath {
  readonly path: string;
  readonly size: number;
}

export function paginateAccessSlips<T extends CredentialCard>(cards: readonly T[]): readonly T[][] {
  const pages: T[][] = [];
  for (let index = 0; index < cards.length; index += ACCESS_SLIPS_PER_PAGE) {
    pages.push(cards.slice(index, index + ACCESS_SLIPS_PER_PAGE));
  }
  return pages;
}

function filenamePart(value: string, fallback: string): string {
  const safe = value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/æ/g, "ae")
    .replace(/ø/g, "o")
    .replace(/å/g, "a")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return safe || fallback;
}

export function accessSlipFilename(input: {
  scope: AccessSlipScope;
  classroomName: string;
  nickname?: string;
}): string {
  const classroom = filenamePart(input.classroomName, "classroom");
  if (input.scope === "student") {
    return `setun-${classroom}-${filenamePart(input.nickname ?? "", "student")}-access-slip.pdf`;
  }
  return `setun-${classroom}-access-slips.pdf`;
}

/** A deterministic SVG font-size estimate for the built-in PDF fonts. */
export function fitTextSize(
  text: string,
  input: { maxWidth: number; preferred: number; minimum: number; widthFactor?: number },
): number {
  if (text.length === 0) return input.preferred;
  const widthFactor = input.widthFactor ?? 0.58;
  return Math.max(
    input.minimum,
    Math.min(input.preferred, input.maxWidth / (text.length * widthFactor)),
  );
}

/** The bearer credential is fragment-only, so it never enters an HTTP request. */
export function accessSlipLoginUrl(appOrigin: string, code: string): string {
  const url = new URL("/login", appOrigin);
  url.search = "";
  url.hash = `code=${encodeURIComponent(code)}`;
  return url.toString();
}

/** Build compact horizontal SVG runs from node-qrcode's local module matrix. */
export function createQrPath(payload: string): QrPath {
  const matrix = QRCode.create(payload, { errorCorrectionLevel: "M" }).modules;
  const offset = QR_QUIET_ZONE_MODULES;
  const commands: string[] = [];

  for (let row = 0; row < matrix.size; row++) {
    let start = -1;
    for (let column = 0; column <= matrix.size; column++) {
      const dark = column < matrix.size && matrix.data[row * matrix.size + column] === 1;
      if (dark && start === -1) start = column;
      if (!dark && start !== -1) {
        commands.push(`M${start + offset} ${row + offset}h${column - start}v1h-${column - start}z`);
        start = -1;
      }
    }
  }

  return { path: commands.join(""), size: matrix.size + offset * 2 };
}
