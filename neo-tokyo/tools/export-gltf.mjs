#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Headless glTF/GLB exporter for the Neo Tokyo scene.
//
// Mirrors tools/screenshot.mjs: serves the project over a throwaway local http
// server and drives the bundled Chromium at /opt/pw-browsers/chromium with the
// SwiftShader flags, so it runs on a box with no GPU.
//
// Usage:
//   node tools/export-gltf.mjs
//   node tools/export-gltf.mjs --out export/neo-tokyo.glb --t 12 --frames 90
//   node tools/export-gltf.mjs --max-texture 1024 --keep-fx
//
// Options:
//   --out PATH          output .glb            (default export/neo-tokyo.glb)
//   --shot KEY          SHOTS preset the export camera uses  (default street)
//   --t SECONDS         scene time to freeze at (default 12, matches the harness)
//   --frames N          update ticks to run before exporting (default 90)
//   --render-frames N   how many of those also do a real GL render (default 0)
//   --max-texture N     clamp exported image dimension (default 2048)
//   --keep-fx           keep volumetric/particle carrier geometry instead of
//                       dropping it (see tools/export-scene.mjs)
//   --timeout SECONDS   overall page budget (default 600)
//   --manifest PATH     also write the export report as JSON
//
// How the scene is obtained: src/main.js does not publish the scene on window
// and this tool does not edit it. So the page is loaded once and probed for any
// usable global; when none is found (the normal case) the tool injects
// /tools/export-scene.mjs as a module script, which imports the very same
// /src/*.js module URLs main.js does and assembles a scene for export.
//
// Getting the binary out: the page turns the ArrayBuffer into base64 via
// FileReader and parks it on window.__NT_EXPORT__.b64; node drains it in
// 4-byte-aligned chunks through page.evaluate and writes it with fs.
// ---------------------------------------------------------------------------

import http from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  if (i < 0) return false;
  args.splice(i, 1);
  return true;
};
const opt = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 ? args.splice(i, 2)[1] : dflt;
};

const keepFx = flag('--keep-fx');
const outPath = path.resolve(root, opt('--out', 'export/neo-tokyo.glb'));
const manifestPath = path.resolve(root, opt('--manifest', 'export/neo-tokyo.manifest.json'));
const shot = opt('--shot', 'street');
const time = opt('--t', '12');
const frames = opt('--frames', '90');
const renderFrames = opt('--render-frames', '0');
const maxTexture = opt('--max-texture', '2048');
const timeoutMs = Number(opt('--timeout', '600')) * 1000;

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
    const fp = path.join(root, urlPath === '/' ? 'index.html' : urlPath);
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

