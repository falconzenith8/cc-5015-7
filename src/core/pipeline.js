// End-to-end sweep pipeline and the unified diagnostic report.
//
// The pipeline is the single place where the four sweep modules are joined:
//   curve.js     -> sampler.js (path sampling + explicit closed/degenerate state)
//                -> frames.js  (layered frame evaluation state)
//                -> section.js (section points, orientation, size track)
//                -> sweep.js   (mesh, composed from topology.js connection primitives)
// Rendering (web/app.js) and export (exporter.js) both consume `geometry` below, so
// there is exactly one geometric result per build.
import { createCurve } from './curve.js';
import { sampleAdaptive } from './sampler.js';
import { evaluateFrames, degenerateTangents } from './frames.js';
import { deriveSection } from './section.js';
import { buildSweep } from './sweep.js';
import { meshTopologyContract } from './topology.js';
import { findMeshSelfIntersections } from './collisions.js';

export const DISCLAIMER =
  'This output is a geometric representation only. It is not certified for manufacture; ' +
  'wall thickness, tolerances, printability and jewelry manufacturability require separate validation.';

export function runSweep(spec) {
  const errors = [];
  const warnings = [];

  // 1. Source curve (retained untouched in the project layer).
  if (!spec || !spec.curve) throw new TypeError('runSweep: spec.curve is required');
  const curve = createCurve(spec.curve);

  // 2. Adaptive sampling under curvature / error control. The result carries explicit
  //    interface state: whether the path is closed, its seam, and degenerate tangents.
  const sampled = sampleAdaptive(curve, spec.sampling || {});
  for (const w of sampled.warnings) warnings.push({ stage: 'sampling', ...w });

  // 3. Explainable moving frame, from the sampler's explicit state. The layered entry
  //    rejects a missing closed flag or degenerate list instead of defaulting them.
  const frameState = {
    closed: sampled.state.closed,
    degenerate: degenerateTangents(sampled.stations),
  };
  const frameResult = evaluateFrames(sampled.stations, frameState, {
    frameMode: spec.frameMode || 'rmf',
    upVector: spec.upVector,
  });
  for (const d of frameResult.diagnostics) warnings.push({ stage: 'frames', ...d });

  // 4. Section points, orientation and size track. Input issues are hard errors.
  //    The size track belongs to the section contract: it scales the 2D points along u,
  //    so keyframes are handed to the section module alongside the profile type.
  const section = deriveSection({
    ...(spec.profile || {}),
    scaleKeyframes: spec.scaleKeyframes,
    scaleInterpolation: spec.scaleInterpolation,
  });
  for (const issue of section.issues) errors.push({ stage: 'section', ...issue });
  for (const issue of section.scaleIssues) errors.push({ stage: 'scale', ...issue });

  // 5. Sweep surface from the module contract (closed comes from the path state).
  const mesh = buildSweep({
    stations: sampled.stations,
    totalLength: sampled.totalLength,
    closed: sampled.closed,
    frames: frameResult,
    section,
    options: { miterLimit: spec.miterLimit, bevelOffset: spec.bevelOffset },
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

  // 6. Exact mesh self-intersection scan (unless the section was already invalid).
  let intersections = { hits: [], truncated: false };
  if (!section.issues.some((i) => i.type === 'self_intersection')) {
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

  // 7. Topology / watertightness, including winding coherence evidence.
  const topology = meshTopologyContract(mesh);
  if (!topology.edge.coherent) {
    warnings.push({
      stage: 'topology',
      type: 'not_coherently_oriented',
      boundaryCount: topology.edge.boundary,
      inconsistentEdges: topology.edge.inconsistent,
    });
  }
  // 8. The single shared geometry result used by both rendering and export.
  const geometry = geometryPayload({ sampled, frameResult, section, mesh });

  const report = {
    curve: spec.curve,
    frameMode: frameResult.mode,
    frameState: frameResult.state,
    twistCorrection: frameResult.twistCorrection,
    sampling: {
      stationCount: sampled.stations.length,
      totalLength: sampled.totalLength,
      closed: sampled.closed,
      cornerCount: sampled.stations.filter((s) => s.corner).length,
      options: sampled.options,
      state: sampled.state,
    },
    section: {
      type: (spec.profile || {}).type ?? null,
      count: section.count,
      orientation: section.orientation,
      state: section.state,
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

  return { curve, sampled, frameResult, section, mesh, geometry, report };
}

// Compact, plain-JSON geometry shared by the server (export), the browser (three.js)
// and the payload tests. Keeping this in the pipeline means render and export can never
// disagree about which mesh is current.
export function geometryPayload(result) {
  const { mesh, sampled, frameResult, section } = result;
  return {
    vertices: mesh.vertices,
    faces: mesh.faces,
    rings: mesh.rings.map((r) => ({
      position: r.position,
      n: r.frame.n,
      b: r.frame.b,
      t: r.frame.t,
      su: r.su,
      sv: r.sv,
      kind: r.kind,
      u: r.u,
    })),
    profile: section.points,
    path: sampled.stations.map((s, i) => ({
      position: s.position,
      tangent: s.tangent,
      n: frameResult.frames[i].n,
      b: frameResult.frames[i].b,
      corner: !!s.corner,
    })),
    closed: sampled.closed,
    sectionState: section.state,
    topology: meshTopologyContract(mesh),
  };
}
