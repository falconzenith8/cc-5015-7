// UI wiring test: starts the real zero-dependency server and exercises the same HTTP
// calls web/app.js makes. This is not a pixel test (the sandbox has no WebGL/browser),
// but it does prove the interface path the buttons take: page assets load, a build runs
// through the kernel, the returned geometry is the one the viewport and export share,
// and a kernel failure is surfaced as a JSON error the UI can display.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
let server;
let port;
let dataDir;

async function waitForServer(url, attempts = 100) {
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('server did not start');
}

before(async () => {
  // Isolate persistence: copy the seed projects into a temp data dir and point the server
  // there so the UI test never mutates the repository's data/projects.json.
  dataDir = mkdtempSync(join(tmpdir(), 'sweep-ui-'));
  port = 3400 + Math.floor(Math.random() * 400);
  server = spawn(process.execPath, [join(ROOT, 'src/server/server.js')], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), SWEEP_DATA_DIR: dataDir },
    stdio: 'ignore',
  });
  await waitForServer(`http://127.0.0.1:${port}/`);
});

after(() => {
  if (server) server.kill();
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
});

const base = () => `http://127.0.0.1:${port}`;

test('UI boot: the page and module scripts the browser loads are served', async () => {
  const html = await (await fetch(`${base()}/`)).text();
  assert.match(html, /id="canvasHost"/);
  assert.match(html, /id="buildBtn"/);
  assert.match(html, /id="buildStatus"/);
  const app = await (await fetch(`${base()}/app.js`)).text();
  assert.match(app, /build-custom/, 'the UI builds through the kernel preview endpoint');
  assert.match(app, /runBuild/);
  const three = await fetch(`${base()}/vendor/three/build/three.module.js`);
  assert.equal(three.status, 200, 'three.js is served from node_modules for the viewport');
});

test('UI sweep starts: create project, build, receive a real swept surface', async () => {
  // Mirrors newProjectBtn -> openProject -> runBuild in web/app.js.
  const spec = {
    curve: { type: 'polyline', params: { points: [[0, 0, 0], [5, 0, 0], [5, 5, 0], [0, 5, 0]], closed: true } },
    profile: { type: 'ribbon', width: 0.8, thickness: 0.15 },
    scaleKeyframes: [{ u: 0, su: 1, sv: 1 }, { u: 1, su: 1, sv: 1 }],
    scaleInterpolation: 'linear',
    frameMode: 'rmf',
    sampling: { chordTolerance: 0.02, maxTurnAngle: 6 * Math.PI / 180 },
    miterLimit: 2,
    bevelOffset: 0.35,
  };
  const created = await (await fetch(`${base()}/api/projects`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'ui', spec }),
  })).json();

  const built = await (await fetch(`${base()}/api/projects/${created.id}/build-custom`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(spec),
  })).json();

  assert.ok(built.geometry, 'build returns geometry for the viewport');
  assert.ok(built.geometry.vertices.length > 0);
  assert.ok(built.geometry.faces.length > 0);
  assert.equal(built.report.mesh.vertexCount, built.geometry.vertices.length);
  assert.ok(built.geometry.rings.length > 0, 'ring layer has frames to draw');
  assert.equal(built.geometry.closed, true);
  assert.ok(built.geometry.topology.edge.boundary === 0, 'closed ribbon is watertight');
  // Section orientation and edge connection reach the interface as data.
  assert.equal(built.geometry.sectionState.polygonClosed, true);
  assert.ok(['ccw', 'cw'].includes(built.geometry.sectionState.winding));
  assert.equal(typeof built.geometry.topology.edge.inconsistent, 'number');
});

