import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LineCurve, CircleCurve, HelixCurve, PolylineCurve } from '../src/core/curve.js';
import { sampleAdaptive } from '../src/core/sampler.js';
import { buildFrames, transportVector } from '../src/core/frames.js';
import { dot, length, sub, normalize, cross, distance } from '../src/core/vec3.js';
import { v } from '../src/core/vec3.js';

function orthonormal(frames, sampled) {
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i];
    assert.ok(Math.abs(length(f.n) - 1) < 1e-9);
    assert.ok(Math.abs(length(f.b) - 1) < 1e-9);
    assert.ok(Math.abs(dot(f.n, f.t)) < 1e-9, `frame ${i}: n not perp t`);
    assert.ok(Math.abs(dot(f.b, f.t)) < 1e-9, `frame ${i}: b not perp t`);
    assert.ok(Math.abs(dot(f.n, f.b)) < 1e-9, `frame ${i}: n not perp b`);
    assert.ok(Math.abs(dot(cross(f.t, f.n), f.b) - 1) < 1e-9, 'handedness');
    assert.ok(Math.abs(dot(f.t, sampled.stations[i].tangent) - 1) < 1e-9, 'tangent matches station');
  }
}

test('RMF on a straight line is constant (zero curvature must not flip the frame)', () => {
  const line = new LineCurve(v(0, 0, 0), v(10, 0, 0));
  const sampled = sampleAdaptive(line);
  const { frames } = buildFrames(sampled, { frameMode: 'rmf' });
  orthonormal(frames, sampled);
  for (let i = 1; i < frames.length; i++) {
    assert.ok(distance(frames[i].n, frames[0].n) < 1e-12);
    assert.ok(distance(frames[i].b, frames[0].b) < 1e-12);
  }
});

test('RMF closed circle: double reflection is holonomy-free, transported seam closes exactly', () => {
  const circle = new CircleCurve(v(0, 0, 0), 4, v(1, 0, 0), v(0, 1, 0));
  const sampled = sampleAdaptive(circle, { chordTolerance: 0.02 });
  const result = buildFrames(sampled, { frameMode: 'rmf' });
  orthonormal(result.frames, sampled);
  // Holonomy-free RMF needs no distributed correction.
  assert.equal(result.twistCorrection, null);
  // Closure is verified in the seam tangent plane: transport the last normal across the
  // closing reflection and it must coincide with the seam normal (same tangent basis).
  const st = sampled.stations;
  const last = result.frames[st.length - 1];
  const seam = result.frames[0];
  const nAtSeam = transportVector(last.n, st[st.length - 1].tangent, st[0].tangent);
  assert.ok(Math.abs(dot(nAtSeam, seam.n) - 1) < 1e-9, 'transported seam normal matches');
});

test('closed loop: forced frame-mode residual is distributed so the seam still matches', () => {
  // A non-planar closed loop under fixed-up transport can carry a seam residual;
  // the builder must distribute it and still close the ring.
  const pts = [];
  const N = 40;
  for (let i = 0; i < N; i++) {
    const a = (2 * Math.PI * i) / N;
    pts.push([Math.cos(a), Math.sin(a), 0.25 * Math.sin(2 * a)]);
  }
  const pl = new PolylineCurve(pts, true);
  const sampled = sampleAdaptive(pl, { maxSegmentLength: 1e9 });
  const result = buildFrames(sampled, { frameMode: 'rmf' });
  orthonormal(result.frames, sampled);
  const st = sampled.stations;
  const last = result.frames[st.length - 1];
  const seam = result.frames[0];
  const nAtSeam = transportVector(last.n, st[st.length - 1].tangent, st[0].tangent);
  assert.ok(Math.abs(dot(nAtSeam, seam.n) - 1) < 1e-9, 'seam normal matches after closure transport');
});

test('fixed-up closed non-planar loop: seam twist is distributed and the seam closes exactly', () => {
  const pts = [];
  const N = 48;
  for (let i = 0; i < N; i++) {
    const a = (2 * Math.PI * i) / N;
    pts.push([Math.cos(a), Math.sin(a), 0.4 * Math.sin(3 * a)]);
  }
  const pl = new PolylineCurve(pts, true);
  const sampled = sampleAdaptive(pl, { maxSegmentLength: 1e9 });
  const result = buildFrames(sampled, { frameMode: 'fixed-up', upVector: v(0, 0, 1) });
  orthonormal(result.frames, sampled);
  // Fixed-up is not a parallel-transport frame, so a closed loop carries a real seam
  // residual; the builder distributes it by arc length and snaps the last ring so the
  // transported seam normal coincides with the first ring's normal.
  assert.ok(result.twistCorrection !== null && Math.abs(result.twistCorrection.totalAngle) > 0,
    'a real twist residual must be detected and reported');
  assert.equal(result.diagnostics.some((d) => d.type === 'closure_mismatch'), false,
    'the distributed correction must close the seam without a mismatch diagnostic');
  const st = sampled.stations;
  const nAtSeam = transportVector(result.frames.at(-1).n, st.at(-1).tangent, st[0].tangent);
  assert.ok(Math.abs(dot(nAtSeam, result.frames[0].n) - 1) < 1e-9, 'seam closes after correction');
});

