import type { AgentState, Decision, ModelAdapter, Task } from './types.js';
import { createHash } from 'node:crypto';

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]!));
export const rgb = (hex: string) => `rgb(${[1, 3, 5].map(start => parseInt(hex.slice(start, start + 2), 16)).join(', ')})`;
const tool = (name: string, params: Record<string, unknown> = {}): Decision => ({ type: 'tool', tool: name, params });

export function stylesheet(accent: string): string {
  return `:root{font-family:Arial,Helvetica,sans-serif;color:#172b32;background:#eef3f0;--accent:${accent}}
*{box-sizing:border-box}body{margin:0;padding:48px 72px}header{display:flex;justify-content:space-between;align-items:center;font-size:13px;font-weight:700;letter-spacing:2px}.mark{display:flex;align-items:center;gap:12px}.dot{height:12px;width:12px;background:var(--accent);border-radius:50%}.badge{font-size:11px;color:#526e64;border:1px solid #c3d2c9;border-radius:20px;padding:10px 14px;letter-spacing:1px}main{margin:76px auto 0;max-width:960px;display:grid;grid-template-columns:1.35fr 1fr;gap:48px;align-items:center}.eyebrow{font-size:12px;letter-spacing:3px;color:#567269;font-weight:700}h1{font-size:58px;line-height:1.06;letter-spacing:-2.5px;margin:22px 0}p{font-size:17px;line-height:1.7;color:#5a6e68;max-width:510px}button{margin-top:22px;padding:16px 23px;background:var(--accent);border:0;border-radius:9px;font:600 14px Arial;color:white;cursor:pointer}button:focus-visible{outline:3px solid #172b32;outline-offset:4px}#status{min-height:28px;font-size:13px;color:#526e64}.panel{padding:32px;background:#fff;border:1px solid #dce6df;border-radius:22px;box-shadow:0 18px 60px #172b3209}.panel small{font-size:10px;letter-spacing:2px;color:#7a8d85}.step{display:flex;gap:18px;align-items:center;padding:22px 0;border-bottom:1px solid #edf0ed}.step:last-child{border:0}.number{color:var(--accent);font-size:13px;font-weight:700}.step strong{font-size:14px}.step span{display:block;color:#819187;font-size:12px;margin-top:6px}footer{margin-top:76px;border-top:1px solid #cfdbd2;padding-top:20px;color:#74867c;font-size:11px;letter-spacing:1px}@media(max-width:700px){body{padding:24px}main{grid-template-columns:1fr;margin-top:40px}h1{font-size:42px}footer{margin-top:40px}}`;
}

export function page(task: Task): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(task.title)}</title><link rel="icon" href="data:,"><link rel="stylesheet" href="styles.css"></head><body>
<header><div class="mark"><i class="dot"></i>VISUAL CODING</div><div class="badge">LOCAL DEMO · 001</div></header>
<main><section><div class="eyebrow">FROM CODE TO EVIDENCE</div><h1>${escapeHtml(task.title)}</h1><p>${escapeHtml(task.description)}</p><button id="action">${escapeHtml(task.button_label)}</button><p id="status" role="status" aria-live="polite">Ready for interaction</p></section>
<aside class="panel"><small>THE FEEDBACK LOOP</small><div class="step"><div class="number">01</div><div><strong>Create</strong><span>Write the first implementation</span></div></div><div class="step"><div class="number">02</div><div><strong>Observe</strong><span>Render and collect evidence</span></div></div><div class="step"><div class="number">03</div><div><strong>Refine</strong><span>Update code and verify again</span></div></div></aside></main>
<footer>AGENT + PLUGINS / REAL BROWSER / REVISION-BOUND ARTIFACTS</footer>
<script>document.getElementById('action').addEventListener('click',()=>{document.getElementById('status').textContent=${JSON.stringify(task.success_text).replace(/</g, '\\u003c')};});</script></body></html>`;
}

/** Deterministic template policy for infrastructure verification; performs no model inference. */
export class OfflineAdapter implements ModelAdapter {
  readonly name = 'offline-demo';
  async decide({ task, history }: AgentState, signal: AbortSignal): Promise<Decision> {
    signal.throwIfAborted();
    const last = history.at(-1);
    if (last && !last.result.ok) throw new Error(`${last.result.error?.code}: ${last.result.error?.message}`);
    if (!last) return tool('project_read', { path: 'index.html' });
    if (last.tool === 'project_read') {
      if (last.result.data.exists || last.result.revision !== createHash('sha256').digest('hex')) {
        throw new Error('Offline demo requires an empty project; existing source files will not be overwritten');
      }
      const draftAccent = task.accent.toLowerCase() === '#b45309' ? '#7c3aed' : '#b45309';
      return tool('project_patch', { files: [{ path: 'index.html', content: page(task) }, { path: 'styles.css', content: stylesheet(draftAccent) }] });
    }
    if (last.tool === 'project_patch') {
      return history.some(item => item.tool === 'project_run') ? tool('browser_capture', { name: 'refined' }) : tool('project_run');
    }
    if (last.tool === 'project_run') return tool('browser_capture', { name: 'initial' });
    if (last.tool === 'browser_capture') {
      if (!last.images.length) throw new Error('Browser capture returned no image observation');
      if (last.params.name === 'final') return { type: 'finish', summary: 'Rendered, corrected the observed button color, and verified the click interaction.' };
      return tool('browser_inspect', { selectors: ['h1', '#action', '#status'] });
    }
    if (last.tool === 'browser_act') return tool('browser_inspect', { selectors: ['h1', '#action', '#status'] });
    if (last.tool === 'browser_inspect') {
      const elements = last.result.data.elements as { selector: string; text?: string; styles?: { backgroundColor?: string } }[];
      if (elements.find(e => e.selector === 'h1')?.text !== task.title) throw new Error('Rendered heading does not match the task');
      const button = elements.find(e => e.selector === '#action');
      if (button?.styles?.backgroundColor !== rgb(task.accent)) {
        if (history.filter(item => item.tool === 'project_patch').length >= 2) throw new Error('Color still incorrect after repair');
        return tool('project_patch', { files: [{ path: 'styles.css', content: stylesheet(task.accent) }] });
      }
      if (!history.some(item => item.tool === 'browser_act')) return tool('browser_act', { action: 'click', selector: '#action' });
      if (elements.find(e => e.selector === '#status')?.text !== task.success_text) throw new Error('Click did not produce the expected visible status');
      return tool('browser_capture', { name: 'final' });
    }
    throw new Error(`Offline policy cannot handle ${last.tool}`);
  }
}
