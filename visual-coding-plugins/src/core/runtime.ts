import { performance } from 'node:perf_hooks';
import { z } from 'zod';
import { ContextSchema, CONTRACT_VERSION, definitions, ToolError, type ToolName, type ToolResult } from './contract.js';
import { resolveWorkspace, revision, readFile, patchFiles } from '../project/workspace.js';
import { PreviewManager } from '../project/preview.js';
import { BrowserManager } from '../browser/session.js';
import { saveArtifact } from '../artifacts/store.js';
import { comparePng, referenceBytes } from '../visual/compare.js';
import type { Artifact } from './contract.js';

export interface Invocation { result: ToolResult; image?: Buffer }

export class PluginRuntime {
  private preview = new PreviewManager();
  private browsers: BrowserManager;
  private queue: Promise<unknown> = Promise.resolve();
  private captures = new Map<string, { workspace: string; runId: string; artifact: Artifact; bytes: Buffer }>();

  constructor(private readonly root: string, private readonly browserChannel?: 'chrome' | 'chromium') {
    this.browsers = new BrowserManager(browserChannel);
  }

  invoke(name: ToolName, input: unknown): Promise<Invocation> {
    // Serialize calls in this process so our patches and observations cannot race.
    const next = this.queue.then(() => this.execute(name, input));
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async execute(name: ToolName, input: unknown): Promise<Invocation> {
    const start = performance.now();
    const result: ToolResult = { contract_version: CONTRACT_VERSION, ok: false, run_id: '', revision: null, data: {}, artifacts: [], error: null, duration_ms: 0 };
    let image: Buffer | undefined;
    try {
      const ctx = ContextSchema.parse(input);
      result.run_id = ctx.run_id;
      const workspace = await resolveWorkspace(this.root, ctx.workspace);
      const current = await revision(workspace);
      result.revision = current;
      if (ctx.revision !== current && !(name === 'project_read' && ctx.revision === null)) {
        throw new ToolError('REVISION_CONFLICT', 'Expected revision differs from current code; read again before continuing');
      }
      const params = z.object({ params: z.unknown() }).parse(input).params;
      if (name === 'project_read') {
        const p = definitions.project_read.params.parse(params);
        result.data = await readFile(workspace, p.path);
      } else if (name === 'project_patch') {
        const p = definitions.project_patch.params.parse(params);
        await patchFiles(workspace, p.files);
        for (const [id, capture] of this.captures) if (capture.workspace === workspace) this.captures.delete(id);
        result.revision = await revision(workspace);
        result.data = { changed_files: p.files.map(f => f.path), previous_revision: current };
        result.artifacts.push(await saveArtifact(workspace, ctx.run_id, result.revision, 'patch.json', Buffer.from(JSON.stringify({ previous_revision: current, revision: result.revision, files: p.files }, null, 2)), 'application/json'));
      } else if (name === 'project_run') {
        definitions.project_run.params.parse(params);
        result.data = { url: await this.preview.start(workspace), kind: 'static', status: 'running' };
      } else if (name === 'artifact_save') {
        const p = definitions.artifact_save.params.parse(params);
        const bytes = Buffer.from(JSON.stringify(p.data, null, 2));
        if (bytes.length > 10_000_000) throw new ToolError('ARTIFACT_TOO_LARGE', 'JSON artifacts are limited to 10 MB');
        result.artifacts.push(await saveArtifact(workspace, ctx.run_id, current, `${p.name}.json`, bytes, 'application/json'));
        result.data = { saved: true };
      } else if (name === 'visual_compare') {
        const p = definitions.visual_compare.params.parse(params);
        const capture = this.captures.get(p.candidate_id);
        if (!capture || capture.workspace !== workspace || capture.runId !== ctx.run_id || capture.artifact.revision !== current) throw new ToolError('UNKNOWN_SCREENSHOT', 'Capture a current screenshot in this workspace and run before comparing');
        const reference = referenceBytes(p.reference);
        const compared = comparePng(reference, capture.bytes, p.threshold, p.regions);
        image = compared.diff;
        result.data = { ...compared.metrics, reference_sha256: p.reference.sha256, candidate: capture.artifact };
        result.artifacts.push(await saveArtifact(workspace, ctx.run_id, current, 'diff.png', image, 'image/png'));
        result.artifacts.push(await saveArtifact(workspace, ctx.run_id, current, 'comparison.json', Buffer.from(JSON.stringify(result.data, null, 2)), 'application/json'));
      } else {
        const session = await this.browsers.get(workspace, ctx.run_id, current, await this.preview.start(workspace));
        if (name === 'browser_capture') {
          const p = definitions.browser_capture.params.parse(params);
          image = p.selector
            ? await session.page.locator(p.selector).screenshot({ animations: 'disabled', timeout: 5_000 })
            : await session.page.screenshot({ fullPage: false, animations: 'disabled', timeout: 5_000 });
          result.artifacts.push(await saveArtifact(workspace, ctx.run_id, current, `${p.name}.png`, image, 'image/png'));
          // Keep bounded, authenticated screenshot bytes; callers cannot substitute a filesystem path.
          if (this.captures.size >= 32) this.captures.delete(this.captures.keys().next().value!);
          this.captures.set(result.artifacts[0]!.id, { workspace, runId: ctx.run_id, artifact: result.artifacts[0]!, bytes: image });
          result.data = { title: await session.page.title(), viewport: session.page.viewportSize(), browser_channel: this.browserChannel ?? 'chromium', browser_version: session.page.context().browser()?.version(), console_errors: [...session.errors] };
        } else if (name === 'browser_inspect') {
          result.data = await this.browsers.inspect(session, definitions.browser_inspect.params.parse(params).selectors);
        } else if (name === 'browser_act') {
          const p = definitions.browser_act.params.parse(params);
          const target = session.page.locator(p.selector);
          if (p.action === 'click') await target.click();
          else await target.fill(p.text);
          result.data = { action: p.action, selector: p.selector, console_errors: [...session.errors] };
        }
      }
      if (await revision(workspace) !== result.revision) throw new ToolError('REVISION_CONFLICT', 'Code changed while the tool was running; discard this observation');
      result.ok = true;
    } catch (error) {
      if (name === 'browser_capture') for (const artifact of result.artifacts) this.captures.delete(artifact.id);
      result.error = { code: error instanceof ToolError ? error.code : error instanceof z.ZodError ? 'INVALID_ARGUMENTS' : 'TOOL_FAILED', message: error instanceof Error ? error.message : String(error) };
      result.artifacts = [];
      image = undefined;
    }
    result.duration_ms = Math.round(performance.now() - start);
    return { result, image };
  }

  async close(): Promise<void> {
    await this.queue;
    this.captures.clear();
    try { await this.browsers.close(); } finally { await this.preview.close(); }
  }
}
