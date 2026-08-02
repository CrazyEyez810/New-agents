#!/usr/bin/env node
// Minimal static server for local viewing: node tools/serve.mjs [port]
// Open http://127.0.0.1:5173/ — omit ?shot= to get orbit controls.

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.argv[2] ?? 5173);

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.css': 'text/css', '.glsl': 'text/plain', '.webp': 'image/webp',
  '.glb': 'model/gltf-binary',
};

http
  .createServer(async (req, res) => {
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
  })
  .listen(port, '127.0.0.1', () => {
    console.log(`Neo Tokyo running at http://127.0.0.1:${port}/`);
    console.log('Camera presets: /?shot=street | canyon | aerial | alley');
  });
