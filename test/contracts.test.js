// Module contracts and differential evidence for the curve-sweep refactor.
//
// Two things are asserted separately:
//   1. Each module enforces its explicit interface state (no silent defaults).
//   2. The refactored pipeline reproduces the frozen pre-refactor geometry for a closed
//      path and sharp turns, byte-for-byte (vertices, faces, ring frames), and the same
//      mesh drives both rendering payload and export.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

import { normalizeCurveSpec, createCurve, PolylineCurve } from '../src/core/curve.js';
import { sampleAdaptive } from '../src/core/sampler.js';
import {
  buildFrames, evaluateFrames, transportFrames, closeFrames, degenerateTangents, transportVector,
} from '../src/core/frames.js';
import { deriveSection, createScaleTrack, profileIssues, circleProfile } from '../src/core/section.js';
import { buildSweep } from '../src/core/sweep.js';
import { edgeConnectivity, meshTopologyContract } from '../src/core/topology.js';
import { runSweep, geometryPayload } from '../src/core/pipeline.js';
import { toOBJ, toSTLAscii, toSTLBinary } from '../src/core/exporter.js';
import { v, dot } from '../src/core/vec3.js';

const GOLDEN = JSON.parse(readFileSync(new URL('./fixtures/golden-sweep.json', import.meta.url), 'utf8'));
const round = (x) => Math.round(x * 1e12) / 1e12;
const sha = (o) => createHash('sha256').update(JSON.stringify(o)).digest('hex');

// ---------------------------------------------------------------------------
// Section contract
// ---------------------------------------------------------------------------

test('section contract: deriveSection exposes points, count, orientation and state', () => {
  const sec = deriveSection({ type: 'circle', radius: 0.6, segments: 12 });
  assert.equal(sec.count, 12);
  assert.equal(sec.points.length, 12);
  assert.equal(sec.state.polygonClosed, true);
  assert.equal(sec.state.winding, 'ccw');
  assert.equal(sec.orientation.ccw, true);
  assert.ok(sec.orientation.area > 0);
  assert.deepEqual(sec.issues, []);
});

test('section orientation is reported, never repaired: clockwise input stays clockwise', () => {
  const ccw = circleProfile(0.5, 8);
  const cw = [...ccw].reverse();
  const a = deriveSection({ type: 'custom', points: ccw });
  const b = deriveSection({ type: 'custom', points: cw });
  assert.equal(a.orientation.ccw, true);
  assert.equal(b.orientation.ccw, false, 'reversed point order must be reported as cw');
  assert.equal(b.state.winding, 'cw');
  // Points are not reordered by derivation.
  assert.deepEqual(b.points, cw);
});

test('section contract rejects a spec without a profile type instead of defaulting', () => {
  assert.throws(() => deriveSection({}), /spec\.type is required/);
  assert.throws(() => deriveSection(undefined), /spec\.type is required/);
});

test('section size track: absent keyframes are identity; authored keyframes are honoured', () => {
  const identity = deriveSection({ type: 'circle', radius: 1, segments: 8 });
  assert.deepEqual(identity.evalScale(0), { su: 1, sv: 1 });
  assert.deepEqual(identity.evalScale(0.5), { su: 1, sv: 1 });
  assert.deepEqual(identity.scaleIssues, []);

  const tapered = deriveSection({
    type: 'circle', radius: 1, segments: 8,
    scaleKeyframes: [{ u: 0, su: 1, sv: 1 }, { u: 1, su: 0.2, sv: 0.5 }],
  });
  assert.deepEqual(tapered.evalScale(0), { su: 1, sv: 1 });
  assert.ok(Math.abs(tapered.evalScale(1).su - 0.2) < 1e-12);
  assert.ok(Math.abs(tapered.evalScale(1).sv - 0.5) < 1e-12);
});

