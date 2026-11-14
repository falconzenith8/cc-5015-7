import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LineCurve, CircleCurve, HelixCurve, PolylineCurve } from '../src/core/curve.js';
import { sampleAdaptive } from '../src/core/sampler.js';
import { v, distance, dot, normalize } from '../src/core/vec3.js';

test('line: constant tangent, zero curvature, exact arc length', () => {
  const line = new LineCurve(v(0, 0, 0), v(10, 0, 0));
  assert.equal(line.curvature(), 0);
  assert.deepEqual(line.tangent(0.5), [1, 0, 0]);
  assert.equal(line.arcLength(), 10);
  const res = sampleAdaptive(line, { chordTolerance: 0.01, maxSegmentLength: 1e9 });
  assert.equal(res.stations.length, 2); // straight line needs only endpoints
});

test('circle: closed seam, uniform curvature 1/R, adaptive density rises with tighter tolerance', () => {
  const circle = new CircleCurve(v(0, 0, 0), 5, v(1, 0, 0), v(0, 1, 0));
  assert.ok(circle.closed);
  assert.equal(circle.curvature(), 0.2);
  const coarse = sampleAdaptive(circle, { chordTolerance: 0.1 });
  const fine = sampleAdaptive(circle, { chordTolerance: 0.005 });
  assert.ok(fine.stations.length > coarse.stations.length);
  // Seam: no duplicated u=1 station; first and last close the ring spatially.
  assert.equal(coarse.stations[coarse.stations.length - 1].u === 1, false);
  const gap = distance(coarse.stations[0].position, coarse.stations[coarse.stations.length - 1].position);
  assert.ok(gap > 0);
  // Tangent periodicity at the seam.
  assert.ok(Math.abs(dot(coarse.stations[0].tangent, circle.tangent(0)) - 1) < 1e-12);
});

test('circle sampling error stays below chord tolerance', () => {
  const circle = new CircleCurve(v(0, 0, 0), 3, v(1, 0, 0), v(0, 1, 0));
  const tol = 0.02;
  const res = sampleAdaptive(circle, { chordTolerance: tol });
  let worst = 0;
  const N = res.stations.length;
  for (let i = 0; i < N; i++) {
    const a = res.stations[i];
    const b = res.stations[(i + 1) % N];
    const ua = a.u;
    const ub = i === N - 1 ? 1 : b.u;
    for (let k = 1; k < 4; k++) {
      const u = ua + (ub - ua) * (k / 4);
      const p = circle.point(u);
      // point-to-chord distance
      const ab = [b.position[0] - a.position[0], b.position[1] - a.position[1], b.position[2] - a.position[2]];
      const w = [p[0] - a.position[0], p[1] - a.position[1], p[2] - a.position[2]];
      const len = Math.hypot(...ab);
      const t = Math.max(0, Math.min(1, (w[0] * ab[0] + w[1] * ab[1] + w[2] * ab[2]) / (len * len)));
      const foot = [a.position[0] + ab[0] * t, a.position[1] + ab[1] * t, a.position[2] + ab[2] * t];
      worst = Math.max(worst, distance(p, foot));
    }
  }
  assert.ok(worst <= tol * 1.05, `worst deviation ${worst} > tol ${tol}`);
});

test('helix: smooth open path, constant analytic curvature', () => {
  const helix = new HelixCurve(v(0, 0, 0), 2, 3, 6, v(1, 0, 0), v(0, 1, 0), v(0, 0, 1));
  assert.equal(helix.closed, false);
  const k = helix.curvature();
  assert.ok(k > 0 && Number.isFinite(k));
  const res = sampleAdaptive(helix, { chordTolerance: 0.01 });
  assert.ok(res.stations.length > 20);
  // monotonic arc length
  for (let i = 1; i < res.stations.length; i++) assert.ok(res.stations[i].s >= res.stations[i - 1].s);
});

test('sharp polyline: corner knot always retained with correct turn angle', () => {
  const pl = new PolylineCurve([v(0, 0, 0), v(5, 0, 0), v(5, 5, 0), v(0, 5, 0)], false);
  const corners = pl.corners();
  assert.equal(corners.length, 2);
  assert.ok(Math.abs(corners[0].turnAngle - Math.PI / 2) < 1e-12);
  const res = sampleAdaptive(pl, { chordTolerance: 1e-6 });
  const cornerStations = res.stations.filter((s) => s.corner);
  assert.equal(cornerStations.length, 2);
  // corner tangent in/out differ by 90 degrees
  const c = cornerStations[0];
  assert.ok(Math.abs(dot(c.tangentIn, c.tangent)) < 1e-12);
});

test('uniform-parameter trap: fine error tolerance forces refinement on a tight bend', () => {
  // A circle sampled with a loose vs strict tolerance must differ substantially,
  // proving geometry (not parameter index) drives station placement.
  const circle = new CircleCurve(v(0, 0, 0), 0.5, v(1, 0, 0), v(0, 1, 0));
  const loose = sampleAdaptive(circle, { chordTolerance: 0.05, maxSegmentLength: 1e9 });
  const strict = sampleAdaptive(circle, { chordTolerance: 0.0005, maxSegmentLength: 1e9 });
  assert.ok(strict.stations.length > loose.stations.length * 1.5);
  // And the strict build actually respects its tighter tolerance.
  assert.ok(strict.warnings.length === 0);
});
