import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const here = dirname(fileURLToPath(import.meta.url));
const assetsDir = join(here, "..", "assets");
const badgeSvg = readFileSync(join(assetsDir, "kat-brackets-badge.svg"), "utf8");

const SIZES = [16, 32, 48, 64, 128, 256, 512];

async function main() {
  mkdirSync(assetsDir, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const pngBuffers = new Map();

  try {
    const page = await browser.newPage({
      viewport: { width: 512, height: 512 },
      deviceScaleFactor: 1,
    });

    for (const size of SIZES) {
      await page.setViewportSize({ width: size, height: size });
      await page.setContent(
        `<!doctype html><html><body style="margin:0;padding:0;background:transparent;display:flex;align-items:center;justify-content:center;width:${size}px;height:${size}px;overflow:hidden;">${badgeSvg.replace(
          "<svg ",
          `<svg width="${size}" height="${size}" `,
        )}</body></html>`,
      );
      const buf = await page.screenshot({ type: "png", omitBackground: true });
      pngBuffers.set(size, buf);
      writeFileSync(join(assetsDir, `kat-brackets-${size}.png`), buf);
    }
  } finally {
    await browser.close();
  }

  // Pack 16, 32, 48, 256 PNGs into a standard multi-resolution Windows ICO container.
  const icoSizes = [16, 32, 48, 256];
  const entries = icoSizes.map((s) => ({ size: s, data: pngBuffers.get(s) }));
  const headerSize = 6 + entries.length * 16;
  const totalSize = headerSize + entries.reduce((acc, e) => acc + e.data.length, 0);
  const ico = Buffer.alloc(totalSize);

  ico.writeUInt16LE(0, 0); // Reserved
  ico.writeUInt16LE(1, 2); // Icon type = 1
  ico.writeUInt16LE(entries.length, 4);

  let dataOffset = headerSize;
  entries.forEach((entry, index) => {
    const dirOffset = 6 + index * 16;
    const dim = entry.size >= 256 ? 0 : entry.size;
    ico.writeUInt8(dim, dirOffset); // Width
    ico.writeUInt8(dim, dirOffset + 1); // Height
    ico.writeUInt8(0, dirOffset + 2); // Color palette
    ico.writeUInt8(0, dirOffset + 3); // Reserved
    ico.writeUInt16LE(1, dirOffset + 4); // Color planes
    ico.writeUInt16LE(32, dirOffset + 6); // Bits per pixel
    ico.writeUInt32LE(entry.data.length, dirOffset + 8);
    ico.writeUInt32LE(dataOffset, dirOffset + 12);
    entry.data.copy(ico, dataOffset);
    dataOffset += entry.data.length;
  });

  writeFileSync(join(assetsDir, "kat-brackets.ico"), ico);
  console.log(`Generated ${SIZES.length} Kat-Brackets PNGs + kat-brackets.ico`);
}

await main();
