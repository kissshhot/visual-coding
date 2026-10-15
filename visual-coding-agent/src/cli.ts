#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { randomUUID } from 'node:crypto';
import { readFile, mkdir, writeFile, appendFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runAgent } from './agent/runner.js';
import { OfflineAdapter } from './models/offline.js';
import { TaskSchema } from './models/types.js';
import { loadEnvFile } from 'node:process';
import { ChatCompletions } from './models/chat-completions.js';
import { MultimodalAdapter } from './models/multimodal.js';
import { loadModelConfig, loadReference } from './models/config.js';
import { summarizeObservation } from './plugins/client.js';

const root = fileURLToPath(new URL('../', import.meta.url));
try { loadEnvFile(path.join(root, '.env')); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
const { values } = parseArgs({ strict: true, options: {
  task: { type: 'string' }, workspace: { type: 'string' }, 'plugins-server': { type: 'string' },
  'max-steps': { type: 'string', default: '40' }, 'timeout-ms': { type: 'string' },
  adapter: { type: 'string', default: 'offline' }, 'model-config': { type: 'string' },
  'api-key-file': { type: 'string' }, 'max-repairs': { type: 'string', default: '3' },
  'browser-channel': { type: 'string' },
  help: { type: 'boolean', short: 'h' },
} });

if (values.help) {
  console.log('Usage: npm start -- [--adapter offline|multimodal] [--task task.json] [--workspace /path] [--model-config config.json] [--api-key-file /private/key.txt] [--max-repairs 3] [--max-steps 40] [--timeout-ms 600000] [--browser-channel chrome|chromium] [--plugins-server /path/to/plugins/dist/mcp/stdio.js]');
} else {
  const runId = `run-${randomUUID().slice(0, 8)}`;
  const output = path.join(root, 'runs', runId);
  await mkdir(output, { recursive: true });
  let redact = (text: string) => text;
  try {
    const browserChannel = values['browser-channel'];
    if (browserChannel !== undefined && browserChannel !== 'chrome' && browserChannel !== 'chromium') throw new Error('browser-channel must be chrome or chromium');
    const taskPath = path.resolve(values.task ?? path.join(root, 'examples/card.json'));
    const task = TaskSchema.parse(JSON.parse(await readFile(taskPath, 'utf8')));
    if (!['offline', 'multimodal'].includes(values.adapter)) throw new Error('adapter must be offline or multimodal');
    let adapter = new OfflineAdapter() as import('./models/types.js').ModelAdapter;
    if (values.adapter === 'multimodal') {
      const config = await loadModelConfig(root, values['model-config'], values['api-key-file']);
      const model = new ChatCompletions({ ...config, onEvent: async event => {
        await appendFile(path.join(output, 'model-events.jsonl'), JSON.stringify(event) + '\n');
        console.error(`[model ${event.call}] ${event.phase}: ${event.error ?? 'completed'} (${event.duration_ms} ms)`);
      } });
      redact = text => model.redact(text);
      const reference = task.reference_image ? await loadReference(path.resolve(path.dirname(taskPath), task.reference_image)) : undefined;
      if (reference) await writeFile(path.join(output, reference.mimeType === 'image/png' ? 'reference.png' : 'reference.jpg'), Buffer.from(reference.data, 'base64'));
      adapter = new MultimodalAdapter(model, reference, Number(values['max-repairs']));
    }
    const result = await runAgent({
      workspace: path.resolve(values.workspace ?? path.join(output, 'site')), runId,
      serverPath: path.resolve(values['plugins-server'] ?? path.join(root, '../visual-coding-plugins/dist/mcp/stdio.js')),
      task, adapter, maxSteps: Number(values['max-steps']), timeoutMs: Number(values['timeout-ms'] ?? (values.adapter === 'multimodal' ? '600000' : '90000')),
      browserChannel,
      onObservation: async observation => { await appendFile(path.join(output, 'events.jsonl'), JSON.stringify(summarizeObservation(observation)) + '\n'); },
      onReview: async review => { await appendFile(path.join(output, 'visual-reviews.jsonl'), JSON.stringify(review) + '\n'); },
    });
    await writeFile(path.join(output, 'result.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    const failure = { status: 'failed', run_id: runId, error: redact(error instanceof Error ? error.message : String(error)) };
    await writeFile(path.join(output, 'failure.json'), JSON.stringify(failure, null, 2));
    console.error(JSON.stringify(failure, null, 2));
    process.exitCode = 1;
  }
}
