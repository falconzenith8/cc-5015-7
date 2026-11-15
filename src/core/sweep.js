// Sweep mesh generation: a continuous ring-based sweep surface.
//
// The builder is a composition of four independent stages, each with its own module:
//   section.js   closed 2D section points, orientation, size keyframes
//   sampler.js   path stations with explicit closed/degenerate interface state
//   frames.js    moving frames (layered entry + legacy adapter)
//   topology.js  ring emission, quad stitching, end caps, edge connectivity
//
// Every path station produces one cross-section ring whose vertices are placed by the
// moving frame; consecutive rings are connected quad-by-quad. Sharp corners use a true
// miter joint, falling back to a bevel when the miter limit is exceeded. Open paths are
// closed with fan end caps; closed paths wrap to one seam. This is a real swept surface,
// not a chain of independent cylinders.
import { normalize, cross, dot, add, sub, scale, length } from './vec3.js';
import { stitchRings, capRing, emitRingVertices, meshTopologyContract } from './topology.js';

function miterData(tIn, tOut) {
  const cosHalf = Math.sqrt(Math.max(0, (1 + dot(tIn, tOut)) / 2));
  const miter = cosHalf > 1e-9 ? 1 / cosHalf : Infinity;
  const tMiter = normalize(add(tIn, tOut));
  // A genuine reversal is a near 180-degree fold (dot close to -1), not merely a sharp
  // but finite corner; 150-degree jewelry turns must still get a normal miter/bevel.
  return { miter, tMiter, cosHalf, reversed: dot(tIn, tOut) < -0.95 };
}

// Rotate frame (n, b) so its tangent becomes tNew, keeping the component along the
// bisector (parallel transport across the corner).
function rotateFrameToTangent(frame, tNew) {
  const t = normalize(tNew);
  const n = projectPerpendicular(frame.n, t);
  return { t, n, b: normalize(cross(t, n)) };
}

function projectPerpendicular(n, t) {
  const d = dot(n, t);
  return normalize([n[0] - d * t[0], n[1] - d * t[1], n[2] - d * t[2]]);
}

