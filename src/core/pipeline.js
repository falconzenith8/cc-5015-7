// End-to-end sweep pipeline and the unified diagnostic report.
import { createCurve } from './curve.js';
import { sampleAdaptive } from './sampler.js';
import { buildFrames } from './frames.js';
import { createProfile, profileIssues, createScaleTrack, scaleIssues } from './profile.js';
import { buildSweep } from './sweep.js';
import { findMeshSelfIntersections } from './collisions.js';

export const DISCLAIMER =
  'This output is a geometric representation only. It is not certified for manufacture; ' +
  'wall thickness, tolerances, printability and jewelry manufacturability require separate validation.';

function topologyCheck(mesh) {
  const edgeCount = new Map();
  const edgeKey = (a, b) => (a < b ? a + '>' + b : b + '>' + a);
  for (const f of mesh.faces) {
    for (let k = 0; k < 3; k++) {
      const e = edgeKey(f[k], f[(k + 1) % 3]);
      edgeCount.set(e, (edgeCount.get(e) || 0) + 1);
    }
  }
  const boundary = [];
  let nonManifold = 0;
  for (const [e, c] of edgeCount) {
    if (c === 1) boundary.push(e);
    else if (c !== 2) nonManifold++;
  }
  return {
    edgeCount: edgeCount.size,
    boundaryEdges: boundary,
    nonManifoldEdges: nonManifold,
    watertight: boundary.length === 0 && nonManifold === 0,
  };
}

export function runSweep(spec) {
  const errors = [];
  const warnings = [];

  // 1. Source curve (retained untouched in the project layer).
  const curve = createCurve(spec.curve);

  // 2. Adaptive sampling under curvature / error control.
  const sampled = sampleAdaptive(curve, spec.sampling || {});
  for (const w of sampled.warnings) warnings.push({ stage: 'sampling', ...w });

  // 3. Explainable moving frame.
  const frameResult = buildFrames(sampled, {
    frameMode: spec.frameMode || 'rmf',
    upVector: spec.upVector,
  });
  for (const d of frameResult.diagnostics) warnings.push({ stage: 'frames', ...d });

  // 4. Profile and size track.
  const profile = createProfile(spec.profile);
  const pCheck = profileIssues(profile);
  for (const issue of pCheck.issues) errors.push({ stage: 'profile', ...issue });
  const evalScale = createScaleTrack(spec.scaleKeyframes || [{ u: 0, su: 1, sv: 1 }, { u: 1, su: 1, sv: 1 }],
    spec.scaleInterpolation || 'linear');
  for (const issue of scaleIssues(evalScale)) errors.push({ stage: 'scale', ...issue });

  // 5. Sweep surface.
  const mesh = buildSweep(sampled, frameResult, profile, evalScale, {
    miterLimit: spec.miterLimit,
    bevelOffset: spec.bevelOffset,
  });
  // Coalesce per-station bend warnings into one record per type with a worst case.
  const sweepByType = new Map();
  for (const d of mesh.diagnostics) {
    const existing = sweepByType.get(d.type);
    if (!existing) sweepByType.set(d.type, { ...d, count: 1 });
    else {
      existing.count++;
      existing.u = d.u;
      if (d.radiusOfCurvature !== undefined) {
        existing.radiusOfCurvature = Math.min(existing.radiusOfCurvature, d.radiusOfCurvature);
      }
    }
  }
  for (const d of sweepByType.values()) warnings.push({ stage: 'sweep', ...d });

  // 6. Exact mesh self-intersection scan (unless the profile was already invalid).
  let intersections = { hits: [], truncated: false };
  if (!pCheck.issues.some((i) => i.type === 'self_intersection')) {
    intersections = findMeshSelfIntersections(mesh);
    const reportedHits = intersections.hits.slice(0, 10);
    for (const h of reportedHits) {
      warnings.push({
        stage: 'collision',
        type: 'mesh_self_intersection',
        faces: h.faces,
        rings: h.rings,
        point: h.point,
        message: 'Non-adjacent surface triangles cross; the solid locally interpenetrates.',
      });
    }
    if (intersections.hits.length > reportedHits.length || intersections.truncated) {
      warnings.push({
        stage: 'collision',
        type: 'mesh_self_intersection_truncated',
        hitCount: intersections.hits.length,
        truncated: intersections.truncated,
        message: 'Further self-intersections were not listed individually.',
      });
    }
  }

  // 7. Topology / watertightness.
  const topology = topologyCheck(mesh);
  if (!topology.watertight) {
    warnings.push({ stage: 'topology', type: 'not_watertight', boundaryCount: topology.boundaryEdges.length });
  }

  const report = {
    curve: spec.curve,
    frameMode: frameResult.mode,
    twistCorrection: frameResult.twistCorrection,
    sampling: {
      stationCount: sampled.stations.length,
      totalLength: sampled.totalLength,
      closed: sampled.closed,
      cornerCount: sampled.stations.filter((s) => s.corner).length,
      options: sampled.options,
    },
    mesh: {
      ringCount: mesh.ringCount,
      profileCount: mesh.profileCount,
      vertexCount: mesh.vertices.length,
      faceCount: mesh.faces.length,
      closed: mesh.closed,
      seam: mesh.seam,
      capRule: mesh.capRule,
      faceRule: mesh.faceRule,
    },
    topology,
    errors,
    warnings,
    manufacturable: false,
    disclaimer: DISCLAIMER,
  };

  return { curve, sampled, frameResult, profile, evalScale, mesh, report };
}
