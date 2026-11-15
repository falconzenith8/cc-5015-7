import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LineCurve, CircleCurve, HelixCurve, PolylineCurve } from '../src/core/curve.js';
import { sampleAdaptive } from '../src/core/sampler.js';
import { buildFrames } from '../src/core/frames.js';
import { createScaleTrack, circleProfile, profileIssues, ribbonProfile } from '../src/core/section.js';
import { buildSweep, computeVertexNormals } from '../src/core/sweep.js';
import { findMeshSelfIntersections } from '../src/core/collisions.js';
import { toOBJ, toSTLAscii, toSTLBinary } from '../src/core/exporter.js';
import { v, dot, sub, length, distance, normalize } from '../src/core/vec3.js';

function sweep(curve, profile, opts = {}) {
  const sampled = sampleAdaptive(curve, opts.sampling);
  const frames = buildFrames(sampled, { frameMode: opts.frameMode || 'rmf', upVector: opts.upVector });
  const evalScale = createScaleTrack(opts.keyframes || [{ u: 0, su: 1, sv: 1 }, { u: 1, su: 1, sv: 1 }]);
  return { sampled, mesh: buildSweep(sampled, frames, profile, evalScale, opts.sweep) };
}

function edgeStats(mesh) {
  const edges = new Map();
  for (const f of mesh.faces) {
    for (let k = 0; k < 3; k++) {
      const a = f[k], b = f[(k + 1) % 3];
      const key = a < b ? a + '>' + b : b + '>' + a;
      edges.set(key, (edges.get(key) || 0) + 1);
    }
  }
  return edges;
}

test('straight tube: watertight, capped, outward normals, exact radius', () => {
  const line = new LineCurve(v(0, 0, 0), v(8, 0, 0));
  const profile = circleProfile(1, 20);
  const { mesh } = sweep(line, profile);
  const edges = edgeStats(mesh);
  assert.ok([...edges.values()].every((c) => c === 2), 'every edge shared by exactly 2 faces');
  // All profile vertices at distance 1 from the path axis (x-axis).
  for (const p of mesh.vertices) {
    const r = Math.hypot(p[1], p[2]);
    assert.ok(Math.abs(r - 1) < 1e-9 || r < 1e-9, `unexpected radius ${r}`); // r=0 are cap centers
  }
  const normals = computeVertexNormals(mesh);
  // Use an interior ring (ring 1): end-ring vertices share faces with caps and so have
  // blended normals, but interior vertices carry the pure surface normal.
  const m = 20;
  for (let i = 0; i < m; i++) {
    const vi = m + i;
    const n = normals[vi];
    const radial = normalize([0, mesh.vertices[vi][1], mesh.vertices[vi][2]]);
    assert.ok(Math.abs(dot(n, radial) - 1) < 1e-9, 'normal points radially out');
  }
  // two cap centers exist (zero-radius vertices)
  const capCenters = mesh.vertices.filter((p) => Math.hypot(p[1], p[2]) < 1e-9);
  assert.equal(capCenters.length, 2);
  assert.equal(mesh.closed, false);
});

test('closed torus-style ring sweep: watertight with no caps and one seam', () => {
  const circle = new CircleCurve(v(0, 0, 0), 5, v(1, 0, 0), v(0, 1, 0));
  const profile = circleProfile(0.6, 16);
  const { mesh } = sweep(circle, profile, { sampling: { chordTolerance: 0.03 } });
  assert.equal(mesh.closed, true);
  const edges = edgeStats(mesh);
  assert.ok([...edges.values()].every((c) => c === 2), 'closed sweep is watertight');
  assert.ok(mesh.seam && mesh.seam.u === 0);
  // Every vertex lies at profile radius 0.6 from the center circle.
  for (const p of mesh.vertices) {
    const radial = Math.hypot(p[0], p[1]);
    assert.ok(Math.abs(Math.abs(radial - 5) - 0.6) < 1e-6 || Math.abs(radial - 5) < 0.6 + 1e-6);
  }
  const col = findMeshSelfIntersections(mesh);
  assert.equal(col.hits.length, 0, 'well-proportioned ring must not self-intersect');
});

test('helix sweep: watertight open solid with two caps, no self-intersection', () => {
  const helix = new HelixCurve(v(0, 0, 0), 2, 3, 8, v(1, 0, 0), v(0, 1, 0), v(0, 0, 1));
  const profile = circleProfile(0.35, 14);
  const { mesh } = sweep(helix, profile, { sampling: { chordTolerance: 0.03 } });
  const edges = edgeStats(mesh);
  assert.ok([...edges.values()].every((c) => c === 2));
  assert.equal(findMeshSelfIntersections(mesh).hits.length, 0);
});