test('section non-positive scale is surfaced as an error, not clamped', () => {
  const sec = deriveSection({
    type: 'circle', radius: 1, segments: 8,
    scaleKeyframes: [{ u: 0, su: 1, sv: 1 }, { u: 1, su: 0, sv: -1 }],
  });
  assert.ok(sec.scaleIssues.some((i) => i.type === 'non_positive_scale'));
});

// ---------------------------------------------------------------------------
// Sampler interface state
// ---------------------------------------------------------------------------

test('sampler state: closed path exposes a seam and records seam de-duplication', () => {
  const circle = createCurve({ type: 'circle', params: { center: [0, 0, 0], radius: 3, e1: [1, 0, 0], e2: [0, 1, 0] } });
  const sampled = sampleAdaptive(circle, { chordTolerance: 0.05 });
  assert.equal(sampled.state.closed, true);
  assert.deepEqual(sampled.state.seam, { u: 0, index: 0 });
  assert.equal(sampled.state.duplicateSeamRemoved, true);
  assert.ok(sampled.stations.at(-1).u < 1, 'the u=1 duplicate must be dropped from the station list');
  assert.deepEqual(sampled.state.degenerate, []);
});

test('sampler state: open path reports closed=false and no seam', () => {
  const line = createCurve({ type: 'line', params: { a: [0, 0, 0], b: [4, 0, 0] } });
  const sampled = sampleAdaptive(line);
  assert.equal(sampled.state.closed, false);
  assert.equal(sampled.state.seam, null);
  assert.equal(sampled.state.duplicateSeamRemoved, false);
});

// ---------------------------------------------------------------------------
// Frames layered entry + compatibility adapter
// ---------------------------------------------------------------------------

test('frames layered entry rejects missing closed flag and missing degenerate list', () => {
  const sampled = sampleAdaptive(new PolylineCurve([v(0, 0, 0), v(5, 0, 0), v(5, 5, 0)], false));
  assert.throws(() => evaluateFrames(sampled.stations, {}), /state\.closed must be an explicit boolean/);
  assert.throws(
    () => evaluateFrames(sampled.stations, { closed: false }),
    /state\.degenerate must be an explicit array/,
  );
  assert.throws(() => evaluateFrames([], { closed: false, degenerate: [] }), /at least two entries/);
});

test('frames layers compose: transportFrames + closeFrames equals evaluateFrames', () => {
  const circle = createCurve({ type: 'circle', params: { center: [0, 0, 0], radius: 4, e1: [1, 0, 0], e2: [0, 1, 0] } });
  const sampled = sampleAdaptive(circle, { chordTolerance: 0.02 });
  const state = { closed: true, degenerate: degenerateTangents(sampled.stations) };
  const transported = transportFrames(sampled.stations, state, { frameMode: 'rmf' });
  const closed = closeFrames(transported.frames, sampled.stations, state);
  const layered = evaluateFrames(sampled.stations, state, { frameMode: 'rmf' });
  for (let i = 0; i < layered.frames.length; i++) {
    assert.deepEqual(layered.frames[i].n, closed.frames[i].n);
    assert.deepEqual(layered.frames[i].b, closed.frames[i].b);
  }
});

test('frames legacy adapter matches the layered entry for curve-sweep callers', () => {
  const pl = new PolylineCurve(
    [[1, 0, 0], [0.707, 0.707, 0.3], [0, 1, -0.35], [-0.707, 0.707, 0.35],
      [-1, 0, 0], [-0.707, -0.707, -0.2], [0, -0.7, 0.1], [0.7, -0.707, -0.15]],
    true,
  );
  const sampled = sampleAdaptive(pl, { maxSegmentLength: 1e9 });
  const legacy = buildFrames(sampled, { frameMode: 'fixed-up', upVector: [0, 0, 1] });
  const layered = evaluateFrames(sampled.stations, {
    closed: true,
    degenerate: degenerateTangents(sampled.stations),
  }, { frameMode: 'fixed-up', upVector: [0, 0, 1] });
  assert.equal(legacy.frames.length, layered.frames.length);
  for (let i = 0; i < legacy.frames.length; i++) {
    assert.deepEqual(legacy.frames[i].n, layered.frames[i].n);
    assert.deepEqual(legacy.frames[i].t, layered.frames[i].t);
  }
  assert.equal(legacy.mode, layered.mode);
  assert.deepEqual(legacy.twistCorrection, layered.twistCorrection);
});

