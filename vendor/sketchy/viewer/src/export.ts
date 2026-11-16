/** Serializes the drawing as a standalone SVG document (fonts included). */
export function toSvgString(svg: SVGSVGElement): string {
  const clone = svg.cloneNode(true) as SVGSVGElement;
  clone.querySelectorAll(".dim").forEach((n) => n.classList.remove("dim"));
  clone.querySelectorAll(".layer-overlay > *").forEach((n) => n.remove());
  clone
    .querySelectorAll("[data-fit], [data-id], [data-kind], [data-pin], [data-signals], [data-href]")
    .forEach((n) => {
      for (const attr of [
        "data-fit",
        "data-id",
        "data-kind",
        "data-pin",
        "data-signals",
        "data-href",
      ])
        n.removeAttribute(attr);
    });
  clone.removeAttribute("class");
  return `<?xml version="1.0" encoding="UTF-8"?>\n${new XMLSerializer().serializeToString(clone)}`;
}

/** Rasterizes the SVG at `scale`× its natural size; returns base64 PNG data. */
export async function toPngBase64(svg: SVGSVGElement, scale = 2): Promise<string> {
  const source = toSvgString(svg);
  const width = Number(svg.getAttribute("width"));
  const height = Number(svg.getAttribute("height"));
  const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(source)}`;
  const image = new Image();
  image.decoding = "sync";
  await new Promise<void>((resolve, reject) => {
    image.onload = () => resolve();
    image.onerror = () => reject(new Error("Could not rasterize the drawing."));
    image.src = url;
  });
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas is not available.");
  ctx.scale(scale, scale);
  ctx.drawImage(image, 0, 0, width, height);
  return canvas.toDataURL("image/png").split(",")[1]!;
}

export function slug(text: string | undefined): string {
  const s = (text ?? "sketch")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/[\s_]+/g, "-")
    .slice(0, 60);
  return s || "sketch";
}
