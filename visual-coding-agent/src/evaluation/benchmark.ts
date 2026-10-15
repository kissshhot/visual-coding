import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { PluginsClient, summarizeObservation, type Artifact, type Observation } from '../plugins/client.js';
import { runAgent } from '../agent/runner.js';
import { TaskSchema, type Task } from '../models/types.js';
import { MultimodalAdapter } from '../models/multimodal.js';
import { ChatCompletions, type ChatConfig, type ModelEvent } from '../models/chat-completions.js';
import { rgb } from '../models/offline.js';
import { writeBenchmarkReport } from './benchmark-report.js';

const sha = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const json = async (file: string, data: unknown) => fs.writeFile(file, JSON.stringify(data, null, 2) + '\n');
const safeId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/);
const ManifestSchema = z.object({
  suite: safeId, tasks: z.array(safeId).length(5), viewport: z.object({ width: z.literal(1200), height: z.literal(800) }),
  threshold: z.number().int().min(0).max(255), max_changed_ratio: z.number().min(0).max(1), max_mae: z.number().min(0).max(255),
  max_steps: z.number().int().positive(), max_repairs: z.number().int().positive(), timeout_ms: z.number().int().positive(), description: z.string(),
});
const ActionSchema = z.discriminatedUnion('action', [z.object({ action: z.literal('click'), selector: z.string() }), z.object({ action: z.literal('fill'), selector: z.string(), text: z.string() })]);
const AssertionSchema = z.object({ selector: z.string(), text: z.string() });
const ChecksSchema = z.object({ family: z.string(), assertions: z.array(AssertionSchema), followup: z.array(ActionSchema), followup_assertions: z.array(AssertionSchema),
  regions: z.array(z.object({ name: z.string(), x: z.number().int(), y: z.number().int(), width: z.number().int(), height: z.number().int() })) });
type Manifest = z.infer<typeof ManifestSchema>;
type Checks = z.infer<typeof ChecksSchema>;
interface Check { name: string; category: 'runtime' | 'dom' | 'interaction'; passed: boolean; expected: unknown; actual: unknown }
export interface PixelMetrics { changed_ratio: number; mae: number; changed_pixels: number; changed_bounds: unknown; [key: string]: unknown }
export interface StateResult { screenshot: Artifact; metrics: PixelMetrics | null; diff: Artifact | null }
export interface StageResult { revision: string; states: { idle: StateResult; clicked: StateResult }; checks: Check[]; runtime_passed: boolean; interaction_passed: boolean; functional_passed: boolean; visual_passed: boolean | null; browser: Record<string, unknown> }
export interface BenchmarkRow { id: string; title: string; family: string; status: 'completed' | 'agent_failed' | 'infra_invalid'; error?: string; initial?: StageResult; final?: StageResult; reference?: StageResult; model_requests: number; input_tokens: number; output_tokens: number; agent_revision?: string; passed: boolean; }
export interface BenchmarkReport { suite: string; mode: 'model' | 'validate'; created_at: string; fixture_sha256: string; harness_sha256: string; config: Record<string, unknown>; tasks: BenchmarkRow[]; summary: Record<string, unknown> }

export function aggregate(rows: BenchmarkRow[]) {
  const scored = rows.filter(r => r.status !== 'infra_invalid' && r.initial && r.final);
  const mean = (stage: 'initial' | 'final') => scored.length ? scored.reduce((s, r) => s + (r[stage]!.states.idle.metrics!.changed_ratio + r[stage]!.states.clicked.metrics!.changed_ratio) / 2, 0) / scored.length : null;
  const before = mean('initial'), after = mean('final');
  return { tasks: rows.length, scored: scored.length, passed: rows.filter(r => r.passed).length,
    infra_invalid: rows.filter(r => r.status === 'infra_invalid').length, agent_failed: rows.filter(r => r.status === 'agent_failed').length,
    initial_changed_ratio: before, final_changed_ratio: after, reduction_percentage_points: before === null || after === null ? null : (before - after) * 100,
    initial_interaction_passed: scored.filter(r => r.initial!.interaction_passed).length, final_interaction_passed: scored.filter(r => r.final!.interaction_passed).length,
    model_requests: rows.reduce((n, r) => n + r.model_requests, 0), input_tokens: rows.reduce((n, r) => n + r.input_tokens, 0), output_tokens: rows.reduce((n, r) => n + r.output_tokens, 0) };
}