test('frames degenerate-tangent state is listed explicitly on a reversal', () => {
  const sampled = sampleAdaptive(new PolylineCurve([v(0, 0, 0), v(4, 0, 0), v(0.5, 0, 0)], false));
  const state = { closed: false, degenerate: degenerateTangents(sampled.stations) };
  assert.ok(state.degenerate.some((d) => d.reason === 'tangent_reversal'));
  const result = evaluateFrames(sampled.stations, state, { frameMode: 'rmf' });
  assert.ok(result.diagnostics.some((d) => d.type === 'path_reversal'));
});

// ---------------------------------------------------------------------------
// Mesh connection evidence
// ---------------------------------------------------------------------------

test('edge connectivity: a straight capped tube is coherently oriented', () => {
  const line = createCurve({ type: 'line', params: { a: [0, 0, 0], b: [6, 0, 0] } });
  const sampled = sampleAdaptive(line);
  const section = deriveSection({ type: 'circle', radius: 0.5, segments: 10 });
  const frames = evaluateFrames(sampled.stations, { closed: false, degenerate: [] });
  const mesh = buildSweep({
    stations: sampled.stations, totalLength: sampled.totalLength, closed: false,
    frames, section, options: {},
  });
  const edge = edgeConnectivity(mesh);
  assert.equal(edge.boundary, 0);
  assert.equal(edge.nonManifold, 0);
  assert.equal(edge.inconsistent, 0, 'every shared edge must be traversed in opposite directions');
  assert.equal(edge.coherent, true);
});

test('edge connectivity distinguishes watertight from coherent winding', () => {
  // Two triangles sharing an edge in the SAME direction, plus two isolated triangles so
  // every edge count is accounted for. Edge counts look manifold on the pair, but the
  // winding contradicts. The contract must not call this coherent.
  const mesh = {
    vertices: [[0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0], [3, 0, 0], [3, 1, 0]],
    faces: [[0, 1, 2], [0, 1, 3], [4, 5, 0]],
    closed: false,
  };
  const edge = edgeConnectivity(mesh);
  assert.equal(edge.nonManifold, 0);
  assert.equal(edge.sharedTwice, 1, 'exactly one edge is shared by two triangles');
  assert.equal(edge.inconsistent, 1);
  assert.equal(edge.coherent, false);
});

test('topology contract keeps legacy watertight flag but adds coherence', () => {
  const line = createCurve({ type: 'line', params: { a: [0, 0, 0], b: [5, 0, 0] } });
  const sampled = sampleAdaptive(line);
  const section = deriveSection({ type: 'circle', radius: 0.4, segments: 8 });
  const frames = evaluateFrames(sampled.stations, { closed: false, degenerate: [] });
  const mesh = buildSweep({ stations: sampled.stations, totalLength: sampled.totalLength, closed: false, frames, section });
  const topo = meshTopologyContract(mesh);
  assert.equal(topo.watertight, true);
  assert.equal(topo.edge.coherent, true);
});

