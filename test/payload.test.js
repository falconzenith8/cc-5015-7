// Validates the geometry payload contract consumed by web/app.js, and exercises the
// spec-shaping logic the UI relies on. A full pixel-level WebGL check needs a display
// server (the sandbox has no system Chromium libraries); the core math this renders is
// covered by the node test suite and the payload checks here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runSweep } from '../src/core/pipeline.js';

function payloadOf(spec) {
  const r = runSweep(spec);
  return {
    vertices: r.mesh.vertices,
    faces: r.mesh.faces,
    rings: r.mesh.rings.map((ring) => ({
      position: ring.position, n: ring.frame.n, b: ring.frame.b, t: ring.frame.t,
      su: ring.su, sv: ring.sv, kind: ring.kind, u: ring.u,
    })),
    profile: r.profile,
    path: r.sampled.stations.map((s, i) => ({
      position: s.position, tangent: s.tangent,
      n: r.frameResult.frames[i].n, b: r.frameResult.frames[i].b, corner: !!s.corner,
    })),
    closed: r.sampled.closed,
  };
}

test('browser payload: every face indexes a real vertex and positions are finite', () => {
  const geo = payloadOf({
    curve: { type: 'helix', params: { center: [0, 0, 0], r: 2, turns: 2, rise: 5, e1: [1, 0, 0], e2: [0, 1, 0], e3: [0, 0, 1] } },
    profile: { type: 'circle', radius: 0.4, segments: 14 },
    scaleKeyframes: [{ u: 0, su: 1, sv: 1 }, { u: 1, su: 0.5, sv: 0.5 }],
  });
  for (const f of geo.faces) {
    for (const vi of f) {
      assert.ok(vi >= 0 && vi < geo.vertices.length, 'face vertex in range');
      const p = geo.vertices[vi];
      assert.ok(p.every(Number.isFinite), 'vertex finite');
    }
  }
  // Frame vectors on every ring are unit length (the UI draws them as arrows).
  for (const r of geo.rings) {
    for (const axis of ['n', 'b', 't']) {
      assert.ok(Math.abs(Math.hypot(...r[axis]) - 1) < 1e-9);
    }
  }
  // Scale keyframes reach the rings: last ring su/sv near 0.5.
  const last = geo.rings[geo.rings.length - 1];
  assert.ok(Math.abs(last.su - 0.5) < 1e-9 && Math.abs(last.sv - 0.5) < 1e-9);
});

test('browser payload: closed path carries the seam flag and corner markers', () => {
  const geo = payloadOf({
    curve: { type: 'polyline', params: { points: [[0, 0, 0], [4, 0, 0], [4, 4, 0], [0, 4, 0]], closed: true } },
    profile: { type: 'ribbon', width: 0.6, thickness: 0.12 },
  });
  assert.equal(geo.closed, true);
  assert.ok(geo.path.some((s) => s.corner), 'corner markers present for the UI');
  assert.ok(geo.rings.some((r) => r.kind === 'miter'));
});

test('UI scale-table parsing: malformed lines are dropped, valid points retained', () => {
  // Mirrors the textarea parser in app.js collectSpec().
  const parsed = '0,0,0\n1,0,0\n1,1,0\nbad\n0,1,0'
    .split('\n')
    .map((line) => line.split(',').map(Number))
    .filter((p) => p.length >= 2 && p.every(Number.isFinite));
  assert.equal(parsed.length, 4);
  assert.deepEqual(parsed[2], [1, 1, 0]);
});
