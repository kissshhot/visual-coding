import { createHash } from 'node:crypto';
import { z } from 'zod';
import { AssessmentSchema, type AgentState, type Decision, type ModelAdapter } from './types.js';
import { ChatCompletions, type ModelImage } from './chat-completions.js';
import { evaluate } from '../evaluation/checks.js';
import { currentObservations } from '../evaluation/observations.js';

const FilesSchema = z.object({
  summary: z.string().min(1).max(2000),
  files: z.array(z.object({ path: z.string().min(1), content: z.string().min(1).max(100_000) }).strict()).min(1).max(16),
}).strict();
const tool = (name: string, params: Record<string, unknown> = {}): Decision => ({ type: 'tool', tool: name, params });

export class MultimodalAdapter implements ModelAdapter {
  readonly requiresVisualReview = true;
  readonly name: string;
  constructor(private readonly model: ChatCompletions, private readonly reference?: ModelImage, private readonly maxRepairs = 3) {
    this.name = `multimodal:${model.model}`;
    if (!Number.isInteger(maxRepairs) || maxRepairs < 1) throw new Error('maxRepairs must be positive');
  }

  async decide(state: AgentState, signal: AbortSignal): Promise<Decision> {
    signal.throwIfAborted();
    const { task, history, revision } = state;
    const last = history.at(-1);
    if (last && !last.result.ok) throw new Error(`${last.result.error?.code}: ${last.result.error?.message}`);
    const paths = task.editable_files ?? ['index.html', 'styles.css'];
    if (!paths.includes('index.html')) throw new Error('editable_files must include index.html');
    for (const path of paths) {
      if (!history.some(h => h.tool === 'project_read' && h.params.path === path)) return tool('project_read', { path });
    }
    const sources = new Map<string, string>();
    for (const h of history.filter(h => h.result.ok)) {
      if (h.tool === 'project_read' && h.result.data.exists) sources.set(String(h.params.path), String(h.result.data.content));
      if (h.tool === 'project_patch') for (const file of h.params.files as { path: string; content: string }[]) sources.set(file.path, file.content);
    }
    const patches = history.filter(h => h.tool === 'project_patch' && h.result.ok);
    const initiallyEmpty = history[0]?.result.revision === createHash('sha256').digest('hex');
    const requirements = JSON.stringify({ title: task.title, description: task.description, accent: task.accent, button_label: task.button_label, success_text: task.success_text, setup_actions: task.setup_actions, instructions: task.instructions });
    const edit = async (reason: unknown, images: ModelImage[], generate = false): Promise<Decision> => {
      if (!generate && patches.length - (initiallyEmpty ? 1 : 0) >= this.maxRepairs) throw new Error(`Visual repair budget exhausted (${this.maxRepairs})`);
      const response = await this.model.call(generate ? 'generate' : 'repair',
        `${generate ? 'Create' : 'Repair'} a static HTML/CSS/JS page. Return complete contents of only the files that need changes, not diffs. Preserve unrelated layout and functionality. No external resources, dependencies or screenshot-as-page shortcuts.\nRequirements: ${requirements}\nEditable files: ${JSON.stringify(paths)}\nCurrent files: ${JSON.stringify(Object.fromEntries(sources))}\nEvidence: ${JSON.stringify(reason)}\nUse h1 for the exact title, #action for the button with exact accent background, #status for status text. Initially #status must say Ready for interaction (never prefill success_text). Clicking #action must visibly change #status to the exact success_text; do not disable or fake the interaction. Keep JavaScript functional. Make a targeted repair of the reported visual issues.`,
        images, FilesSchema, signal);
      if (new Set(response.value.files.map(f => f.path)).size !== response.value.files.length || response.value.files.some(f => !paths.includes(f.path))) throw new Error('Model proposed duplicate or undeclared editable files');
      if (response.value.files.every(f => sources.get(f.path) === f.content)) throw new Error('Model proposed no code change');
      return tool('project_patch', { files: response.value.files });
    };
    const reference = this.reference ? [this.reference] : [];
    if (!sources.has('index.html')) return edit('Generate the initial page from the task and optional reference.', reference, true);
    if (!history.some(h => h.tool === 'project_run' && h.result.ok)) return tool('project_run');
    const current = currentObservations(state);
    const capture = current.findLast(h => h.tool === 'browser_capture');
    if (!capture) return tool('browser_capture', { name: patches.length ? `revision-${patches.length}` : 'initial' });
    const artifact = capture.result.artifacts.find(a => a.mime_type === 'image/png');
    const image = capture.images[0];
    if (!artifact || !image || !revision) throw new Error('Visual review requires a revision-bound screenshot');
    const comparison = current.findLast(h => h.tool === 'visual_compare' && (h.result.data.candidate as { id?: string } | undefined)?.id === artifact.id);
    if (this.reference?.mimeType === 'image/png' && !comparison) return tool('visual_compare', {
      reference: { data_base64: this.reference.data, sha256: createHash('sha256').update(Buffer.from(this.reference.data, 'base64')).digest('hex') },
      candidate_id: artifact.id, threshold: 8,
    });
    const images: ModelImage[] = [...reference, { ...image, label: `CURRENT SCREENSHOT (${artifact.id}); compare this against the task and optional REFERENCE. Viewport 1200x800.` }];
    const review = state.reviews?.findLast(r => r.screenshot_id === artifact.id && r.revision === revision);
    if (!review) {
      // Deliberately omit source and DOM: this call must diagnose the rendered pixels.
      const response = await this.model.call('visual-review',
        `Inspect the CURRENT screenshot visually. Requirements: ${requirements}\n${this.reference ? 'The REFERENCE defines the intended layout and appearance. ' : ''}Pixel comparison evidence: ${JSON.stringify(comparison ? { changed_ratio: comparison.result.data.changed_ratio, mae: comparison.result.data.mae, changed_bounds: comparison.result.data.changed_bounds } : null)}. This is raw pixel difference, not semantic quality; expected interaction text changes are allowed. Identify concrete visible problems: overlap, clipping, offscreen content, unreadable text, wrong color, spacing or hierarchy. Do not guess CSS or hidden functionality. Ignore small font rasterization differences. After a click, the status may legitimately change to success_text. Return verdict revise with localized issues when repair is needed; return pass with an empty issues array only when the visible requirements are met.`,
        images, AssessmentSchema, signal);
      const assessment = response.value;
      if ((assessment.verdict === 'pass') !== (assessment.issues.length === 0)) throw new Error('Visual verdict contradicts its issue list');
      return { type: 'review', review: { revision, screenshot_id: artifact.id, screenshot_sha256: artifact.sha256, assessment, model_call: response.call } };
    }
    if (review.assessment.verdict === 'revise') return edit(review.assessment, images);
    for (const action of task.setup_actions ?? []) {
      if (!current.some(h => h.tool === 'browser_act' && h.params.action === action.action && h.params.selector === action.selector && h.params.text === action.text)) return tool('browser_act', action);
    }
    const inspection = current.findLast(h => h.tool === 'browser_inspect');
    const action = current.findLast(h => h.tool === 'browser_act' && h.params.action === 'click' && h.params.selector === '#action');
    const lastAction = current.findLast(h => h.tool === 'browser_act');
    if (!inspection || (lastAction && history.indexOf(inspection) < history.indexOf(lastAction))) return tool('browser_inspect', { selectors: ['h1', '#action', '#status'] });
    const checks = evaluate(state);
    if (checks.runtime !== 'passed' || checks.specified_dom_checks !== 'passed') return edit({ checks, inspection: inspection.result.data }, images);
    if (!action) return tool('browser_act', { action: 'click', selector: '#action' });
    if (checks.interaction !== 'passed') return edit({ checks, inspection: inspection.result.data }, images);
    if (history.indexOf(capture) < history.indexOf(inspection)) return tool('browser_capture', { name: 'final' });
    return { type: 'finish', summary: 'The multimodal model reviewed the final screenshot; current-revision DOM and real click checks passed.' };
  }
}
