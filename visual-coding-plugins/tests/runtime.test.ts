import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { PluginRuntime } from '../src/core/runtime.js';

async function fixture(t: TestContext) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'visual-plugins-'));
  const workspace = path.join(dir, 'site');
  await fs.mkdir(workspace);
  const runtime = new PluginRuntime(workspace);
  t.after(async () => { await runtime.close(); await fs.rm(dir, { recursive: true, force: true }); });
  let revision: string | null = null;
  const call = async (name: Parameters<typeof runtime.invoke>[0], params: Record<string, unknown>, expected = revision) => {
    const { result } = await runtime.invoke(name, { workspace, run_id: 'test', revision: expected, params });
    if (result.ok) revision = result.revision;
    return result;
  };
  return { dir, workspace, runtime, call };
}

test('optimistic revision rejects stale edits and preserves newer code', async t => {
  const { call, workspace } = await fixture(t);
  const initial = await call('project_read', { path: 'index.html' });
  assert.equal(initial.data.exists, false);
  const first = await call('project_patch', { files: [{ path: 'index.html', content: '<h1>First</h1>' }] });
  assert.equal(first.ok, true);
  assert.notEqual(first.revision, initial.revision);
  const stale = await call('project_patch', { files: [{ path: 'index.html', content: 'Wrong' }] }, initial.revision);
  assert.equal(stale.error?.code, 'REVISION_CONFLICT');
  assert.equal(await fs.readFile(path.join(workspace, 'index.html'), 'utf8'), '<h1>First</h1>');
  await fs.writeFile(path.join(workspace, 'index.html'), '<h1>External edit</h1>');
  const external = await call('project_read', { path: 'index.html' });
  assert.equal(external.error?.code, 'REVISION_CONFLICT');
});

test('file operations reject traversal, reserved paths and symlinks', async t => {
  const { dir, workspace, call } = await fixture(t);
  await fs.writeFile(path.join(dir, 'outside.txt'), 'private fixture');
  await call('project_read', { path: 'index.html' });
  for (const file of ['../outside.txt', '/tmp/outside.txt', '.visual-coding/state.json', 'node_modules/a.js']) {
    const result = await call('project_read', { path: file });
    assert.equal(result.error?.code, 'INVALID_PATH');
  }
  await fs.symlink(path.join(dir, 'outside.txt'), path.join(workspace, 'linked.txt'));
  const result = await call('project_read', { path: 'linked.txt' }, null);
  assert.equal(result.error?.code, 'SYMLINK_DENIED');
});

test('rejects a workspace outside the server root', async t => {
  const { dir, runtime } = await fixture(t);
  const { result } = await runtime.invoke('project_read', { workspace: dir, run_id: 'test', revision: null, params: { path: 'outside.txt' } });
  assert.equal(result.error?.code, 'OUTSIDE_WORKSPACE');
});

test('validates every patch path before modifying any files', async t => {
  const { workspace, call } = await fixture(t);
  await call('project_read', { path: 'index.html' });
  const result = await call('project_patch', { files: [{ path: 'index.html', content: 'partial' }, { path: '../escape.html', content: 'escape' }] });
  assert.equal(result.error?.code, 'INVALID_PATH');
  await assert.rejects(fs.access(path.join(workspace, 'index.html')));
});

test('artifact writes preserve source revision and cannot escape through metadata symlinks', async t => {
  const { dir, workspace, call } = await fixture(t);
  const initial = await call('project_read', { path: 'index.html' });
  const saved = await call('artifact_save', { name: 'example', data: { answer: 42 } });
  assert.equal(saved.ok, true);
  assert.equal(saved.revision, initial.revision);
  assert.equal(JSON.parse(await fs.readFile(saved.artifacts[0]!.path, 'utf8')).answer, 42);
  await fs.rm(path.join(workspace, '.visual-coding'), { recursive: true });
  await fs.symlink(dir, path.join(workspace, '.visual-coding'));
  assert.equal((await call('artifact_save', { name: 'blocked', data: {} })).error?.code, 'SYMLINK_DENIED');
});

test('static preview serves project files and closes its listener', async t => {
  const { call, runtime } = await fixture(t);
  await call('project_read', { path: 'index.html' });
  await call('project_patch', { files: [{ path: 'index.html', content: '<h1>Hello</h1>' }] });
  const running = await call('project_run', {});
  const url = running.data.url as string;
  assert.equal(await (await fetch(url)).text(), '<h1>Hello</h1>');
  assert.equal((await fetch(url + '.visual-coding/state.json')).status, 404);
  assert.equal((await fetch(url, { method: 'POST' })).status, 405);
  await runtime.close();
  await assert.rejects(fetch(url));
});
