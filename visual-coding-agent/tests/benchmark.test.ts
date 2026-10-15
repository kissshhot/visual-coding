import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { aggregate, type BenchmarkRow, type StageResult } from '../src/evaluation/benchmark.js';
import { TaskSchema } from '../src/models/types.js';
import { summarizeObservation, type Observation } from '../src/plugins/client.js';

test('fixed suite contains five distinct task families with different initial/reference source', async () => {
  const root = fileURLToPath(new URL('../benchmarks/v1/', import.meta.url));
  const manifest = JSON.parse(await fs.readFile(path.join(root, 'manifest.json'), 'utf8'));
  assert.equal(new Set(manifest.tasks).size, 5);
  const families = new Set();
  for (const id of manifest.tasks) {
    const task = TaskSchema.parse(JSON.parse(await fs.readFile(path.join(root, id, 'task.json'), 'utf8')));
    const checks = JSON.parse(await fs.readFile(path.join(root, id, 'checks.json'), 'utf8'));
    assert.equal(task.id, id); families.add(checks.family);
    assert.ok(checks.followup.length > 0 && checks.followup_assertions.length > 0);
    const initial = [], reference = [];
    for (const file of task.editable_files!) {
      initial.push(await fs.readFile(path.join(root, id, 'initial', file), 'utf8'));
      reference.push(await fs.readFile(path.join(root, id, 'reference', file), 'utf8'));
    }
    assert.notDeepEqual(initial, reference);
  }
  assert.equal(families.size, 5);
});

test('aggregate includes frozen agent failures, excludes invalid pairs, and keeps empty means null', () => {
  const stage = (ratio: number, interaction: boolean) => ({ states: { idle: { metrics: { changed_ratio: ratio } }, clicked: { metrics: { changed_ratio: ratio } } }, interaction_passed: interaction }) as StageResult;
  const rows = [
    { status: 'completed', initial: stage(0.4, false), final: stage(0, true), passed: true, model_requests: 4, input_tokens: 10, output_tokens: 5 },
    { status: 'agent_failed', initial: stage(0.2, false), final: stage(0.2, false), passed: false, model_requests: 2, input_tokens: 10, output_tokens: 5 },
    { status: 'infra_invalid', initial: stage(1, false), final: stage(1, false), passed: false, model_requests: 0, input_tokens: 0, output_tokens: 0 },
  ] as BenchmarkRow[];
  const result = aggregate(rows);
  assert.equal(result.scored, 2); assert.ok(Math.abs(result.initial_changed_ratio! - 0.3) < 1e-10);
  assert.equal(result.final_changed_ratio, 0.1); assert.equal(result.agent_failed, 1); assert.equal(result.infra_invalid, 1);
  assert.equal(result.final_interaction_passed, 1); assert.equal(result.model_requests, 6);
  assert.equal(aggregate([]).initial_changed_ratio, null);
});

test('comparison trace omits image payload while preserving its reference digest', () => {
  const observation = { tool: 'visual_compare', params: { reference: { data_base64: 'a'.repeat(1000), sha256: 'digest' }, candidate_id: 'capture' }, result: {}, images: [{ data: 'pixels', mimeType: 'image/png' }] } as Observation;
  const summarized = summarizeObservation(observation);
  assert.ok(!JSON.stringify(summarized).includes('data_base64'));
  assert.deepEqual(summarized.params.reference, { sha256: 'digest', encoded_bytes: 1000 });
  assert.equal(summarized.image_count, 1);
  assert.ok((observation.params.reference as { data_base64: string }).data_base64);
});
