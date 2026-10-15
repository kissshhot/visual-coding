import * as fs from 'node:fs/promises';
import path from 'node:path';
import { PluginsClient, summarizeObservation, type Observation, type Artifact } from '../plugins/client.js';
import { AssessmentSchema, type AgentState, type ModelAdapter, type Task, type VisualReview } from '../models/types.js';
import { evaluate } from '../evaluation/checks.js';
import { currentObservations } from '../evaluation/observations.js';

export interface RunOptions {
  workspace: string; runId: string; serverPath: string; task: Task; adapter: ModelAdapter;
  maxSteps?: number; timeoutMs?: number;
  browserChannel?: 'chrome' | 'chromium';
  onObservation?: (observation: Observation) => Promise<void>;
  onReview?: (review: VisualReview) => Promise<void>;
}

export async function runAgent(options: RunOptions) {
  const workspace = path.resolve(options.workspace);
  const maxSteps = options.maxSteps ?? 20;
  const timeoutMs = options.timeoutMs ?? 90_000;
  if (!Number.isInteger(maxSteps) || maxSteps < 1 || !Number.isFinite(timeoutMs) || timeoutMs < 1) throw new Error('Budgets must be positive');
  const deadline = Date.now() + timeoutMs;
  const signal = AbortSignal.timeout(timeoutMs);
  await fs.mkdir(workspace, { recursive: true });
  const client = new PluginsClient();
  const history: Observation[] = [];
  const reviews: VisualReview[] = [];
  let revision: string | null = null;
  const artifacts: Artifact[] = [];
  const state = (): AgentState => ({ task: options.task, history, revision, reviews });
  const remaining = () => { signal.throwIfAborted(); return Math.max(1, Math.min(30_000, deadline - Date.now())); };
  const call = async (tool: string, params: Record<string, unknown>) => {
    const observation = await client.call(tool, params, { workspace, run_id: options.runId, revision }, remaining());
    history.push(observation);
    await options.onObservation?.(observation);
    if (observation.result.ok) {
      revision = observation.result.revision;
      artifacts.push(...observation.result.artifacts);
    }
    return observation;
  };
  try {
    const tools = await client.connect(path.resolve(options.serverPath), workspace, signal, options.browserChannel);
    for (const name of ['project_read', 'project_patch', 'project_run', 'browser_capture', 'browser_inspect', 'browser_act', 'artifact_save']) {
      if (!tools.includes(name)) throw new Error(`Required plugin tool is missing: ${name}`);
    }
    for (let step = 0; step < maxSteps; step++) {
      signal.throwIfAborted();
      const decision = await abortable(options.adapter.decide(state(), signal), signal);
      if (decision.type === 'review') {
        const capture = currentObservations(state()).findLast(h => h.tool === 'browser_capture');
        const screenshot = capture?.result.artifacts.find(a => a.mime_type === 'image/png');
        const review = decision.review;
        const assessment = AssessmentSchema.parse(review.assessment);
        if (!screenshot || review.revision !== revision || review.screenshot_id !== screenshot.id || review.screenshot_sha256 !== screenshot.sha256) throw new Error('Visual review rejected: stale or unrelated screenshot');
        if ((assessment.verdict === 'pass') !== (assessment.issues.length === 0)) throw new Error('Visual review rejected: inconsistent verdict');
        reviews.push({ ...review, assessment });
        await options.onReview?.(review);
        continue;
      }
      if (decision.type === 'finish') {
        const evaluation = evaluate(state());
        if ([evaluation.runtime, evaluation.specified_dom_checks, evaluation.interaction].some(value => value !== 'passed')) throw new Error('Completion rejected: current-revision checks have not passed');
        const screenshot = currentObservations(state()).findLast(h => h.tool === 'browser_capture')?.result.artifacts.find(a => a.mime_type === 'image/png');
        if (!screenshot) throw new Error('Completion rejected: no screenshot for the current code revision');
        if (options.adapter.requiresVisualReview) {
          const review = reviews.findLast(r => r.screenshot_id === screenshot.id && r.revision === revision);
          if (review?.assessment.verdict !== 'pass') throw new Error('Completion rejected: final screenshot has no passing visual review');
          const captureIndex = history.findLastIndex(h => h.result.artifacts.some(a => a.id === screenshot.id));
          const interactionIndex = history.findLastIndex(h => h.tool === 'browser_act' && h.result.ok);
          if (captureIndex < interactionIndex) throw new Error('Completion rejected: screenshot predates interaction');
        }
        const report = { status: 'completed', mode: options.adapter.name, contract_version: '0.1.0', run_id: options.runId, workspace, revision, tool_steps: history.length, summary: decision.summary, evaluation, visual_reviews: reviews, artifacts: [...artifacts], final_screenshot: screenshot.path };
        const trace = await call('artifact_save', { name: 'trajectory', data: { mode: options.adapter.name, task: options.task, visual_reviews: reviews, history: history.map(summarizeObservation) } });
        if (!trace.result.ok) throw new Error(`Cannot save trajectory: ${trace.result.error?.message}`);
        const saved = await call('artifact_save', { name: 'report', data: { ...report, trajectory: trace.result.artifacts[0]?.path } });
        if (!saved.result.ok) throw new Error(`Cannot save report: ${saved.result.error?.message}`);
        return { ...report, report_path: saved.result.artifacts[0]!.path, trajectory_path: trace.result.artifacts[0]!.path };
      }
      await call(decision.tool, decision.params);
    }
    throw new Error(`Agent exceeded its ${maxSteps}-step budget`);
  } finally { await client.close(); }
}

async function abortable<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    pending.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}
