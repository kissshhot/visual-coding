import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { runAgent } from '../src/agent/runner.js';
import { OfflineAdapter } from '../src/models/offline.js';
import type { ModelAdapter, Task } from '../src/models/types.js';

const serverPath = fileURLToPath(new URL('../../visual-coding-plugins/dist/mcp/stdio.js', import.meta.url));
const task: Task = { id: 'integration', title: 'Observe and improve', description: 'A real MCP and Chromium integration test.', accent: '#0f766e', button_label: 'Verify', success_text: 'Verified by a real click' };

test('Agent -> MCP child process -> file edits -> real Chromium -> observed repair -> verified delivery', { timeout: 90_000 }, async t => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'visual-agent-e2e-'));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  const report = await runAgent({ workspace, runId: 'integration', serverPath, task, adapter: new OfflineAdapter(), browserChannel: process.env.VC_TEST_BROWSER_CHANNEL === 'chrome' ? 'chrome' : undefined });
  assert.equal(report.status, 'completed');
  assert.equal(report.mode, 'offline-demo');
  assert.equal(report.evaluation.runtime, 'passed');
  assert.equal(report.evaluation.specified_dom_checks, 'passed');
  assert.equal(report.evaluation.interaction, 'passed');
  assert.equal(report.evaluation.visual_quality, 'not_evaluated');
  assert.match(await fs.readFile(path.join(workspace, 'styles.css'), 'utf8'), /--accent:#0f766e/);
  const trace = JSON.parse(await fs.readFile(report.trajectory_path, 'utf8'));
  const patches = trace.history.filter((h: { tool: string }) => h.tool === 'project_patch');
  assert.equal(patches.length, 2);
  assert.notEqual(patches[0].result.revision, patches[1].result.revision);
  const captures = trace.history.filter((h: { tool: string }) => h.tool === 'browser_capture');
  assert.equal(captures.length, 3);
  assert.equal(captures[2].result.revision, report.revision);
  const colors = trace.history.filter((h: { tool: string }) => h.tool === 'browser_inspect');
  assert.notEqual(colors[0].result.data.elements[1].styles.backgroundColor, colors[1].result.data.elements[1].styles.backgroundColor);
  for (const artifact of report.artifacts) {
    const bytes = await fs.readFile(artifact.path);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), artifact.sha256);
    if (artifact.mime_type === 'image/png') {
      assert.equal(bytes.subarray(1, 4).toString(), 'PNG');
      assert.equal(bytes.readUInt32BE(16), 1200);
      assert.equal(bytes.readUInt32BE(20), 800);
    }
  }
  const url = trace.history.find((h: { tool: string }) => h.tool === 'project_run').result.data.url;
  await assert.rejects(fetch(url), 'Plugin preview should close when the MCP client disconnects');
});

test('step budget terminates instead of claiming success', { timeout: 15_000 }, async t => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'visual-agent-budget-'));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  await assert.rejects(runAgent({ workspace, runId: 'budget', serverPath, task, adapter: new OfflineAdapter(), maxSteps: 1 }), /step budget/);
});

test('offline demo preserves an existing stylesheet even when index.html is absent', { timeout: 15_000 }, async t => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'visual-agent-existing-'));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  await fs.writeFile(path.join(workspace, 'styles.css'), '/* existing project */');
  await assert.rejects(runAgent({ workspace, runId: 'existing', serverPath, task, adapter: new OfflineAdapter() }), /empty project/);
  assert.equal(await fs.readFile(path.join(workspace, 'styles.css'), 'utf8'), '/* existing project */');
  await assert.rejects(fs.access(path.join(workspace, 'index.html')));
});

test('completion without current-revision observations is rejected', { timeout: 15_000 }, async t => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'visual-agent-finish-'));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  const adapter: ModelAdapter = { name: 'test', async decide() { return { type: 'finish', summary: 'Unverified' }; } };
  await assert.rejects(runAgent({ workspace, runId: 'finish', serverPath, task, adapter }), /Completion rejected/);
});

test('deadline aborts a stalled adapter', { timeout: 15_000 }, async t => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'visual-agent-timeout-'));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  const adapter: ModelAdapter = { name: 'stalled', async decide() { return new Promise(() => {}); } };
  await assert.rejects(runAgent({ workspace, runId: 'timeout', serverPath, task, adapter, timeoutMs: 1500 }), /timeout|aborted/i);
});