test('UI edit-and-drag rebuild: changing section and path points re-runs the kernel', async () => {
  const spec = {
    curve: { type: 'polyline', params: { points: [[0, 0, 0], [6, 0, 0], [6, 4, 0]], closed: false } },
    profile: { type: 'circle', radius: 0.3, segments: 12 },
    scaleKeyframes: [{ u: 0, su: 1, sv: 1 }, { u: 1, su: 1, sv: 1 }],
    frameMode: 'rmf',
  };
  const created = await (await fetch(`${base()}/api/projects`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'ui-edit', spec }),
  })).json();

  const first = await (await fetch(`${base()}/api/projects/${created.id}/build-custom`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(spec),
  })).json();

  // Edit the section size and drag a path point; the UI fires another build.
  const edited = structuredClone(spec);
  edited.profile = { type: 'ellipse', rx: 0.5, ry: 0.25, segments: 16 };
  edited.curve.params.points[1] = [7, 0, 0];
  const second = await (await fetch(`${base()}/api/projects/${created.id}/build-custom`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(edited),
  })).json();

  assert.notDeepEqual(second.geometry.vertices, first.geometry.vertices, 'dragging the path changes the surface');
  assert.equal(second.geometry.profile.length, 16, 'section edit changes ring resolution');
  assert.ok(second.report.mesh.vertexCount > 0);
  assert.ok(second.geometry.topology.edge.edgeCount > 0, 'continuity evidence present after edit');
});

test('UI failure feedback: a kernel error comes back as JSON the diagnostics panel shows', async () => {
  const created = await (await fetch(`${base()}/api/projects`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'ui-fail',
      spec: { curve: { type: 'line', params: { a: [0, 0, 0], b: [1, 0, 0] } }, profile: { type: 'circle', radius: 0.2, segments: 8 } },
    }),
  })).json();

  const res = await fetch(`${base()}/api/projects/${created.id}/build-custom`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ curve: { type: 'polyline', params: { points: [[0, 0, 0], [0, 0, 0]], closed: false } }, profile: { type: 'circle', radius: 0.2 } }),
  });
  assert.equal(res.status, 500, 'kernel failure surfaces as an HTTP error');
  const body = await res.json();
  assert.ok(body.error, 'error text is returned for renderReport/buildStatus');
});

test('export after a build matches the built geometry counts', async () => {
  const spec = {
    curve: { type: 'circle', params: { center: [0, 0, 0], radius: 4, e1: [1, 0, 0], e2: [0, 1, 0] } },
    profile: { type: 'circle', radius: 0.4, segments: 12 },
    frameMode: 'rmf',
  };
  const created = await (await fetch(`${base()}/api/projects`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'ui-export', spec }),
  })).json();
  const built = await (await fetch(`${base()}/api/projects/${created.id}/build-custom`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(spec),
  })).json();
  const obj = await (await fetch(`${base()}/api/projects/${created.id}/export/obj`)).text();
  assert.equal((obj.match(/^v /gm) || []).length, built.geometry.vertices.length, 'export vertices == viewport vertices');
  assert.equal((obj.match(/^f /gm) || []).length, built.geometry.faces.length, 'export faces == viewport faces');
});

test('old persisted sample path runs to completion through the interface', async () => {
  // A legacy flat curve spec, exactly like the two old projects in data/projects.json.
  const legacySpec = {
    curve: { type: 'polyline', closed: true, points: [[1, 0, 0], [0.707, 0.707, 0.3], [0, 1, -0.35], [-0.707, 0.707, 0.35], [-1, 0, 0], [-0.707, -0.707, -0.2], [0, -1, 0.1], [0.707, -0.707, -0.15]] },
    profile: { type: 'circle', radius: 0.05, segments: 12 },
    frameMode: 'fixed-up',
    scaleKeyframes: [],
  };
  const created = await (await fetch(`${base()}/api/projects`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'ui-legacy', spec: legacySpec }),
  })).json();
  const built = await (await fetch(`${base()}/api/projects/${created.id}/build-custom`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(legacySpec),
  })).json();
  assert.equal(built.report.errors.length, 0);
  assert.ok(built.geometry.vertices.length > 0);
  assert.equal(built.geometry.closed, true);
});