// The sweep builder accepts either:
//   buildSweep(stations, frames, points, evalScale, options)   legacy positional form
//   buildSweep({ stations, frames, section, options })         module contract form
// The section argument is normally the result of section.js deriveSection(); a raw
// point array is accepted for legacy callers. Section orientation is reported, never
// silently flipped: a clockwise section is surfaced as a warning, not repaired.
export function buildSweep(input, frameResult, profilePoints, evalScale, options = {}) {
  let sampled;
  let frames;
  let section;
  let points;
  let opt;
  let scaleAt;
  // Dispatch on the call shape, not on guessed fields.
  //   buildSweep(stationsOrSampled, frameResult, points, evalScale, options)  legacy
  //   buildSweep({ stations, closed, frames, section, options })            contract
  // Legacy callers always pass the frame result as the second argument; the contract
  // form never does. Anything else is rejected here instead of crashing on undefined.
  const legacyCall = frameResult !== undefined;
  if (!legacyCall && (!input || typeof input !== 'object' || Array.isArray(input))) {
    throw new TypeError('buildSweep: contract form requires an object with stations/frames/section');
  }
  if (legacyCall) {
    // Legacy positional call from existing curve-sweep callers: a station array or a
    // sampler result, plus the frame result passed separately.
    sampled = Array.isArray(input)
      ? { stations: input, closed: !!frameResult.state?.closed }
      : input;
    frames = frameResult.frames;
    points = profilePoints;
    section = { points, orientation: null, state: { polygonClosed: true } };
    scaleAt = evalScale;
    opt = options;
  } else {
    if (!Array.isArray(input.stations)) {
      throw new TypeError('buildSweep: contract requires a stations array');
    }
    if (!input.section || !Array.isArray(input.section.points)) {
      throw new TypeError('buildSweep: contract requires section.points (use deriveSection)');
    }
    if (!input.frames || !Array.isArray(input.frames.frames)) {
      throw new TypeError('buildSweep: contract requires frames.frames');
    }
    if (typeof input.section.evalScale !== 'function') {
      throw new TypeError('buildSweep: contract requires section.evalScale');
    }
    if (typeof input.closed !== 'boolean') {
      throw new TypeError('buildSweep: contract requires closed to be an explicit boolean path state');
    }
    sampled = {
      stations: input.stations,
      totalLength: input.totalLength,
      closed: input.closed,
    };
    frames = input.frames.frames;
    section = input.section;
    points = section.points;
    scaleAt = section.evalScale;
    opt = input.options || {};
  }
  const miterLimit = opt.miterLimit ?? 2;
  const bevelOffset = opt.bevelOffset ?? 0.35; // fraction of local ring spacing
  const stations = sampled.stations;
  const m = points.length;
  const diagnostics = [];
  const rings = [];

  function addRing(station, frame, su, sv, kind, cornerInfo = null) {
    rings.push({
      position: station.position,
      frame,
      su,
      sv,
      u: station.u,
      s: station.s,
      kind,
      corner: cornerInfo,
    });
  }

  // --- Walk stations, splitting corners into miter or bevel rings ---
  for (let i = 0; i < stations.length; i++) {
    const st = stations[i];
    const { su, sv } = scaleAt(stations.length > 1 ? st.s / Math.max(sampled.totalLength, 1e-12) : 0);
    if (st.corner) {
      const md = miterData(st.tangentIn, st.tangent);
      if (md.reversed) {
        diagnostics.push({
          type: 'path_reversal',
          u: st.u,
          message: 'Tangent reversal at corner: inserted zero-width bevel ring; surface pinches locally.',
        });
        const fZero = rotateFrameToTangent(frames[i], md.tMiter.length ? md.tMiter : st.tangent);
        addRing(st, fZero, su * 0.001, sv * 0.001, 'pinch', st.corner);
      } else if (md.miter <= miterLimit) {
        // True miter: one ring on the bisector plane, scaled by cos(theta/2).
        const fMiter = rotateFrameToTangent(frames[i], md.tMiter);
        addRing(st, fMiter, su / md.cosHalf, sv / md.cosHalf, 'miter', st.corner);
      } else {
        // Bevel: two rings offset along the incoming/outgoing segments.
        const prevSt = stations[i - 1];
        const nextSt = stations[(i + 1) % stations.length];
        const dIn = length(sub(st.position, prevSt.position));
        const dOut = length(sub(nextSt.position, st.position));
        const offIn = bevelOffset * dIn;
        const offOut = bevelOffset * dOut;
        const posIn = sub(st.position, scale(st.tangentIn, offIn));
        const posOut = add(st.position, scale(st.tangent, offOut));
        const fIn = rotateFrameToTangent(frames[i], st.tangentIn);
        const fOut = rotateFrameToTangent(frames[i], st.tangent);
        rings.push({ position: posIn, frame: fIn, su, sv, u: st.u, s: st.s, kind: 'bevel-in', corner: st.corner });
        rings.push({ position: posOut, frame: fOut, su, sv, u: st.u, s: st.s, kind: 'bevel-out', corner: st.corner });
        diagnostics.push({
          type: 'miter_limit',
          u: st.u,
          miter: md.miter,
          miterLimit,
          turnAngleDeg: st.corner.turnAngle * 180 / Math.PI,
          message: `Miter factor ${md.miter.toFixed(2)} exceeds limit ${miterLimit}; bevel joint used.`,
        });
      }
    } else {
      addRing(st, frames[i], su, sv, 'normal');
    }
  }

  // --- Emit vertices ---
  const mesh = { vertices: [], faces: [], ringCount: rings.length, profileCount: m, rings };
  for (const ring of rings) {
    emitRingVertices(mesh, ring, points);
  }

  // --- Connect consecutive rings ---
  for (let i = 0; i < rings.length - 1; i++) {
    stitchRings(mesh, i, i + 1, m, points, rings);
  }
  if (sampled.closed) {
    // Closing seam: last ring wraps onto the first at the u=0 seam.
    stitchRings(mesh, rings.length - 1, 0, m, points, rings);
  } else {
    // End caps: fan triangles, normals outward along ±T.
    const first = rings[0];
    const last = rings[rings.length - 1];
    capRing(mesh, 0, m, first.position, scale(first.frame.t, -1));
    capRing(mesh, rings.length - 1, m, last.position, last.frame.t);
  }

  // --- Section orientation interface state (never silently repaired) ---
  const sectionArea = section.orientation ? section.orientation.area : null;
  if (Number.isFinite(sectionArea) && Math.abs(sectionArea) <= 1e-12) {
    diagnostics.push({
      type: 'section_orientation',
      winding: 'degenerate',
      area: sectionArea,
      message: 'Section encloses zero signed area; winding is undefined.',
    });
  } else if (section.orientation && section.orientation.ccw === false) {
    diagnostics.push({
      type: 'section_orientation',
      winding: 'cw',
      area: sectionArea,
      message: 'Section points wind clockwise; surface triangle winding follows the authored order.',
    });
  }

  // --- Bend penetration / tight-curvature diagnostics ---
  for (let i = 0; i < stations.length; i++) {
    const st = stations[i];
    if (!Number.isFinite(st.curvature) || st.curvature <= 1e-12) continue;
    const { su, sv } = scaleAt(st.s / Math.max(sampled.totalLength, 1e-12));
    const radiusOfCurvature = 1 / st.curvature;
    const maxHalf = Math.max(su, sv) * Math.max(...points.map((p) => Math.hypot(p[0], p[1])));
    if (maxHalf >= radiusOfCurvature) {
      diagnostics.push({
        type: 'bend_self_intersection_risk',
        u: st.u,
        radiusOfCurvature,
        sectionReach: maxHalf,
        message: 'Section reaches the curvature center: inner wall folds/intersects locally.',
      });
    }
  }

  mesh.diagnostics = diagnostics;
  mesh.closed = sampled.closed;
  mesh.seam = sampled.closed ? { ringIndex: 0, u: 0, rule: 'single seam at u=0, wrap-around quads' } : null;
  mesh.capRule = sampled.closed ? 'no caps (closed loop)' : 'fan caps at both ends, outward normals along -T and +T';
  mesh.faceRule = 'quads split into 2 triangles with outward-facing winding verified against the frame radial direction';
  mesh.section = {
    count: m,
    winding: section.orientation ? (section.orientation.ccw ? 'ccw' : 'cw') : null,
    orientationReported: !!section.orientation,
  };
  mesh.edge = meshTopologyContract(mesh).edge;
  return mesh;
}

export function computeVertexNormals(mesh) {
  const normals = mesh.vertices.map(() => [0, 0, 0]);
  for (const f of mesh.faces) {
    const [a, b, c] = f;
    const n = cross(sub(mesh.vertices[b], mesh.vertices[a]),
      sub(mesh.vertices[c], mesh.vertices[a]));
    for (const idx of f) {
      normals[idx][0] += n[0];
      normals[idx][1] += n[1];
      normals[idx][2] += n[2];
    }
  }
  return normals.map((n) => (length(n) > 1e-14 ? normalize(n) : [0, 0, 0]));
}