test('known pre-existing winding defect is reported, never masked by a default', () => {
  // The per-panel outward test in the ring stitcher can pick opposite windings for
  // adjacent quads on a curved path. That defect predates the refactor; the refactor
  // freezes the external geometry byte-for-byte (see the differential tests) but must
  // surface the incoherence instead of letting a "watertight" flag hide it.
  const result = runSweep({
    curve: { type: 'circle', params: { center: [0, 0, 0], radius: 5, e1: [1, 0, 0], e2: [0, 1, 0] } },
    profile: { type: 'circle', radius: 0.4, segments: 8 },
    sampling: { chordTolerance: 0.5 },
  });
  const edge = result.report.topology.edge;
  assert.equal(edge.boundary, 0);
  assert.equal(edge.nonManifold, 0);
  assert.ok(edge.inconsistent > 0, 'curved sweep carries winding contradictions');
  assert.equal(edge.coherent, false);
  assert.equal(result.report.topology.watertight, true, 'edge-incidence flag still says watertight');
  assert.ok(
    result.report.warnings.some((w) => w.type === 'not_coherently_oriented'),
    'the incoherence is surfaced as an explicit warning, not hidden',
  );
});

// ---------------------------------------------------------------------------
// Differential evidence: refactor vs. frozen pre-refactor geometry
// ---------------------------------------------------------------------------

const GOLDEN_SPECS = {
  closed_circle_rmf: [{
    curve: { type: 'circle', params: { center: [0, 0, 0], radius: 5, e1: [1, 0, 0], e2: [0, 1, 0] } },
    profile: { type: 'ellipse', rx: 0.7, ry: 0.45, segments: 20 },
    scaleKeyframes: [{ u: 0, su: 1, sv: 1 }, { u: 1, su: 0.6, sv: 0.8 }],
    sampling: { chordTolerance: 0.02 },
  }],
  closed_square_ribbon_fixedup: [{
    curve: { type: 'polyline', params: { points: [[0, 0, 0], [5, 0, 0], [5, 5, 0], [0, 5, 0]], closed: true } },
    profile: { type: 'ribbon', width: 0.8, thickness: 0.15, cornerSteps: 3 },
    frameMode: 'fixed-up', upVector: [0, 0, 1], miterLimit: 2.5,
  }],
  sharp_turn_miter: [{
    curve: { type: 'polyline', params: { points: [[0, 0, 0], [6, 0, 0], [6, 6, 0], [2, 6, 0], [2, 3, 0]], closed: false } },
    profile: { type: 'roundedRect', width: 0.9, height: 0.9, radius: 0.2, cornerSteps: 3 },
    miterLimit: 2.5,
  }],
  sharp_turn_bevel: [{
    curve: { type: 'polyline', params: { points: [[0, 0, 0], [5, 0, 0], [5 + Math.cos(5 * Math.PI / 6), Math.sin(5 * Math.PI / 6), 0]], closed: false } },
    profile: { type: 'circle', radius: 0.5, segments: 12 },
    miterLimit: 1.5,
  }],
  reversal: [{
    curve: { type: 'polyline', params: { points: [[0, 0, 0], [4, 0, 0], [0.5, 0, 0]], closed: false } },
    profile: { type: 'circle', radius: 0.4, segments: 10 },
    miterLimit: 2,
  }],
  helix_open_rmf: [{
    curve: { type: 'helix', params: { center: [0, 0, 0], r: 2.5, turns: 4, rise: 9, e1: [1, 0, 0], e2: [0, 1, 0], e3: [0, 0, 1] } },
    profile: { type: 'circle', radius: 0.4, segments: 18 },
    sampling: { chordTolerance: 0.03 },
  }],
};

