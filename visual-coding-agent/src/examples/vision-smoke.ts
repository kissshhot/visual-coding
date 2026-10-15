import * as fs from 'node:fs/promises';
import path from 'node:path';
import { randomInt, randomUUID, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadEnvFile } from 'node:process';
import { z } from 'zod';
import { PluginsClient } from '../plugins/client.js';
import { ChatCompletions } from '../models/chat-completions.js';
import { loadModelConfig } from '../models/config.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
try { loadEnvFile(path.join(root, '.env')); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
const output = path.join(root, 'runs', `vision-smoke-${randomUUID().slice(0, 8)}`);
const workspace = path.join(output, 'site');
const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const code = Array.from({ length: 6 }, () => alphabet[randomInt(alphabet.length)]).join('');
await fs.mkdir(workspace, { recursive: true });
await fs.writeFile(path.join(workspace, 'index.html'), `<!doctype html><html><head><link rel="icon" href="data:,"></head><body style="margin:0;background:white"><div style="font:bold 90px monospace;padding:80px;color:black">${code}</div></body></html>`);
const client = new PluginsClient();
try {
  const config = await loadModelConfig(root);
  const model = new ChatCompletions({ ...config, maxRequests: 3, onEvent: async event => { await fs.appendFile(path.join(output, 'model-events.jsonl'), JSON.stringify(event) + '\n'); } });
  await client.connect(path.join(root, '../visual-coding-plugins/dist/mcp/stdio.js'), workspace);
  const context = { workspace, run_id: 'vision-smoke', revision: null as string | null };
  const read = await client.call('project_read', { path: 'index.html' }, context, 30000);
  if (!read.result.ok) throw new Error(read.result.error?.message);
  context.revision = read.result.revision;
  const capture = await client.call('browser_capture', { name: 'random-code' }, context, 30000);
  if (!capture.result.ok || !capture.images[0]) throw new Error('Failed to render vision probe');
  const response = await model.call('vision-smoke', 'Read the six-character code visible in the image. Return exactly that code. The answer is only available in the pixels.', [{ ...capture.images[0], label: 'Random visual probe' }], z.object({ code: z.string() }).strict(), AbortSignal.timeout(120000));
  const report = { passed: response.value.code === code, expected: code, actual: response.value.code, model: model.model,
    image_sha256: createHash('sha256').update(Buffer.from(capture.images[0].data, 'base64')).digest('hex'), screenshot: capture.result.artifacts[0]?.path };
  await fs.writeFile(path.join(output, 'result.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ...report, result_path: path.join(output, 'result.json') }, null, 2));
  if (!report.passed) process.exitCode = 1;
} finally { await client.close(); }
