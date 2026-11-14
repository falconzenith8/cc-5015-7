// Sweep mesh generation: a continuous ring-based sweep surface.
//
// Every path station produces one cross-section ring whose vertices are placed by the
// moving frame; consecutive rings are connected quad-by-quad. Sharp corners use a true
// miter joint, falling back to a bevel when the miter limit is exceeded. Open paths are
// closed with fan end caps; closed paths wrap to one seam. This is a real swept surface,
// not a chain of independent cylinders.
import { normalize, cross, dot, add, sub, scale, length, projectPerpendicular } from './vec3.js';

const ringIndex = (ringCount, ring, j, m) => ring * m + (j % m);

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

function ringVertices(ring, profile) {
  const m = profile.length;
  const verts = new Array(m);
  for (let j = 0; j < m; j++) {
    const q = profile[j];
    const x = q[0] * ring.su;
    const y = q[1] * ring.sv;
    verts[j] = add(ring.position, add(scale(ring.frame.n, x), scale(ring.frame.b, y)));
  }
  return verts;
}

// Connect ring A (index ia) to ring B (index ib), which may be coincident (bevel/seam).
// Winding is chosen so each triangle normal points away from the sweep axis.
function connectRings(mesh, ia, ib, m, rings, profile) {
  const A = rings[ia];
  const B = rings[ib];
  const dir = lengthSq(sub(B.position, A.position)) > 1e-16
    ? normalize(sub(B.position, A.position))
    : A.frame.t;
  for (let j = 0; j < m; j++) {
    const j2 = (j + 1) % m;
    const a = ringIndex(0, ia, j, m);
    const b = ringIndex(0, ia, j2, m);
    const c = ringIndex(0, ib, j2, m);
    const d = ringIndex(0, ib, j, m);
    // Representative radial direction of this panel; orientation check vs. direction.
    const radial = normalize(add(scale(A.frame.n, profile[j][0]), scale(A.frame.b, profile[j][1])));
    const outwardFirst = dot(cross(sub(mesh.vertices[b], mesh.vertices[a]),
      sub(mesh.vertices[c], mesh.vertices[a])), radial) >= 0;
    if (outwardFirst && dot(dir, radial) >= -1e-9 || !outwardFirst && dot(dir, radial) < -1e-9) {
      mesh.faces.push([a, b, c], [a, c, d]);
    } else {
      mesh.faces.push([a, c, b], [a, d, c]);
    }
  }
}

function lengthSq(a) {
  return dot(a, a);
}

function capFaces(mesh, ringIndexValue, m, center, outwardNormal) {
  const start = ringIndexValue * m;
  const centerIndex = mesh.vertices.length;
  mesh.vertices.push(center);
  for (let j = 0; j < m; j++) {
    const a = start + j;
    const b = start + ((j + 1) % m);
    const nrm = cross(sub(mesh.vertices[b], mesh.vertices[a]),
      sub(mesh.vertices[centerIndex], mesh.vertices[a]));
    if (dot(nrm, outwardNormal) >= 0) mesh.faces.push([centerIndex, a, b]);
    else mesh.faces.push([centerIndex, b, a]);
  }
}

export function buildSweep(sampled, frameResult, profile, evalScale, options = {}) {
  const miterLimit = options.miterLimit ?? 2;
  const bevelOffset = options.bevelOffset ?? 0.35; // fraction of local ring spacing
  const stations = sampled.stations;
  const frames = frameResult.frames;
  const m = profile.length;
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
    const { su, sv } = evalScale(stations.length > 1 ? st.s / Math.max(sampled.totalLength, 1e-12) : 0);
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
    const verts = ringVertices(ring, profile);
    for (const q of verts) mesh.vertices.push(q);
  }

  // --- Connect consecutive rings ---
  for (let i = 0; i < rings.length - 1; i++) {
    connectRings(mesh, i, i + 1, m, rings, profile);
  }
  if (sampled.closed) {
    // Closing seam: last ring wraps onto the first at the u=0 seam.
    connectRings(mesh, rings.length - 1, 0, m, rings, profile);
  } else {
    // End caps: fan triangles, normals outward along ±T.
    const first = rings[0];
    const last = rings[rings.length - 1];
    capFaces(mesh, 0, m, first.position, scale(first.frame.t, -1));
    capFaces(mesh, rings.length - 1, m, last.position, last.frame.t);
  }

  // --- Bend penetration / tight-curvature diagnostics ---
  for (let i = 0; i < stations.length; i++) {
    const st = stations[i];
    if (!Number.isFinite(st.curvature) || st.curvature <= 1e-12) continue;
    const { su, sv } = evalScale(st.s / Math.max(sampled.totalLength, 1e-12));
    const radiusOfCurvature = 1 / st.curvature;
    const maxHalf = Math.max(su, sv) * Math.max(...profile.map((p) => Math.hypot(p[0], p[1])));
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