for (const goldenCase of GOLDEN.cases) {
  test(`differential: ${goldenCase.name} matches the frozen pre-refactor geometry`, () => {
    const [spec] = GOLDEN_SPECS[goldenCase.name];
    const result = runSweep(spec);
    const { mesh, sampled, frameResult, section } = result;
    const orientation = profileIssues(section.points);

    // Sampler + frames + section agree with the frozen record.
    assert.equal(sampled.stations.length, goldenCase.stationCount);
    assert.equal(sampled.stations.filter((s) => s.corner).length, goldenCase.cornerCount);
    assert.equal(round(sampled.totalLength), goldenCase.totalLength);
    assert.equal(sampled.closed, goldenCase.closedPath);
    assert.equal(frameResult.mode, goldenCase.frameMode);
    assert.equal(section.orientation.ccw, goldenCase.sectionOrientation.ccw);
    assert.equal(round(section.orientation.area), goldenCase.sectionOrientation.area);
    assert.equal(
      sha(sampled.stations.map((s) => ({ u: round(s.u), p: s.position.map(round), t: s.tangent.map(round), ti: s.tangentIn.map(round), corner: !!s.corner }))),
      goldenCase.stationsSha,
    );
    assert.equal(
      sha(frameResult.frames.map((f) => ({ t: f.t.map(round), n: f.n.map(round), b: f.b.map(round) }))),
      goldenCase.framesSha,
    );
    assert.deepEqual(frameResult.diagnostics.map((d) => d.type), goldenCase.frameDiagnostics);

    // Mesh connectivity and exact geometry agree.
    assert.equal(mesh.vertices.length, goldenCase.mesh.vertexCount);
    assert.equal(mesh.faces.length, goldenCase.mesh.faceCount);
    assert.equal(mesh.ringCount, goldenCase.mesh.ringCount);
    assert.equal(mesh.profileCount, goldenCase.mesh.profileCount);
    assert.equal(mesh.closed, goldenCase.mesh.closed);
    assert.deepEqual(mesh.rings.map((r) => r.kind), goldenCase.mesh.ringKinds);
    assert.deepEqual(mesh.seam, goldenCase.mesh.seam);
    assert.equal(mesh.capRule, goldenCase.mesh.capRule);
    assert.equal(
      sha(mesh.vertices.map((p) => p.map(round))),
      goldenCase.mesh.verticesSha,
      'vertex positions must not drift',
    );
    assert.equal(sha(mesh.faces), goldenCase.mesh.facesSha, 'triangle indices must not drift');
    assert.equal(
      sha(mesh.rings.map((r) => ({
        p: r.position.map(round), n: r.frame.n.map(round), b: r.frame.b.map(round),
        t: r.frame.t.map(round), su: round(r.su), sv: round(r.sv), kind: r.kind, u: round(r.u),
      }))),
      goldenCase.mesh.ringsSha,
      'ring frames and section scales must not drift',
    );
    assert.equal(mesh.diagnostics.map((d) => d.type).join(','), goldenCase.sweepDiagnostics.join(','));
    assert.equal(orientation.ccw, goldenCase.sectionOrientation.ccw);
  });
}

// ---------------------------------------------------------------------------
// Render and export share one geometry result
// ---------------------------------------------------------------------------

test('render payload and export consume the same mesh object', () => {
  const result = runSweep({
    curve: { type: 'polyline', params: { points: [[0, 0, 0], [4, 0, 0], [4, 4, 0]], closed: false } },
    profile: { type: 'circle', radius: 0.4, segments: 10 },
  });
  const payload = geometryPayload(result);
  assert.equal(payload.vertices, result.mesh.vertices, 'payload reuses mesh vertex array');
  assert.equal(payload.faces, result.mesh.faces, 'payload reuses mesh face array');
  assert.equal(payload.vertices.length, result.report.mesh.vertexCount);
  // Exporters serialize exactly that mesh.
  assert.equal((toOBJ(result.mesh).match(/^v /gm) || []).length, result.mesh.vertices.length);
  assert.equal((toSTLAscii(result.mesh).match(/facet normal/g) || []).length, result.mesh.faces.length);
  assert.equal(toSTLBinary(result.mesh).readUInt32LE(80), result.mesh.faces.length);
});

