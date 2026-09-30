/**
 * Optional visual comparison: screenshot both pages in the headless browser
 * and count differing pixels. Images are only written to disk when the pages
 * differ visibly (above `visual.ignoreBelowPct`).
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';
import { mkDiff } from './compare.js';

/** Pad a decoded PNG to width x height with white pixels. */
function pad(png, width, height) {
  if (png.width === width && png.height === height) return png.data;
  const out = Buffer.alloc(width * height * 4, 255);
  for (let y = 0; y < Math.min(png.height, height); y++) {
    png.data.copy(out, y * width * 4, y * png.width * 4, y * png.width * 4 + Math.min(png.width, width) * 4);
  }
  return out;
}

export async function compareVisual(pair, fetcher, cfg, assetsDir, index) {
  const shotA = await fetcher.screenshot(pair.recA.finalUrl);
  const shotB = await fetcher.screenshot(pair.recB.finalUrl);
  if (shotA.error || shotB.error) {
    return [mkDiff('visual', 'cosmetic', 'Visual comparison not possible', shotA.error || 'OK', shotB.error || 'OK',
      { note: 'A screenshot could not be taken; the content comparison above still applies.' })];
  }
  const a = PNG.sync.read(shotA.png), b = PNG.sync.read(shotB.png);
  const width = Math.max(a.width, b.width), height = Math.max(a.height, b.height);
  const diff = new PNG({ width, height });
  const changed = pixelmatch(pad(a, width, height), pad(b, width, height), diff.data, width, height,
    { threshold: cfg.visual.pixelThreshold, includeAA: false, alpha: 0.15 });
  const pct = (changed / (width * height)) * 100;
  const out = [];
  const hA = shotA.fullHeight, hB = shotB.fullHeight;
  if (Math.abs(hA - hB) > 50) {
    out.push(mkDiff('visual', Math.abs(hA - hB) / Math.max(hA, hB) > 0.15 ? 'structural' : 'cosmetic', 'Page height differs',
      `${hA}px tall`, `${hB}px tall`));
  }
  if (pct < cfg.visual.ignoreBelowPct) return out;

  await fs.mkdir(assetsDir, { recursive: true });
  const base = `page-${String(index).padStart(3, '0')}`;
  await fs.writeFile(path.join(assetsDir, `${base}-a.png`), shotA.png);
  await fs.writeFile(path.join(assetsDir, `${base}-b.png`), shotB.png);
  await fs.writeFile(path.join(assetsDir, `${base}-diff.png`), PNG.sync.write(diff));
  const rel = (s) => `${path.basename(assetsDir)}/${base}-${s}.png`;
  out.push(mkDiff('visual', pct < cfg.visual.cosmeticBelowPct ? 'cosmetic' : 'structural',
    `Looks different: ${pct.toFixed(1)}% of pixels changed`, null, null, {
      images: { a: rel('a'), b: rel('b'), diff: rel('diff') },
      note: `Compared the top ${Math.min(Math.max(hA, hB), cfg.visual.maxHeight)}px at ${cfg.render.viewport.width}px wide. Red in the overlay marks changed pixels.`,
    }));
  return out;
}
