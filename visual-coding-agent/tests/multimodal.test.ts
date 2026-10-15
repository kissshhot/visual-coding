import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { ChatCompletions, type ModelEvent } from '../src/models/chat-completions.js';
import { MultimodalAdapter } from '../src/models/multimodal.js';
import { OfflineAdapter, page, stylesheet } from '../src/models/offline.js';
import { runAgent } from '../src/agent/runner.js';
import type { Task, ModelAdapter } from '../src/models/types.js';

async function mockServer(handler: (body: any, req: IncomingMessage, res: ServerResponse) => void) {
  const server = createServer(async (req, res) => {
    try {
      const parts: Buffer[] = [];
      for await (const chunk of req) parts.push(Buffer.from(chunk));
      handler(JSON.parse(Buffer.concat(parts).toString()), req, res);
    } catch (error) { res.writeHead(500).end(String(error)); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  return { endpoint: `http://127.0.0.1:${address.port}/chat/completions`, close: () => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }) };
}
function reply(res: ServerResponse, value: unknown) {
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ id: 'mock-response', model: 'mock-vision', usage: { prompt_tokens: 20, completion_tokens: 10 }, choices: [{ finish_reason: 'tool_calls', message: { tool_calls: [{ type: 'function', function: { name: 'submit_result', arguments: JSON.stringify(value) } }] } }] }));
}
const serverPath = fileURLToPath(new URL('../../visual-coding-plugins/dist/mcp/stdio.js', import.meta.url));
const task: Task = { id: 'vision-test', title: 'Visual repair', description: 'Observe the screenshot.', accent: '#0f766e', button_label: 'Check', success_text: 'Interaction checked' };

test('multimodal HTTP wire -> real MCP/browser -> model review -> repair -> recapture -> final review', { timeout: 90000 }, async t => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'visual-model-e2e-'));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  await fs.writeFile(path.join(workspace, 'index.html'), page(task));
  await fs.writeFile(path.join(workspace, 'styles.css'), stylesheet('#b45309') + '\n.panel{transform:translateX(280px)}');
  let reviews = 0;
  let repairs = 0;
  const requests: any[] = [];
  const modelEvents: ModelEvent[] = [];
  const mock = await mockServer((body, req, res) => {
    assert.equal(req.headers.authorization, 'Bearer test-credential');
    assert.equal(body.tool_choice.function.name, 'submit_result');
    const content = body.messages[1].content;
    const prompt: string = content[0].text;
    const images = content.filter((p: any) => p.type === 'image_url');
    assert.equal(images.length, 1);
    const bytes = Buffer.from(images[0].image_url.url.split(',')[1], 'base64');
    assert.equal(bytes.readUInt32BE(16), 1200);
    assert.equal(bytes.readUInt32BE(20), 800);
    requests.push(body);
    if (prompt.startsWith('Inspect')) {
      reviews++;
      assert.ok(!prompt.includes('Current files'));
      assert.ok(!prompt.includes('translateX'));
      assert.ok(!prompt.includes('backgroundColor'));
      reply(res, reviews === 1
        ? { verdict: 'revise', summary: 'Right panel is clipped; button is brown.', issues: [{ description: 'Panel extends past the right edge.', region: 'right panel', severity: 'major' }] }
        : { verdict: 'pass', summary: 'The page is aligned and readable.', issues: [] });
    } else {
      repairs++;
      assert.match(prompt, /Right panel is clipped/);
      assert.match(prompt, /translateX/);
      reply(res, { summary: 'Restore the panel and accent.', files: [{ path: 'styles.css', content: stylesheet(task.accent) }] });
    }
  });
  t.after(mock.close);
  const model = new ChatCompletions({ endpoint: mock.endpoint, model: 'mock-vision', apiKey: 'test-credential', minIntervalMs: 0, onEvent: async e => { modelEvents.push(e); } });
  const report = await runAgent({ workspace, runId: 'multimodal', serverPath, task, adapter: new MultimodalAdapter(model), maxSteps: 30 });
  assert.equal(report.evaluation.visual_quality, 'model_review_passed');
  assert.equal(report.evaluation.interaction, 'passed');
  assert.equal(reviews, 3);
  assert.equal(repairs, 1);
  assert.equal(report.visual_reviews.length, 3);
  assert.notEqual(report.visual_reviews[0]?.revision, report.revision);
  const final = report.visual_reviews.at(-1)!;
  assert.equal(final.revision, report.revision);
  assert.equal(modelEvents.at(-1)?.images[0]?.sha256, final.screenshot_sha256);
  assert.equal(report.final_screenshot, report.artifacts.find(a => a.id === final.screenshot_id)?.path);
  assert.ok(!JSON.stringify(modelEvents).includes('test-credential'));
  assert.ok(!JSON.stringify(modelEvents).includes('data:image'));
  assert.equal(requests.length, 4);
});

