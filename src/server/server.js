// Zero-dependency HTTP server: static web assets, three.js from node_modules,
// project persistence with source-curve/adopted-version history, builds and exports.
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runSweep } from '../core/pipeline.js';
import { createProject, updateDraft, adoptVersion, rollback, ProjectStore } from '../core/project.js';
import { toOBJ, toSTLAscii, toSTLBinary } from '../core/exporter.js';
const __dirname = fileURLToPath(new URL('.', import.meta.url));
const root = join(__dirname, '..', '..');
const webDir = join(root, 'web');
// SWEEP_DATA_DIR lets tests and throwaway runs point persistence at a temp directory
// instead of the repository's data/.
const dataDir = process.env.SWEEP_DATA_DIR || join(root, 'data');
const geomDir = join(dataDir, 'geometry');
const store = new ProjectStore(await import('node:fs'), await import('node:path'), dataDir);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

async function sendJson(res, code, body) {
  const buf = Buffer.from(JSON.stringify(body));
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': buf.length });
  res.end(buf);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 5e6) reject(new Error('payload too large'));
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

// Serialize a build into compact geometry the browser can turn into three.js buffers.
// The pipeline owns this shape; the server forwards it verbatim so rendering and export
// read the same geometry object.
function geometryPayload(result) {
  return result.geometry;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = url.pathname;
  try {
    // ---- API ----
    if (path.startsWith('/api/')) {
      if (req.method === 'GET' && path === '/api/projects') {
        return sendJson(res, 200, store.list().map((p) => ({
          id: p.id, name: p.name, updatedAt: p.updatedAt,
          versionCount: p.versions.length, sourceCurve: p.sourceCurve,
        })));
      }

      if (req.method === 'POST' && path === '/api/projects') {
        const body = await readBody(req);
        const project = createProject({ name: body.name, spec: body.spec });
        store.upsert(project);
        return sendJson(res, 200, project);
      }

      const projMatch = path.match(/^\/api\/projects\/([^/]+)(\/.*)?$/);
      if (projMatch) {
        const id = decodeURIComponent(projMatch[1]);
        const sub = projMatch[2] || '';
        const project = store.get(id);
        if (!project) return sendJson(res, 404, { error: 'project not found' });

        if (req.method === 'GET' && sub === '') return sendJson(res, 200, project);

        if (req.method === 'PUT' && sub === '/draft') {
          const patch = await readBody(req);
          updateDraft(project, patch);
          store.upsert(project);
          return sendJson(res, 200, project);
        }

        if (req.method === 'POST' && sub === '/build') {
          // Build from the working draft; the source curve remains stored separately.
          const result = runSweep(project.draft);
          return sendJson(res, 200, { report: result.report, geometry: geometryPayload(result) });
        }

        if (req.method === 'POST' && sub === '/build-custom') {
          // Preview arbitrary parameters without touching the saved draft.
          const spec = await readBody(req);
          const result = runSweep(spec);
          return sendJson(res, 200, { report: result.report, geometry: geometryPayload(result) });
        }

        if (req.method === 'POST' && sub === '/adopt') {
          const result = runSweep(project.draft);
          await mkdir(geomDir, { recursive: true });
          const ref = `${project.id}_v${project.versions.length + 1}.json`;
          await writeFile(join(geomDir, ref), JSON.stringify(geometryPayload(result)));
          const version = adoptVersion(project, project.draft, result.report, ref);
          store.upsert(project);
          return sendJson(res, 200, { project, version });
        }

        if (req.method === 'POST' && sub.startsWith('/rollback/')) {
          const vid = decodeURIComponent(sub.split('/').pop());
          rollback(project, vid);
          store.upsert(project);
          return sendJson(res, 200, project);
        }

        const exportMatch = sub.match(/^\/export\/(obj|stl|stl-bin)$/);
        if (req.method === 'GET' && exportMatch) {
          const result = runSweep(project.draft);
          const fmt = exportMatch[1];
          if (fmt === 'obj') {
            const buf = Buffer.from(toOBJ(result.mesh, project.name));
            res.writeHead(200, { 'content-type': 'text/plain', 'content-length': buf.length });
            return res.end(buf);
          }
          if (fmt === 'stl') {
            const buf = Buffer.from(toSTLAscii(result.mesh, project.name));
            res.writeHead(200, { 'content-type': 'text/plain', 'content-length': buf.length });
            return res.end(buf);
          }
          const buf = toSTLBinary(result.mesh);
          res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': buf.length });
          return res.end(buf);
        }
      }
      return sendJson(res, 404, { error: 'unknown api route' });
    }

    // ---- Static assets, including three.js served from node_modules ----
    let filePath;
    if (path.startsWith('/vendor/three/')) {
      const rel = path.replace('/vendor/three/', '');
      filePath = join(root, 'node_modules', 'three', normalize(rel));
      if (!filePath.startsWith(join(root, 'node_modules', 'three'))) return sendJson(res, 403, { error: 'forbidden' });
    } else {
      filePath = path === '/' ? join(webDir, 'index.html') : join(webDir, normalize(path));
      if (!filePath.startsWith(webDir)) return sendJson(res, 403, { error: 'forbidden' });
    }
    if (!existsSync(filePath)) return sendJson(res, 404, { error: 'not found' });
    const buf = await readFile(filePath);
    res.writeHead(200, { 'content-type': MIME[extname(filePath)] || 'application/octet-stream' });
    res.end(buf);
  } catch (err) {
    sendJson(res, 500, { error: String(err && err.message || err) });
  }
});

const port = process.env.PORT || 3000;
server.listen(port, () => {
  console.log(`Sweep-craft running at http://localhost:${port}`);
});
