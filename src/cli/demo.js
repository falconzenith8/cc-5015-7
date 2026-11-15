// CLI demo: builds the four validation paths (line, circle, helix, sharp polyline),
// prints the diagnostic report for each, and writes OBJ/STL artifacts to output/.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runSweep } from '../core/pipeline.js';
import { toOBJ, toSTLAscii, toSTLBinary } from '../core/exporter.js';

const outDir = new URL('../../output/', import.meta.url).pathname;
mkdirSync(outDir, { recursive: true });

const cases = [
  {
    name: 'line_tube',
    spec: {
      curve: { type: 'line', params: { a: [0, 0, 0], b: [12, 0, 0] } },
      profile: { type: 'circle', radius: 0.8, segments: 24 },
      scaleKeyframes: [{ u: 0, su: 1, sv: 1 }, { u: 0.5, su: 0.4, sv: 0.4 }, { u: 1, su: 1, sv: 1 }],
    },
  },
  {
    name: 'circle_ring',
    spec: {
      curve: { type: 'circle', params: { center: [0, 0, 0], radius: 6, e1: [1, 0, 0], e2: [0, 1, 0] } },
      profile: { type: 'ellipse', rx: 0.7, ry: 0.5, segments: 28 },
    },
  },
  {
    name: 'helix_tube',
    spec: {
      curve: {
        type: 'helix',
        params: { center: [0, 0, 0], r: 2.5, turns: 4, rise: 9, e1: [1, 0, 0], e2: [0, 1, 0], e3: [0, 0, 1] },
      },
      profile: { type: 'circle', radius: 0.4, segments: 18 },
    },
  },
  {
    name: 'sharp_polyline_miter',
    spec: {
      curve: {
        type: 'polyline',
        params: { points: [[0, 0, 0], [6, 0, 0], [6, 6, 0], [2, 6, 0], [2, 3, 0]], closed: false },
      },
      profile: { type: 'roundedRect', width: 0.9, height: 0.9, radius: 0.2, cornerSteps: 3 },
      miterLimit: 2.5,
    },
  },
  {
    name: 'closed_square_ribbon',
    spec: {
      curve: { type: 'polyline', params: { points: [[0, 0, 0], [5, 0, 0], [5, 5, 0], [0, 5, 0]], closed: true } },
      profile: { type: 'ribbon', width: 0.8, thickness: 0.15, cornerSteps: 3 },
      frameMode: 'fixed-up',
      upVector: [0, 0, 1],
    },
  },
];

for (const { name, spec } of cases) {
  const result = runSweep(spec);
  const { report, mesh } = result;
  writeFileSync(join(outDir, `${name}.obj`), toOBJ(mesh, name));
  writeFileSync(join(outDir, `${name}.stl`), toSTLAscii(mesh, name));
  writeFileSync(join(outDir, `${name}.bin.stl`), toSTLBinary(mesh));
  console.log(`\n=== ${name} ===`);
  console.log(`stations=${report.sampling.stationCount} corners=${report.sampling.cornerCount} ` +
    `rings=${report.mesh.ringCount} verts=${report.mesh.vertexCount} faces=${report.mesh.faceCount} ` +
    `closed=${report.mesh.closed} watertight=${report.topology.watertight} ` +
    `coherent=${report.topology.edge.coherent} ` +
    `section=${report.section.state.winding}(${report.section.orientation.area.toFixed(5)})`);
  if (report.twistCorrection) console.log(`twist correction: ${report.twistCorrection.totalAngle.toFixed(5)} rad distributed`);
  if (report.errors.length) console.log('ERRORS:', JSON.stringify(report.errors, null, 1));
  if (report.warnings.length) {
    for (const w of report.warnings) console.log(`WARN [${w.stage}/${w.type}]`, w.message || '');
  }
  if (!report.errors.length && !report.warnings.length) console.log('no diagnostics: clean sweep');
}

// Negative control: a deliberately self-intersecting profile and a too-tight bend.
const bad = runSweep({
  curve: { type: 'circle', params: { center: [0, 0, 0], radius: 0.4, e1: [1, 0, 0], e2: [0, 1, 0] } },
  profile: { type: 'custom', points: [[-1, -1], [1, 1], [1, -1], [-1, 1]] },
});
console.log('\n=== negative control (invalid profile + tight bend) ===');
console.log('errors:', bad.report.errors.map((e) => e.type).join(', '));
console.log('warnings:', bad.report.warnings.map((w) => w.type).join(', '));
console.log('\nDisclaimer:', bad.report.disclaimer);