test('HTTP transient error and malformed function arguments retry within a shared request budget', async t => {
  let requests = 0;
  const mock = await mockServer((_body, _req, res) => {
    requests++;
    if (requests === 1) res.writeHead(503).end('temporarily unavailable');
    else reply(res, requests === 2 ? { wrong: true } : { answer: 'ok' });
  });
  t.after(mock.close);
  const model = new ChatCompletions({ endpoint: mock.endpoint, model: 'mock', apiKey: 'key', maxRequests: 3, minIntervalMs: 0 });
  const result = await model.call('probe', 'Return answer.', [], z.object({ answer: z.string() }).strict(), AbortSignal.timeout(10000));
  assert.equal(result.value.answer, 'ok');
  await assert.rejects(model.call('probe', 'Return answer.', [], z.object({ answer: z.string() }), AbortSignal.timeout(1000)), /request budget/);
  assert.equal(requests, 3);
});

test('authentication failures do not retry or expose the upstream response body', async t => {
  let requests = 0;
  const events: ModelEvent[] = [];
  const mock = await mockServer((_body, _req, res) => { requests++; res.writeHead(401).end('private-key'); });
  t.after(mock.close);
  const model = new ChatCompletions({ endpoint: mock.endpoint, model: 'mock', apiKey: 'private-key', minIntervalMs: 0, onEvent: async e => { events.push(e); } });
  await assert.rejects(model.call('probe', 'Return answer.', [], z.object({ answer: z.string() }), AbortSignal.timeout(1000)), /HTTP 401/);
  assert.equal(requests, 1);
  assert.ok(!JSON.stringify(events).includes('private-key'));
});

test('cancelling a model call aborts an in-flight HTTP request', async t => {
  const mock = await mockServer(() => {});
  t.after(mock.close);
  const model = new ChatCompletions({ endpoint: mock.endpoint, model: 'mock', apiKey: 'key', minIntervalMs: 0 });
  await assert.rejects(model.call('probe', 'Return answer.', [], z.object({ answer: z.string() }), AbortSignal.timeout(100)), /timeout|aborted/i);
});

test('visual mode cannot finish with only DOM checks, even when the offline workflow passes', { timeout: 90000 }, async t => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'visual-no-review-'));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  const offline = new OfflineAdapter();
  const adapter: ModelAdapter = { name: 'missing-vision', requiresVisualReview: true, decide: (s, signal) => offline.decide(s, signal) };
  await assert.rejects(runAgent({ workspace, runId: 'no-review', serverPath, task, adapter }), /final screenshot has no passing visual review/);
});

test('review for a different screenshot is rejected before it can authorize delivery', { timeout: 15000 }, async t => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'visual-stale-review-'));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  const adapter: ModelAdapter = { name: 'stale-review', requiresVisualReview: true, async decide() {
    return { type: 'review', review: { revision: 'stale', screenshot_id: 'stale', screenshot_sha256: 'stale', model_call: 1, assessment: { verdict: 'pass', summary: 'Stale', issues: [] } } };
  } };
  await assert.rejects(runAgent({ workspace, runId: 'stale', serverPath, task, adapter }), /stale or unrelated/);
});

test('reverting to an old content hash still requires new browser observations', { timeout: 90000 }, async t => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'visual-revert-'));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  const offline = new OfflineAdapter();
  let phase = 0;
  const adapter: ModelAdapter = { name: 'revert-test', async decide(state, signal) {
    if (phase === 1) { phase++; return { type: 'tool', tool: 'project_patch', params: { files: [{ path: 'styles.css', content: stylesheet(task.accent) }] } }; }
    if (phase === 2) return { type: 'finish', summary: 'Old evidence must be rejected.' };
    const decision = await offline.decide(state, signal);
    if (decision.type !== 'finish') return decision;
    phase++;
    return { type: 'tool', tool: 'project_patch', params: { files: [{ path: 'styles.css', content: stylesheet('#ff0000') }] } };
  } };
  await assert.rejects(runAgent({ workspace, runId: 'revert', serverPath, task, adapter }), /current-revision checks/);
});

test('unresolved visual problems exhaust the repair budget without declaring success', { timeout: 90000 }, async t => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'visual-repair-budget-'));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  await fs.writeFile(path.join(workspace, 'index.html'), page(task));
  await fs.writeFile(path.join(workspace, 'styles.css'), stylesheet('#b45309'));
  let calls = 0;
  const mock = await mockServer((body, _req, res) => {
    calls++;
    reply(res, body.messages[1].content[0].text.startsWith('Inspect')
      ? { verdict: 'revise', summary: 'Still broken.', issues: [{ description: 'Panel is clipped.', region: 'right', severity: 'major' }] }
      : { summary: 'Try a fix.', files: [{ path: 'styles.css', content: stylesheet(task.accent) }] });
  });
  t.after(mock.close);
  const model = new ChatCompletions({ endpoint: mock.endpoint, model: 'mock', apiKey: 'key', minIntervalMs: 0 });
  await assert.rejects(runAgent({ workspace, runId: 'repair-budget', serverPath, task, adapter: new MultimodalAdapter(model, undefined, 1) }), /repair budget exhausted/);
  assert.equal(calls, 3);
});