// ---------------------------------------------------------------------------
// GLB introspection — the verification step. Reads back what was actually
// written rather than trusting the exporter's word for it.
// ---------------------------------------------------------------------------
function glbStats(buf) {
  if (buf.length < 20) throw new Error('file too short to be a GLB');
  const magic = buf.readUInt32LE(0);
  if (magic !== 0x46546c67) throw new Error(`bad GLB magic 0x${magic.toString(16)}`);
  const version = buf.readUInt32LE(4);
  const total = buf.readUInt32LE(8);
  const jsonLen = buf.readUInt32LE(12);
  const jsonType = buf.readUInt32LE(16);
  if (jsonType !== 0x4e4f534a) throw new Error('first GLB chunk is not JSON');
  const gltf = JSON.parse(buf.subarray(20, 20 + jsonLen).toString('utf8'));

  const acc = gltf.accessors ?? [];
  let triangles = 0;
  let primitives = 0;
  let vertices = 0;
  for (const mesh of gltf.meshes ?? []) {
    for (const p of mesh.primitives ?? []) {
      primitives++;
      const mode = p.mode ?? 4;
      const idx = p.indices != null ? acc[p.indices]?.count ?? 0 : acc[p.attributes?.POSITION]?.count ?? 0;
      if (mode === 4) triangles += Math.floor(idx / 3);
      vertices += acc[p.attributes?.POSITION]?.count ?? 0;
    }
  }
  // Node -> mesh references: how many objects Blender will actually create.
  let meshNodes = 0;
  let instancedTriangles = 0;
  const meshTris = (gltf.meshes ?? []).map((m) =>
    (m.primitives ?? []).reduce((s, p) => {
      const n = p.indices != null ? acc[p.indices]?.count ?? 0 : acc[p.attributes?.POSITION]?.count ?? 0;
      return s + Math.floor(n / 3);
    }, 0));
  for (const n of gltf.nodes ?? []) {
    if (n.mesh != null) { meshNodes++; instancedTriangles += meshTris[n.mesh] ?? 0; }
  }

  const imgBytes = (gltf.images ?? []).reduce((s, im) => {
    const bv = gltf.bufferViews?.[im.bufferView];
    return s + (bv?.byteLength ?? 0);
  }, 0);

  return {
    version, total,
    nodes: (gltf.nodes ?? []).length,
    meshNodes,
    meshes: (gltf.meshes ?? []).length,
    primitives,
    materials: (gltf.materials ?? []).length,
    textures: (gltf.textures ?? []).length,
    images: (gltf.images ?? []).length,
    imageBytes: imgBytes,
    accessors: acc.length,
    uniqueTriangles: triangles,
    drawnTriangles: instancedTriangles,
    uniqueVertices: vertices,
    extensionsUsed: gltf.extensionsUsed ?? [],
    extensionsRequired: gltf.extensionsRequired ?? [],
    sceneExtras: gltf.scenes?.[gltf.scene ?? 0]?.extras ?? null,
  };
}

const mb = (n) => (n / 1024 / 1024).toFixed(2);

// ---------------------------------------------------------------------------

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium',
  args: [
    '--no-sandbox',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--disable-gpu-sandbox',
    '--force-color-profile=srgb',
    '--js-flags=--max-old-space-size=8192',
  ],
});

