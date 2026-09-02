import { jsPDF } from "jspdf";
import "svg2pdf.js";

/** Render the already-visible SVG pages into a vector PDF in the browser. */
export async function createAccessSlipPdf(pages: readonly SVGSVGElement[]): Promise<Blob> {
  if (pages.length === 0) throw new Error("no access-slip pages");

  const pdf = new jsPDF({
    orientation: "portrait",
    unit: "mm",
    format: "a4",
    compress: true,
    putOnlyUsedFonts: true,
  });
  for (const [index, page] of pages.entries()) {
    if (index > 0) pdf.addPage("a4", "portrait");
    await pdf.svg(page, {
      x: 0,
      y: 0,
      width: 210,
      height: 297,
      loadExternalStyleSheets: false,
      loadImages: false,
    });
  }

  return pdf.output("blob");
}
