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
const [W, H] = opt('--size', '1600x900').split('x').map(Number);
let shots = args.filter((a) => !a.startsWith('--'));
if (shots.length === 0) {
  const src = await readFile(path.join(root, 'src/main.js'), 'utf8');
  const block = src.match(/export const SHOTS = \{([\s\S]*?)\n\};/)?.[1] ?? '';
  shots = [...block.matchAll(/^\s*(\w+):/gm)].map((m) => m[1]);
  if (shots.length === 0) shots = ['street'];
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
    await page.goto(`http://127.0.0.1:${port}/index.html?shot=${key}&t=${time}`, {
      waitUntil: 'load',
    });
    try {
      await page.waitForFunction(() => window.__SCENE_READY__ === true, null, { timeout: 60000 });
    } catch {
      failed = true;
      console.error(`[${key}] TIMEOUT waiting for scene ready. Page errors:\n${errors.join('\n') || '(none captured)'}`);
      continue;
    }
    const file = path.join(outDir, `${key}.png`);
    await page.screenshot({ path: file });
    console.log(`[${key}] saved ${path.relative(process.cwd(), file)}${errors.length ? `\n  console errors:\n  ${errors.join('\n  ')}` : ''}`);
    if (errors.length) failed = true;
  }
} finally {
  await browser.close();
  server.close();
}
process.exit(failed ? 1 : 0);