test('payload carries section orientation and edge-connection evidence', () => {
  const result = runSweep({
    curve: { type: 'circle', params: { center: [0, 0, 0], radius: 4, e1: [1, 0, 0], e2: [0, 1, 0] } },
    profile: { type: 'ribbon', width: 0.6, thickness: 0.12 },
    frameMode: 'fixed-up', upVector: [0, 1, 0],
  });
  const payload = result.geometry;
  assert.equal(payload.sectionState.polygonClosed, true);
  assert.ok(['ccw', 'cw'].includes(payload.sectionState.winding));
  assert.equal(typeof payload.topology.edge.inconsistent, 'number');
  assert.equal(typeof payload.topology.edge.coherent, 'boolean');
  assert.equal(payload.profile.length, result.section.count);
});

// ---------------------------------------------------------------------------
// Old samples keep running
// ---------------------------------------------------------------------------

test('legacy flat curve spec (persisted old projects) still normalizes and builds', () => {
  const flat = {
    type: 'polyline',
    closed: true,
    points: [[1, 0, 0], [0.707, 0.707, 0.3], [0, 1, -0.35], [-0.707, 0.707, 0.35],
      [-1, 0, 0], [-0.707, -0.707, -0.2], [0, -1, 0.1], [0.707, -0.707, -0.15]],
  };
  const normalized = normalizeCurveSpec(flat);
  assert.deepEqual(normalized, { type: 'polyline', params: { points: flat.points, closed: true } });
  const result = runSweep({
    curve: flat,
    profile: { type: 'circle', radius: 0.05, segments: 12 },
    frameMode: 'fixed-up',
  });
  assert.ok(result.mesh.vertices.length > 0);
  assert.equal(result.mesh.closed, true);
  assert.equal(result.report.errors.length, 0);
});

test('legacy flat spec is rejected when a required field is missing (no defaults mask it)', () => {
  assert.throws(() => normalizeCurveSpec({ type: 'line', a: [0, 0, 0] }), /missing "b"/);
  assert.throws(() => normalizeCurveSpec({ type: 'nope' }), /Unknown curve type/);
});

test('legacy buildSweep positional entry still produces a mesh for old callers', () => {
  const sampled = sampleAdaptive(new PolylineCurve([v(0, 0, 0), v(5, 0, 0), v(5, 5, 0)], false));
  const frames = buildFrames(sampled, { frameMode: 'rmf' });
  const points = circleProfile(0.5, 12);
  const mesh = buildSweep(sampled, frames, points, createScaleTrack([{ u: 0, su: 1, sv: 1 }, { u: 1, su: 1, sv: 1 }]), { miterLimit: 4 });
  assert.ok(mesh.faces.length > 0);
  assert.equal(mesh.profileCount, 12);
  assert.ok(mesh.rings.some((r) => r.kind === 'miter'));
});

test('sweep contract rejects incomplete state instead of falling through to defaults', () => {
  assert.throws(() => buildSweep({}), /contract form requires an object|stations/);
  assert.throws(() => buildSweep({ stations: [] }), /section\.points/);
  assert.throws(() => buildSweep({ stations: [], section: { points: [] } }), /frames\.frames/);
  const section = deriveSection({ type: 'circle', radius: 1, segments: 6 });
  assert.throws(
    () => buildSweep({ stations: [{ position: [0, 0, 0], tangent: [1, 0, 0], u: 0, s: 0 }], frames: { frames: [{ t: [1, 0, 0], n: [0, 1, 0], b: [0, 0, 1] }] }, section }),
    /closed to be an explicit boolean path state/,
  );
});

test('section polygon state is distinct from path closed state', () => {
  const openPathSpec = {
    curve: { type: 'line', params: { a: [0, 0, 0], b: [5, 0, 0] } },
    profile: { type: 'circle', radius: 0.3, segments: 8 },
  };
  const open = runSweep(openPathSpec);
  assert.equal(open.report.sampling.state.closed, false, 'path is open');
  assert.equal(open.report.section.state.polygonClosed, true, 'section is always a closed polygon');
  assert.equal(open.mesh.closed, false);
});
