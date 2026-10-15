import * as fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { PluginsClient } from '../plugins/client.js';
import { page, stylesheet } from '../models/offline.js';
import { TaskSchema } from '../models/types.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const fixture = path.join(root, 'runs', `vision-fixture-${randomUUID().slice(0, 8)}`);
const referenceRoot = path.join(fixture, 'reference-source');
const workspace = path.join(fixture, 'site');
const task = TaskSchema.parse(JSON.parse(await fs.readFile(path.join(root, 'examples/card.json'), 'utf8')));
await fs.mkdir(referenceRoot, { recursive: true });
await fs.mkdir(workspace);
await fs.writeFile(path.join(referenceRoot, 'index.html'), page(task));
await fs.writeFile(path.join(referenceRoot, 'styles.css'), stylesheet(task.accent));
await fs.writeFile(path.join(workspace, 'index.html'), page(task));
await fs.writeFile(path.join(workspace, 'styles.css'), stylesheet(task.accent) + '\n.panel{transform:translateX(280px)}\nh1{font-size:96px;line-height:0.72}\n#action{background:#b45309}\n');
const client = new PluginsClient();
const context = { workspace: referenceRoot, run_id: 'reference', revision: null as string | null };
try {
  await client.connect(path.join(root, '../visual-coding-plugins/dist/mcp/stdio.js'), referenceRoot);
  const read = await client.call('project_read', { path: 'index.html' }, context, 30000);
  if (!read.result.ok) throw new Error(read.result.error?.message);
  context.revision = read.result.revision;
  const capture = await client.call('browser_capture', { name: 'reference' }, context, 30000);
  if (!capture.result.ok) throw new Error(capture.result.error?.message);
  await fs.copyFile(capture.result.artifacts[0]!.path, path.join(fixture, 'reference.png'));
} finally { await client.close(); }
await fs.writeFile(path.join(fixture, 'task.json'), JSON.stringify({ ...task, id: 'vision-repair', reference_image: 'reference.png',
  instructions: 'Repair the existing page to match the reference at 1200x800. Keep the two-column layout, readable heading and fully visible right panel. Preserve text and the button interaction. The reference status is the initial state; after clicking, show success_text.' }, null, 2));
console.error(`Visual repair fixture: ${fixture}`);
const child = spawn(process.execPath, [path.join(root, 'dist/cli.js'), '--adapter', 'multimodal', '--task', path.join(fixture, 'task.json'), '--workspace', workspace, ...process.argv.slice(2)], { stdio: 'inherit' });
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
