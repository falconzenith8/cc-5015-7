import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createProject, updateDraft, adoptVersion, rollback, ProjectStore } from '../src/core/project.js';
import { runSweep } from '../src/core/pipeline.js';

const seedSpec = {
  curve: { type: 'line', params: { a: [0, 0, 0], b: [5, 0, 0] } },
  profile: { type: 'circle', radius: 0.5, segments: 12 },
  scaleKeyframes: [{ u: 0, su: 1, sv: 1 }, { u: 1, su: 1, sv: 1 }],
};

test('parameter edits keep the source curve; adoption snapshots an immutable version', () => {
  const project = createProject({ name: 'p', spec: seedSpec });
  const originalSource = JSON.stringify(project.sourceCurve);
  updateDraft(project, { miterLimit: 3.25 });
  assert.equal(JSON.stringify(project.sourceCurve), originalSource, 'source curve untouched');
  assert.equal(project.draft.miterLimit, 3.25);

  const result = runSweep(project.draft);
  const v1 = adoptVersion(project, project.draft, result.report, 'g1.json');
  assert.equal(v1.spec.miterLimit, 3.25);

  // Mutate the draft again; the stored version must not change.
  updateDraft(project, { miterLimit: 1.1 });
  assert.equal(project.versions[0].spec.miterLimit, 3.25, 'version snapshot is immutable');
  assert.equal(project.draft.miterLimit, 1.1);

  rollback(project, 'v1');
  assert.equal(project.draft.miterLimit, 3.25, 'rollback restores adopted parameters');
});

test('ProjectStore persists projects across instances', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sweep-store-'));
  try {
    const store1 = new ProjectStore(fs, path, dir);
    const project = createProject({ name: 'persisted', spec: seedSpec });
    const result = runSweep(project.draft);
    adoptVersion(project, project.draft, result.report, 'g.json');
    store1.upsert(project);

    const store2 = new ProjectStore(fs, path, dir);
    const reloaded = store2.get(project.id);
    assert.equal(reloaded.name, 'persisted');
    assert.equal(reloaded.versions.length, 1);
    assert.deepEqual(reloaded.sourceCurve, project.sourceCurve);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
