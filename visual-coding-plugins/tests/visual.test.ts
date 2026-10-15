import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { PNG } from 'pngjs';
import { comparePng, decodePng, referenceBytes } from '../src/visual/compare.js';
import { PluginRuntime } from '../src/core/runtime.js';
import { ToolError } from '../src/core/contract.js';

function png(width = 3, height = 2, color = [255, 255, 255, 255]) {
  const image = new PNG({ width, height });
  for (let p = 0; p < width * height; p++) color.forEach((v, c) => { image.data[p * 4 + c] = v; });
  return image;
}
const code = (expected: string) => (e: unknown) => e instanceof ToolError && e.code === expected;
test('pixel counts, RGB MAE, bounding box, regions and rendered diff match known images', () => {
  const a = png(), b = png();
  for (const p of [1, 5]) for (let c = 0; c < 3; c++) b.data[p * 4 + c] = 0;
  const { metrics, diff } = comparePng(PNG.sync.write(a), PNG.sync.write(b), 8, [{ name: 'left', x: 0, y: 0, width: 2, height: 1 }]);
  assert.equal(metrics.changed_pixels, 2); assert.equal(metrics.changed_ratio, 1 / 3); assert.equal(metrics.mae, 85);
  assert.deepEqual(metrics.changed_bounds, { x: 1, y: 0, width: 2, height: 2 });
  assert.equal(metrics.regions[0]?.changed_ratio, 0.5);
  const decoded = decodePng(diff);
  assert.deepEqual([...decoded.data.subarray(4, 8)], [230, 20, 130, 255]);
});
test('equal images and transparency on white produce zero differences', () => {
  const white = PNG.sync.write(png()), transparent = PNG.sync.write(png(3, 2, [0, 0, 0, 0]));
  for (const other of [white, transparent]) {
    const result = comparePng(white, other).metrics;
    assert.equal(result.changed_ratio, 0); assert.equal(result.mae, 0); assert.equal(result.changed_bounds, null);
  }
});
test('threshold uses strictly greater-than and size/region mismatches are rejected', () => {
  const a = PNG.sync.write(png(1, 1, [100, 100, 100, 255]));
  assert.equal(comparePng(a, PNG.sync.write(png(1, 1, [108, 100, 100, 255])), 8).metrics.changed_pixels, 0);
  assert.equal(comparePng(a, PNG.sync.write(png(1, 1, [109, 100, 100, 255])), 8).metrics.changed_pixels, 1);
  assert.throws(() => comparePng(a, PNG.sync.write(png())), code('IMAGE_SIZE_MISMATCH'));
  assert.throws(() => comparePng(a, a, 8, [{ name: 'out', x: 1, y: 0, width: 1, height: 1 }]), code('INVALID_REGION'));
});
test('invalid PNG, oversized IHDR, noncanonical input and incorrect digests are rejected', () => {
  const bytes = PNG.sync.write(png()), hash = createHash('sha256').update(bytes).digest('hex');
  assert.deepEqual(referenceBytes({ data_base64: bytes.toString('base64'), sha256: hash }), bytes);
  assert.throws(() => referenceBytes({ data_base64: bytes.toString('base64'), sha256: '0'.repeat(64) }), code('IMAGE_HASH_MISMATCH'));
  assert.throws(() => referenceBytes({ data_base64: bytes.toString('base64') + '\n', sha256: hash }), code('INVALID_IMAGE'));
  assert.throws(() => decodePng(Buffer.from('not png')), code('INVALID_IMAGE'));
  const oversized = Buffer.from(bytes); oversized.writeUInt32BE(9000, 16);
  assert.throws(() => decodePng(oversized), code('IMAGE_TOO_LARGE'));
});
test('runtime comparisons bind real screenshots to the current workspace/run/revision', { timeout: 60000 }, async t => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'visual-compare-'));
  const runtime = new PluginRuntime(workspace);
  t.after(async () => { await runtime.close(); await fs.rm(workspace, { force: true, recursive: true }); });
  await fs.writeFile(path.join(workspace, 'index.html'), '<!doctype html><link rel="icon" href="data:,"><h1>Compare</h1>');
  const ctx = { workspace, run_id: 'compare', revision: null as string | null };
  const read = await runtime.invoke('project_read', { ...ctx, params: { path: 'index.html' } }); ctx.revision = read.result.revision;
  const capture = await runtime.invoke('browser_capture', { ...ctx, params: { name: 'before' } });
  assert.equal(capture.result.ok, true);
  const params = { candidate_id: capture.result.artifacts[0]!.id, reference: { data_base64: capture.image!.toString('base64'), sha256: capture.result.artifacts[0]!.sha256 } };
  const comparison = await runtime.invoke('visual_compare', { ...ctx, params });
  assert.equal(comparison.result.ok, true); assert.equal(comparison.result.data.changed_ratio, 0);
  assert.equal(comparison.result.artifacts.length, 2); assert.ok(comparison.image);
  assert.equal((await runtime.invoke('visual_compare', { ...ctx, run_id: 'other', params })).result.error?.code, 'UNKNOWN_SCREENSHOT');
  assert.equal((await runtime.invoke('visual_compare', { ...ctx, params: { ...params, candidate_id: randomUUID() } })).result.error?.code, 'UNKNOWN_SCREENSHOT');
  const patch = await runtime.invoke('project_patch', { ...ctx, params: { files: [{ path: 'index.html', content: '<h1>Changed</h1>' }] } }); ctx.revision = patch.result.revision;
  assert.equal((await runtime.invoke('visual_compare', { ...ctx, params })).result.error?.code, 'UNKNOWN_SCREENSHOT');
});