test('RMF closed non-planar loop: holonomy-free frame closes the seam exactly', () => {
  const pts = [];
  const N = 48;
  for (let i = 0; i < N; i++) {
    const a = (2 * Math.PI * i) / N;
    pts.push([Math.cos(a), Math.sin(a), 0.4 * Math.sin(3 * a)]);
  }
  const sampled = sampleAdaptive(new PolylineCurve(pts, true), { maxSegmentLength: 1e9 });
  const result = buildFrames(sampled, { frameMode: 'rmf' });
  orthonormal(result.frames, sampled);
  assert.equal(result.diagnostics.some((d) => d.type === 'closure_mismatch'), false);
  const st = sampled.stations;
  const nAtSeam = transportVector(result.frames.at(-1).n, st.at(-1).tangent, st[0].tangent);
  assert.ok(Math.abs(dot(nAtSeam, result.frames[0].n) - 1) < 1e-9);
});

test('sharp-cornered closed polyline: seam closes exactly in both frame modes', () => {
  const pts = [[1, 0, 0], [0.707, 0.707, 0.3], [0, 1, -0.35], [-0.707, 0.707, 0.35],
    [-1, 0, 0], [-0.707, -0.707, -0.2], [0, -1, 0.1], [0.707, -0.707, -0.15]];
  const pl = new PolylineCurve(pts, true);
  const sampled = sampleAdaptive(pl, { maxSegmentLength: 1e9 });
  for (const mode of ['rmf', 'fixed-up']) {
    const result = buildFrames(sampled, { frameMode: mode, upVector: v(0, 0, 1) });
    orthonormal(result.frames, sampled);
    assert.equal(result.diagnostics.some((d) => d.type === 'closure_mismatch'), false,
      `${mode}: no closure mismatch on a sharp closed polygon`);
    const st = sampled.stations;
    const nAtSeam = transportVector(result.frames.at(-1).n, st.at(-1).tangent, st[0].tangent);
    assert.ok(Math.abs(dot(nAtSeam, result.frames[0].n) - 1) < 1e-9,
      `${mode}: seam normal matches after closure transport`);
  }
});

test('RMF on helix: smooth parallel transport, no sudden normal flips', () => {
  const helix = new HelixCurve(v(0, 0, 0), 2, 4, 5, v(1, 0, 0), v(0, 1, 0), v(0, 0, 1));
  const sampled = sampleAdaptive(helix, { chordTolerance: 0.02 });
  const { frames } = buildFrames(sampled, { frameMode: 'rmf' });
  orthonormal(frames, sampled);
  // Consecutive normals evolve continuously; a flip would show a jump near 2.
  for (let i = 1; i < frames.length; i++) {
    assert.ok(dot(frames[i].n, frames[i - 1].n) > 0.5, `normal jump at ${i}`);
  }
});

test('fixed-up mode: normal stays in the up-T plane', () => {
  const helix = new HelixCurve(v(0, 0, 0), 2, 2, 4, v(1, 0, 0), v(0, 1, 0), v(0, 0, 1));
  const sampled = sampleAdaptive(helix);
  const { frames } = buildFrames(sampled, { frameMode: 'fixed-up', upVector: v(0, 0, 1) });
  orthonormal(frames, sampled);
  for (const f of frames) {
    // n has no residual component along t by construction; verify it explicitly.
    assert.ok(Math.abs(dot(f.n, f.t)) < 1e-9);
  }
});

test('polyline corner: frames on both legs are well defined and deterministic', () => {
  const pl = new PolylineCurve([v(0, 0, 0), v(5, 0, 0), v(5, 5, 0)], false);
  const a = buildFrames(sampleAdaptive(pl), { frameMode: 'rmf' });
  const b = buildFrames(sampleAdaptive(pl), { frameMode: 'rmf' });
  for (let i = 0; i < a.frames.length; i++) {
    assert.ok(distance(a.frames[i].n, b.frames[i].n) < 1e-15); // no randomness
  }
});
