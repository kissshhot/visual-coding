import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { loadEnvFile } from 'node:process';
import { mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { loadModelConfig } from '../models/config.js';
import { runBenchmark } from './benchmark.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
try { loadEnvFile(path.join(root, '.env')); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
const { values } = parseArgs({ strict: true, options: { mode: { type: 'string', default: 'model' }, output: { type: 'string' }, help: { type: 'boolean' } } });
if (values.help) console.log('Usage: npm run benchmark -- [--mode model|validate] [--output /new/output-directory]');
else {
  if (values.mode !== 'model' && values.mode !== 'validate') throw new Error('mode must be model or validate');
  const config = values.mode === 'model' ? await loadModelConfig(root) : undefined;
  await mkdir(path.join(root, 'runs'), { recursive: true });
  const output = path.resolve(values.output ?? path.join(root, 'runs', `${values.mode === 'model' ? 'benchmark' : 'calibration'}-${randomUUID().slice(0, 8)}`));
  const report = await runBenchmark({ root, output, mode: values.mode, config, onProgress: message => console.error(message) });
  console.log(JSON.stringify({ output, report: path.join(output, 'report.html'), ...report.summary }, null, 2));
  if (report.tasks.some(t => !t.passed)) process.exitCode = 1;
}