export async function measureStage(options: { workspace: string; output: string; runId: string; serverPath: string; task: Task; checks: Checks; manifest: Manifest; references?: StageResult }): Promise<StageResult> {
  const { workspace, output, runId, task, checks, manifest, references } = options;
  await fs.mkdir(output, { recursive: true });
  const client = new PluginsClient();
  const context = { workspace, run_id: runId, revision: null as string | null };
  const results: Check[] = [];
  const add = (name: string, category: Check['category'], passed: boolean, expected: unknown, actual: unknown) => results.push({ name, category, passed, expected, actual });
  const call = async (name: string, params: Record<string, unknown> = {}, allowFailure = false) => {
    const observation = await client.call(name, params, context, 30_000);
    await fs.appendFile(path.join(output, 'events.jsonl'), JSON.stringify(summarizeObservation(observation)) + '\n');
    if (!observation.result.ok && !allowFailure) throw new Error(`${name}: ${observation.result.error?.code}: ${observation.result.error?.message}`);
    if (observation.result.ok) context.revision = observation.result.revision;
    return observation;
  };
  let browser: Record<string, unknown> = {};
  const capture = async (state: 'idle' | 'clicked'): Promise<StateResult> => {
    const observed = await call('browser_capture', { name: state });
    const screenshot = observed.result.artifacts[0]!;
    browser = { viewport: observed.result.data.viewport, version: observed.result.data.browser_version, channel: observed.result.data.browser_channel };
    let metrics: PixelMetrics | null = null, diff: Artifact | null = null;
    if (references) {
      const bytes = await fs.readFile(references.states[state].screenshot.path);
      const comparison = await call('visual_compare', { candidate_id: screenshot.id, reference: { data_base64: bytes.toString('base64'), sha256: sha(bytes) }, threshold: manifest.threshold, regions: checks.regions });
      metrics = comparison.result.data as PixelMetrics;
      diff = comparison.result.artifacts.find(a => a.mime_type === 'image/png')!;
    }
    return { screenshot, metrics, diff };
  };
  const selectors = [...new Set(['h1', '#action', '#status', ...checks.assertions.map(c => c.selector), ...checks.followup_assertions.map(c => c.selector)])];
  type Element = { selector: string; text?: string; visible?: boolean; bounds?: { x: number; y: number; width: number; height: number }; styles?: { backgroundColor?: string } };
  const elements = (observation: Observation) => observation.result.data.elements as Element[];
  const visible = (e?: Element) => Boolean(e?.visible && e.bounds && e.bounds.width > 0 && e.bounds.height > 0 && e.bounds.x >= 0 && e.bounds.y >= 0 && e.bounds.x + e.bounds.width <= 1200 && e.bounds.y + e.bounds.height <= 800);
  const assertText = (label: string, category: Check['category'], list: Element[], selector: string, expected: string) => {
    const element = list.find(e => e.selector === selector);
    add(label, category, element?.text === expected && visible(element), expected, { text: element?.text ?? null, visible: visible(element) });
  };
  const act = async (action: z.infer<typeof ActionSchema>, label: string) => {
    const outcome = await call('browser_act', action, true);
    add(label, 'interaction', outcome.result.ok, 'action succeeds', outcome.result.error ?? 'succeeded');
  };
  try {
    const tools = await client.connect(options.serverPath, workspace);
    if (!tools.includes('visual_compare')) throw new Error('Plugins must expose visual_compare');
    await call('project_read', { path: 'index.html' });
    const idle = await capture('idle');
    const before = await call('browser_inspect', { selectors });
    const beforeElements = elements(before);
    assertText('heading', 'dom', beforeElements, 'h1', task.title);
    assertText('button label', 'dom', beforeElements, '#action', task.button_label);
    add('button accent', 'dom', beforeElements.find(e => e.selector === '#action')?.styles?.backgroundColor === rgb(task.accent), rgb(task.accent), beforeElements.find(e => e.selector === '#action')?.styles?.backgroundColor ?? null);
    assertText('initial status', 'interaction', beforeElements, '#status', 'Ready for interaction');
    for (const [i, action] of (task.setup_actions ?? []).entries()) await act(action, `setup ${i + 1}`);
    await act({ action: 'click', selector: '#action' }, 'primary click');
    const after = await call('browser_inspect', { selectors });
    const afterElements = elements(after);
    assertText('primary status', 'interaction', afterElements, '#status', task.success_text);
    add('status changed', 'interaction', beforeElements.find(e => e.selector === '#status')?.text !== afterElements.find(e => e.selector === '#status')?.text, true, beforeElements.find(e => e.selector === '#status')?.text !== afterElements.find(e => e.selector === '#status')?.text);
    for (const check of checks.assertions) assertText(`primary ${check.selector}`, 'interaction', afterElements, check.selector, check.text);
    const clicked = await capture('clicked');
    for (const [i, action] of checks.followup.entries()) await act(action, `followup ${i + 1}`);
    const follow = await call('browser_inspect', { selectors });
    for (const check of checks.followup_assertions) assertText(`followup ${check.selector}`, 'interaction', elements(follow), check.selector, check.text);
    const errors = [before, after, follow].flatMap(o => o.result.data.console_errors as string[]);
    add('console errors', 'runtime', errors.length === 0, [], [...new Set(errors)]);
    const result: StageResult = { revision: context.revision!, states: { idle, clicked }, checks: results,
      runtime_passed: errors.length === 0, interaction_passed: results.filter(c => c.category === 'interaction').every(c => c.passed), functional_passed: results.every(c => c.passed),
      visual_passed: references ? [idle, clicked].every(s => s.metrics!.changed_ratio <= manifest.max_changed_ratio && s.metrics!.mae <= manifest.max_mae) : null, browser };
    await json(path.join(output, 'result.json'), result);
    return result;
  } finally { await client.close(); }
}

