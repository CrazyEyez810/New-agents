#!/usr/bin/env node
// Deterministic screenshot harness for the critic pipeline.
// Usage: node tools/screenshot.mjs [shotKey ...] [--out DIR] [--t SECONDS] [--size WxH]
// With no shot keys, captures every preset defined in src/main.js.

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 ? args.splice(i, 2)[1] : dflt;
};
const outDir = path.resolve(root, opt('--out', 'shots'));
const time = opt('--t', '12');
const skip = opt('--skip', '');
const timeoutMs = Number(opt('--timeout', '240')) * 1000;
const [W, H] = opt('--size', '1600x900').split('x').map(Number);
let shots = args.filter((a) => !a.startsWith('--'));
if (shots.length === 0) {
  const src = await readFile(path.join(root, 'src/main.js'), 'utf8');
  const block = src.match(/export const SHOTS = \{([\s\S]*?)\n\};/)?.[1] ?? '';
  shots = [...block.matchAll(/^\s*(\w+):/gm)].map((m) => m[1]);
  if (shots.length === 0) shots = ['street'];
}

// Objective frame metrics so reviews rest on numbers, not impressions.
// Decodes the saved PNG back inside the page and walks its pixels.
async function analyze(page, buf) {
  return page.evaluate(async (b64) => {
    const img = new Image();
    img.src = 'data:image/png;base64,' + b64;
    await img.decode();
    const c = new OffscreenCanvas(img.width, img.height);
    const g = c.getContext('2d');
    g.drawImage(img, 0, 0);
    const { data, width, height } = g.getImageData(0, 0, img.width, img.height);
    let shadow = 0, mid = 0, high = 0, blown = 0, sum = 0, satSum = 0, speckle = 0;
    const hueBins = new Array(12).fill(0);
    const lumaAt = (i) => 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i], gg = data[i + 1], bb = data[i + 2];
      const l = lumaAt(i);
      sum += l;
      if (l < 40) shadow++; else if (l < 180) mid++; else high++;
      if (l > 250) blown++;
      const mx = Math.max(r, gg, bb), mn = Math.min(r, gg, bb);
      const sat = mx === 0 ? 0 : (mx - mn) / mx;
      satSum += sat;
      if (sat > 0.15 && l > 25) {
        let h = 0;
        const d = mx - mn;
        if (d > 0) {
          if (mx === r) h = ((gg - bb) / d + 6) % 6;
          else if (mx === gg) h = (bb - r) / d + 2;
          else h = (r - gg) / d + 4;
        }
        hueBins[Math.floor((h * 60) / 30) % 12] += l;
      }
    }
    // Speckle: isolated pixels far brighter than all 4 neighbours (grain/CA artifacts).
    for (let y = 1; y < height - 1; y += 2) {
      for (let x = 1; x < width - 1; x += 2) {
        const i = (y * width + x) * 4;
        const l = lumaAt(i);
        const n = [
          lumaAt(i - 4), lumaAt(i + 4),
          lumaAt(i - width * 4), lumaAt(i + width * 4),
        ];
        if (l - Math.max(...n) > 45) speckle++;
      }
    }
    const px = data.length / 4;
    const pct = (n) => +((n / px) * 100).toFixed(1);
    return {
      pctShadow: pct(shadow), pctMid: pct(mid), pctHigh: pct(high), pctBlown: pct(blown),
      meanLuma: +(sum / px).toFixed(1),
      meanSat: +(satSum / px).toFixed(3),
      speckle: +((speckle / (px / 4)) * 100).toFixed(2),
      dominantHue: hueBins.indexOf(Math.max(...hueBins)) * 30,
    };
  }, buf.toString('base64'));
}

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.glsl': 'text/plain', '.css': 'text/css', '.webp': 'image/webp',
  '.hdr': 'application/octet-stream', '.ktx2': 'application/octet-stream',
};

const server = http.createServer(async (req, res) => {
  try {
    const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (urlPath === '/favicon.ico') { res.writeHead(204); res.end(); return; }
    let fp = path.join(root, urlPath === '/' ? 'index.html' : urlPath);
    if (!fp.startsWith(root)) throw new Error('forbidden');
    const data = await readFile(fp);
    res.writeHead(200, { 'content-type': MIME[path.extname(fp)] ?? 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end('not found');
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium',
  args: [
    '--no-sandbox',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--disable-gpu-sandbox',
    '--force-color-profile=srgb',
  ],
});

let failed = false;
try {
  const page = await browser.newPage({ viewport: { width: W, height: H } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error' && !m.location()?.url?.includes('favicon')) errors.push(m.text());
  });

  for (const key of shots) {
    errors.length = 0;
    const t0 = Date.now();
    await page.goto(
      `http://127.0.0.1:${port}/index.html?shot=${key}&t=${time}${skip ? `&skip=${skip}` : ''}`,
      { waitUntil: 'load' },
    );
    try {
      await page.waitForFunction(() => window.__SCENE_READY__ === true, null, { timeout: timeoutMs });
    } catch {
      failed = true;
      console.error(
        `[${key}] TIMEOUT after ${((Date.now() - t0) / 1000).toFixed(1)}s waiting for scene ready. ` +
        `Page errors:\n${errors.join('\n') || '(none captured)'}`,
      );
      continue;
    }
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    const stats = await page.evaluate(() => window.__SCENE_STATS__);
    const file = path.join(outDir, `${key}.png`);
    const buf = await page.screenshot({ path: file });
    const img = await analyze(page, buf);
    console.log(
      `[${key}] saved ${path.relative(process.cwd(), file)} in ${secs}s ` +
      `(${stats?.drawCalls} calls, ${(stats?.triangles / 1000).toFixed(0)}k tris, ` +
      `${stats?.programs} programs, ${stats?.textures} textures)\n` +
      `  value: shadow<40 ${img.pctShadow}% | midtone 40-180 ${img.pctMid}% | ` +
      `highlight>180 ${img.pctHigh}% | blown>250 ${img.pctBlown}% | mean luma ${img.meanLuma}\n` +
      `  color: mean sat ${img.meanSat} | speckle ${img.speckle}% | ` +
      `dominant hue ${img.dominantHue}deg` +
      (errors.length ? `\n  console errors:\n  ${errors.join('\n  ')}` : ''),
    );
    if (errors.length) failed = true;
  }
} finally {
  await browser.close();
  server.close();
}
process.exit(failed ? 1 : 0);
