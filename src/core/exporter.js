// Mesh export: Wavefront OBJ and STL (ASCII and little-endian binary).
import { cross, sub, normalize, length } from './vec3.js';

function faceNormal(mesh, face) {
  const [a, b, c] = face;
  const n = cross(sub(mesh.vertices[b], mesh.vertices[a]),
    sub(mesh.vertices[c], mesh.vertices[a]));
  return length(n) > 1e-14 ? normalize(n) : [0, 0, 0];
}

export function toOBJ(mesh, name = 'sweep') {
  const lines = [`# Sweep-craft export: ${name}`, '# Geometric model only - not certified for manufacture.'];
  for (const p of mesh.vertices) lines.push(`v ${p[0].toFixed(6)} ${p[1].toFixed(6)} ${p[2].toFixed(6)}`);
  lines.push(`g ${name}`);
  for (const f of mesh.faces) {
    const n = faceNormal(mesh, f);
    lines.push(`vn ${n[0].toFixed(6)} ${n[1].toFixed(6)} ${n[2].toFixed(6)}`);
  }
  let ni = 1;
  for (const f of mesh.faces) {
    lines.push(`f ${f[0] + 1}//${ni} ${f[1] + 1}//${ni} ${f[2] + 1}//${ni}`);
    ni++;
  }
  return lines.join('\n') + '\n';
}

export function toSTLAscii(mesh, name = 'sweep') {
  const lines = [`solid ${name}`, '// Geometric model only - not certified for manufacture.'];
  for (const f of mesh.faces) {
    const n = faceNormal(mesh, f);
    lines.push(` facet normal ${n[0].toExponential(6)} ${n[1].toExponential(6)} ${n[2].toExponential(6)}`);
    lines.push('  outer loop');
    for (const vi of f) {
      const p = mesh.vertices[vi];
      lines.push(`   vertex ${p[0].toExponential(6)} ${p[1].toExponential(6)} ${p[2].toExponential(6)}`);
    }
    lines.push('  endloop');
    lines.push(' endfacet');
  }
  lines.push(`endsolid ${name}`);
  return lines.join('\n') + '\n';
}

export function toSTLBinary(mesh) {
  const triCount = mesh.faces.length;
  const buffer = new ArrayBuffer(84 + triCount * 50);
  const dv = new DataView(buffer);
  // 80-byte header
  const header = 'Sweep-craft binary STL - geometric model, not certified for manufacture';
  for (let i = 0; i < 80; i++) dv.setUint8(i, i < header.length ? header.charCodeAt(i) : 0);
  dv.setUint32(80, triCount, true);
  let offset = 84;
  for (const f of mesh.faces) {
    const n = faceNormal(mesh, f);
    dv.setFloat32(offset, n[0], true);
    dv.setFloat32(offset + 4, n[1], true);
    dv.setFloat32(offset + 8, n[2], true);
    offset += 12;
    for (const vi of f) {
      const p = mesh.vertices[vi];
      dv.setFloat32(offset, p[0], true);
      dv.setFloat32(offset + 4, p[1], true);
      dv.setFloat32(offset + 8, p[2], true);
      offset += 12;
    }
    dv.setUint16(offset, 0, true);
    offset += 2;
  }
  return Buffer.from(buffer);
}
