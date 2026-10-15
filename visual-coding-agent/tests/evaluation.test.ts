import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluate } from '../src/evaluation/checks.js';
import type { Observation } from '../src/plugins/client.js';
import type { Task } from '../src/models/types.js';

test('a prefilled success label and no-op click cannot pass the interaction check', () => {
  const task: Task = { id: 'noop', title: 'Title', description: 'Description', accent: '#0f766e', button_label: 'Click', success_text: 'Done' };
  function observation(tool: string, data: Record<string, unknown>, params: Record<string, unknown> = {}): Observation {
    return { tool, params, images: [], result: { contract_version: '0.1.0', ok: true, run_id: 'noop', revision: 'revision', data, artifacts: [], error: null, duration_ms: 0 } };
  }
  const inspect = () => observation('browser_inspect', { elements: [{ selector: 'h1', text: 'Title' }, { selector: '#action', styles: { backgroundColor: 'rgb(15, 118, 110)' } }, { selector: '#status', text: 'Done' }] });
  const state = { task, revision: 'revision', history: [inspect(), observation('browser_act', {}, { action: 'click', selector: '#action' }), inspect()] };
  assert.equal(evaluate(state).interaction, 'failed');
  (state.history[0]!.result.data.elements as { text?: string }[])[2]!.text = 'Ready';
  assert.equal(evaluate(state).interaction, 'passed');
});