export async function runBenchmark(options: { root: string; output: string; mode: 'model' | 'validate'; config?: ChatConfig; onProgress?: (message: string) => void }) {
  const suiteRoot = path.join(options.root, 'benchmarks/v1');
  const manifestText = await fs.readFile(path.join(suiteRoot, 'manifest.json'), 'utf8');
  const manifest = ManifestSchema.parse(JSON.parse(manifestText));
  if (new Set(manifest.tasks).size !== 5) throw new Error('Suite must contain five distinct tasks');
  if (options.mode === 'model' && !options.config) throw new Error('Model configuration is required');
  await fs.mkdir(options.output, { recursive: false });
  const fixtureHash = createHash('sha256').update(manifestText);
  const fixtures = [];
  for (const id of manifest.tasks) {
    const directory = path.join(suiteRoot, id);
    const taskText = await fs.readFile(path.join(directory, 'task.json'), 'utf8');
    const checkText = await fs.readFile(path.join(directory, 'checks.json'), 'utf8');
    fixtureHash.update(id).update(taskText).update(checkText);
    const task = TaskSchema.parse(JSON.parse(taskText)), checks = ChecksSchema.parse(JSON.parse(checkText));
    if (task.id !== id) throw new Error('Fixture/task IDs differ');
    const files: Record<string, Record<string, string>> = { initial: {}, reference: {} };
    for (const phase of ['initial', 'reference']) for (const name of ['index.html', 'styles.css', 'app.js']) {
      const content = await fs.readFile(path.join(directory, phase, name), 'utf8');
      files[phase]![name] = content; fixtureHash.update(phase).update(name).update(content);
    }
    fixtures.push({ id, task, checks, files });
  }
  const harnessHash = createHash('sha256');
  for (const source of ['evaluation/benchmark.ts', 'models/multimodal.ts', 'models/chat-completions.ts', 'agent/runner.ts']) harnessHash.update(await fs.readFile(path.join(options.root, 'src', source)));
  const config = options.config;
  const report: BenchmarkReport = { suite: manifest.suite, mode: options.mode, created_at: new Date().toISOString(), fixture_sha256: fixtureHash.digest('hex'), harness_sha256: harnessHash.digest('hex'),
    config: { ...manifest, model: config?.model ?? null, endpoint: config?.endpoint ?? null, max_requests: config?.maxRequests ?? null, max_output_tokens: config?.maxOutputTokens ?? null }, tasks: [], summary: {} };
  const serverPath = path.resolve(options.root, '../visual-coding-plugins/dist/mcp/stdio.js');
  await json(path.join(options.output, 'manifest.json'), { ...manifest, fixture_sha256: report.fixture_sha256 });
  for (const fixture of fixtures) {
    const { id, task, checks, files } = fixture;
    const taskOutput = path.join(options.output, id);
    const row: BenchmarkRow = { id, title: task.title, family: checks.family, status: 'completed', model_requests: 0, input_tokens: 0, output_tokens: 0, passed: false };
    report.tasks.push(row);
    options.onProgress?.(`${id}: measuring reference and initial draft`);
    try {
      await fs.mkdir(taskOutput);
      for (const phase of ['reference', 'initial', 'candidate']) {
        await fs.mkdir(path.join(taskOutput, phase));
        for (const [name, content] of Object.entries(files[phase === 'reference' ? 'reference' : 'initial']!)) await fs.writeFile(path.join(taskOutput, phase, name), content);
      }
      const measure = (phase: string, references?: StageResult) => measureStage({ workspace: path.join(taskOutput, phase), output: path.join(taskOutput, `${phase}-evaluation`), runId: `${phase}-${id}`, serverPath, task, checks, manifest, references });
      row.reference = await measure('reference');
      if (!row.reference.functional_passed) throw new Error('Reference fixture fails its declared functional checks');
      row.initial = await measure('initial', row.reference);
      const workspace = path.join(taskOutput, 'candidate');
      await json(path.join(taskOutput, 'task.json'), task);
      if (options.mode === 'validate') {
        for (const [name, content] of Object.entries(files.reference!)) await fs.writeFile(path.join(workspace, name), content);
      } else {
        options.onProgress?.(`${id}: running multimodal repair`);
        const model = new ChatCompletions({ ...config!, onEvent: async (event: ModelEvent) => {
          row.model_requests++;
          row.input_tokens += Number(event.usage?.prompt_tokens ?? 0); row.output_tokens += Number(event.usage?.completion_tokens ?? 0);
          await fs.appendFile(path.join(taskOutput, 'model-events.jsonl'), JSON.stringify(event) + '\n');
          options.onProgress?.(`${id}: model ${event.call} ${event.phase}${event.error ? ` (${event.error})` : ''}`);
        } });
        const referenceBytes = await fs.readFile(row.reference.states.idle.screenshot.path);
        try {
          const agent = await runAgent({ workspace, runId: `agent-${id}`, serverPath, task, adapter: new MultimodalAdapter(model, { mimeType: 'image/png', data: referenceBytes.toString('base64'), label: 'REFERENCE: desired initial state at 1200x800. Interaction may change text and values.' }, manifest.max_repairs), maxSteps: manifest.max_steps, timeoutMs: manifest.timeout_ms,
            onObservation: async o => { await fs.appendFile(path.join(taskOutput, 'agent-events.jsonl'), JSON.stringify(summarizeObservation(o)) + '\n'); },
            onReview: async r => { await fs.appendFile(path.join(taskOutput, 'visual-reviews.jsonl'), JSON.stringify(r) + '\n'); } });
          row.agent_revision = agent.revision!;
          await json(path.join(taskOutput, 'agent-result.json'), agent);
        } catch (error) { row.status = 'agent_failed'; row.error = model.redact(error instanceof Error ? error.message : String(error)); await json(path.join(taskOutput, 'agent-failure.json'), { error: row.error }); }
      }
      // Score frozen source in a fresh browser; never use the model's own pass verdict as the score.
      await fs.mkdir(path.join(taskOutput, 'final'));
      for (const name of ['index.html', 'styles.css', 'app.js']) await fs.copyFile(path.join(workspace, name), path.join(taskOutput, 'final', name));
      row.final = await measure('final', row.reference);
      if (row.agent_revision && row.final.revision !== row.agent_revision) throw new Error('Scored final source differs from the Agent delivery');
      row.passed = row.status === 'completed' && row.final.visual_passed === true && row.final.functional_passed;
      options.onProgress?.(`${id}: initial ${(row.initial.states.idle.metrics!.changed_ratio * 100).toFixed(2)}% -> final ${(row.final.states.idle.metrics!.changed_ratio * 100).toFixed(2)}% pixels changed; interaction ${row.initial.interaction_passed} -> ${row.final.interaction_passed}`);
    } catch (error) { row.status = 'infra_invalid'; row.error = error instanceof Error ? error.message : String(error); options.onProgress?.(`${id}: evaluation failed: ${row.error}`); }
    report.summary = aggregate(report.tasks);
    await writeBenchmarkReport(options.output, report);
  }
  return report;
}