let exitCode = 0;
try {
  // Small viewport on purpose: main.js sizes its renderer from window.inner*,
  // and we are not screenshotting anything — every pixel it draws is wasted
  // SwiftShader time.
  const page = await browser.newPage({ viewport: { width: 320, height: 200 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => {
    const t = m.text();
    if (m.type() === 'error' && !m.location()?.url?.includes('favicon')) errors.push(t);
    if (t.startsWith('[export]')) console.log('  ' + t);
  });

  // --- 1. load the real page and look for an exposed scene ----------------
  const base = `http://127.0.0.1:${port}/index.html`;
  const q = `shot=${shot}&t=${time}&frames=${frames}&renderFrames=${renderFrames}` +
            `&maxTexture=${maxTexture}&keepFx=${keepFx ? 1 : 0}&export=1`;

  console.log(`probing ${base}?${q} for an exposed scene ...`);
  await page.goto(`${base}?${q}`, { waitUntil: 'load', timeout: timeoutMs });

  const probe = await page.evaluate(() => {
    const names = ['__SCENE__', '__NT_SCENE__', '__THREE_SCENE__', 'scene', 'NEO_TOKYO'];
    for (const n of names) {
      const v = window[n];
      if (v && (v.isScene || v.scene?.isScene)) return { found: n };
    }
    return { found: null, globals: names.filter((n) => window[n] !== undefined) };
  });

  if (probe.found) {
    console.log(`  found window.${probe.found} — but src/main.js is not ours to depend on;`);
    console.log('  the injected builder is used regardless so the export is reproducible.');
  } else {
    console.log('  no scene global exposed by src/main.js (expected) — injecting our own builder');
  }

  // --- 2. reload with every module skipped, then inject --------------------
  // main.js still supplies the document and the importmap, but builds nothing,
  // so we are not paying to construct the scene twice.
  const skipAll = 'atmosphere,ground,architecture,signage,vehicles,weather,postfx';
  await page.goto(`${base}?${q}&skip=${skipAll}`, { waitUntil: 'load', timeout: timeoutMs });
  errors.length = 0;

  const t0 = Date.now();
  await page.evaluate(() => new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.type = 'module';
    s.src = '/tools/export-scene.mjs';
    s.onerror = () => reject(new Error('failed to load /tools/export-scene.mjs'));
    s.onload = () => resolve(true);
    document.head.appendChild(s);
  }));
  console.log('injected /tools/export-scene.mjs; building + exporting ...');

  await page.waitForFunction(
    () => {
      const s = window.__NT_EXPORT__;
      return !!s && (s.phase === 'done' || s.phase === 'error');
    },
    null,
    { timeout: timeoutMs, polling: 500 },
  );

  const state = await page.evaluate(() => {
    const s = window.__NT_EXPORT__;
    return { phase: s.phase, error: s.error, manifest: s.manifest, bytes: s.bytes, log: s.log };
  });

  if (state.phase === 'error') {
    throw new Error(`page-side export failed:\n${state.error}\n\nlog:\n${state.log.join('\n')}`);
  }

  // --- 3. drain the base64 payload ---------------------------------------
  const b64len = await page.evaluate(() => window.__NT_EXPORT__.b64.length);
  const CHUNK = 4 * 1024 * 1024; // multiple of 4 -> every chunk decodes standalone
  const parts = [];
  for (let off = 0; off < b64len; off += CHUNK) {
    const s = await page.evaluate(
      ([o, c]) => window.__NT_EXPORT__.b64.substr(o, c),
      [off, CHUNK],
    );
    parts.push(Buffer.from(s, 'base64'));
  }
  const buf = Buffer.concat(parts);
  if (buf.length !== state.bytes) {
    throw new Error(`transfer mismatch: page said ${state.bytes} bytes, got ${buf.length}`);
  }

  await mkdir(path.dirname(outPath), { recursive: true });
  await writeFile(outPath, buf);

  // --- 4. verify ----------------------------------------------------------
  const stats = glbStats(buf);
  const secs = ((Date.now() - t0) / 1000).toFixed(1);

  const report = {
    file: path.relative(root, outPath),
    sizeBytes: buf.length,
    sizeMB: Number(mb(buf.length)),
    seconds: Number(secs),
    glb: stats,
    page: state.manifest,
    consoleErrors: [...new Set(errors)].slice(0, 20),
  };
  await writeFile(manifestPath, JSON.stringify(report, null, 2));

  console.log('');
  console.log(`wrote ${path.relative(process.cwd(), outPath)} — ${mb(buf.length)} MB in ${secs}s`);
  console.log(`  glTF ${stats.version}  nodes ${stats.nodes} (${stats.meshNodes} with meshes)`);
  console.log(`  meshes ${stats.meshes}  primitives ${stats.primitives}  materials ${stats.materials}`);
  console.log(`  textures ${stats.textures} / images ${stats.images} (${mb(stats.imageBytes)} MB of PNG)`);
  console.log(`  triangles ${stats.uniqueTriangles.toLocaleString()} unique / ` +
              `${stats.drawnTriangles.toLocaleString()} placed`);
  console.log(`  extensionsUsed: ${stats.extensionsUsed.join(', ') || '(none)'}`);
  console.log(`  extensionsRequired: ${stats.extensionsRequired.join(', ') || '(none)'}`);
  if (state.manifest) {
    console.log(`  dropped: ${JSON.stringify(state.manifest.dropped)}`);
    console.log(`  converted: ${JSON.stringify(state.manifest.converted)}`);
    console.log(`  instances expanded: ${state.manifest.expanded.expanded} from ` +
                `${state.manifest.expanded.instancedMeshes} InstancedMesh`);
  }
  console.log(`  manifest: ${path.relative(process.cwd(), manifestPath)}`);

  if (stats.extensionsRequired.length) {
    console.warn('  WARNING: extensionsRequired is non-empty; importers lacking these will refuse the file.');
  }
  if (errors.length) {
    console.warn(`  page console errors:\n    ${[...new Set(errors)].slice(0, 10).join('\n    ')}`);
  }
  if (buf.length < 256 * 1024) {
    console.error('  ERROR: output is implausibly small for this scene.');
    exitCode = 1;
  }
} catch (e) {
  console.error(String(e?.stack ?? e));
  exitCode = 1;
} finally {
  await browser.close();
  server.close();
}
process.exit(exitCode);