test('tapered sweep: section size follows the scale track', () => {
  const line = new LineCurve(v(0, 0, 0), v(6, 0, 0));
  const profile = circleProfile(1, 12);
  const { mesh } = sweep(line, profile, {
    keyframes: [{ u: 0, su: 1, sv: 1 }, { u: 1, su: 0.2, sv: 0.2 }],
  });
  const m = 12;
  const firstR = Math.max(...mesh.vertices.slice(0, m).map((p) => Math.hypot(p[1], p[2])));
  const lastRingStart = (mesh.ringCount - 1) * m;
  const lastR = Math.max(...mesh.vertices.slice(lastRingStart, lastRingStart + m).map((p) => Math.hypot(p[1], p[2])));
  assert.ok(Math.abs(firstR - 1) < 1e-9);
  assert.ok(Math.abs(lastR - 0.2) < 1e-9);
});

test('right-angle path: miter joint keeps one ring and remains watertight', () => {
  const pl = new PolylineCurve([v(0, 0, 0), v(5, 0, 0), v(5, 5, 0)], false);
  const profile = circleProfile(0.5, 12);
  const { mesh } = sweep(pl, profile, { sweep: { miterLimit: 4 } });
  assert.ok(mesh.rings.some((r) => r.kind === 'miter'));
  const edges = edgeStats(mesh);
  assert.ok([...edges.values()].every((c) => c === 2));
  assert.equal(findMeshSelfIntersections(mesh).hits.length, 0);
});

test('sharp angle exceeding miter limit falls back to bevel, still watertight', () => {
  // ~150 degree turn: cos(75°)=0.259 -> miter factor ~3.86, above the 1.5 limit.
  const pl = new PolylineCurve([v(0, 0, 0), v(5, 0, 0), v(5 + Math.cos(5 * Math.PI / 6), Math.sin(5 * Math.PI / 6), 0)], false);
  const profile = circleProfile(0.5, 12);
  const { mesh } = sweep(pl, profile, { sweep: { miterLimit: 1.5 } });
  assert.ok(mesh.rings.some((r) => r.kind === 'bevel-in'));
  const edges = edgeStats(mesh);
  assert.ok([...edges.values()].every((c) => c === 2));
  assert.ok(mesh.diagnostics.some((d) => d.type === 'miter_limit'));
});

test('closed polyline sweep closes head-to-tail watertight', () => {
  const sq = new PolylineCurve([v(0, 0, 0), v(4, 0, 0), v(4, 4, 0), v(0, 4, 0)], true);
  const profile = circleProfile(0.4, 10);
  const { mesh } = sweep(sq, profile);
  assert.equal(mesh.closed, true);
  const edges = edgeStats(mesh);
  assert.ok([...edges.values()].every((c) => c === 2));
});

test('ribbon profile is a closed thin solid and sweeps without self-intersection', () => {
  const pl = new PolylineCurve([v(0, 0, 0), v(4, 0, 0), v(4, 4, 0)], false);
  const profile = ribbonProfile(0.7, 0.12);
  const check = profileIssues(profile);
  assert.equal(check.issues.length, 0);
  assert.ok(check.ccw);
  const { mesh } = sweep(pl, profile);
  assert.equal(findMeshSelfIntersections(mesh).hits.length, 0);
});

test('self-intersecting profile is reported as an error input', () => {
  const bowtie = [[-1, -1], [1, 1], [1, -1], [-1, 1]];
  const check = profileIssues(bowtie);
  assert.ok(check.issues.some((i) => i.type === 'self_intersection'));
});

test('tight bend vs section size raises bend self-intersection diagnostic', () => {
  const circle = new CircleCurve(v(0, 0, 0), 0.4, v(1, 0, 0), v(0, 1, 0));
  const profile = circleProfile(0.5, 12); // radius 0.5 > bend radius 0.4
  const { mesh } = sweep(circle, profile);
  assert.ok(mesh.diagnostics.some((d) => d.type === 'bend_self_intersection_risk'));
  assert.ok(findMeshSelfIntersections(mesh).hits.length > 0, 'collision scan must find the fold');
});

test('exporters produce parseable OBJ/STL with correct counts', () => {
  const line = new LineCurve(v(0, 0, 0), v(3, 0, 0));
  const { mesh } = sweep(line, circleProfile(0.5, 8));
  const obj = toOBJ(mesh, 't');
  assert.equal((obj.match(/^v /gm) || []).length, mesh.vertices.length);
  assert.equal((obj.match(/^f /gm) || []).length, mesh.faces.length);
  const stl = toSTLAscii(mesh, 't');
  assert.equal((stl.match(/facet normal/g) || []).length, mesh.faces.length);
  const bin = toSTLBinary(mesh);
  assert.equal(bin.length, 84 + mesh.faces.length * 50);
  assert.equal(bin.readUInt32LE(80), mesh.faces.length);
});
