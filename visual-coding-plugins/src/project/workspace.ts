import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { ToolError } from '../core/contract.js';

const MAX_BYTES = 20_000_000;
const MAX_FILES = 200;

export async function resolveWorkspace(root: string, candidate: string): Promise<string> {
  if (!path.isAbsolute(candidate)) throw new ToolError('INVALID_WORKSPACE', 'workspace must be absolute');
  const [base, resolved] = await Promise.all([fs.realpath(root), fs.realpath(candidate)]);
  const rel = path.relative(base, resolved);
  if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw new ToolError('OUTSIDE_WORKSPACE', 'workspace must be inside the configured root');
  }
  if (!(await fs.stat(resolved)).isDirectory()) throw new ToolError('INVALID_WORKSPACE', 'workspace must be a directory');
  return resolved;
}

export async function safePath(workspace: string, relative: string): Promise<string> {
  const parts = relative.split('/');
  if (path.isAbsolute(relative) || relative.includes('\\') || parts.some(p => !p || p.startsWith('.') || p === 'node_modules' || p.includes('\0'))) {
    throw new ToolError('INVALID_PATH', 'Use a relative project path without dot segments or hidden directories');
  }
  let current = workspace;
  for (const part of parts) {
    current = path.join(current, part);
    const stat = await fs.lstat(current).catch(error => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (stat?.isSymbolicLink()) throw new ToolError('SYMLINK_DENIED', 'Project paths cannot traverse symbolic links');
  }
  return current;
}

export async function revision(workspace: string): Promise<string> {
  const hash = createHash('sha256');
  let bytes = 0, count = 0;
  async function visit(dir: string): Promise<void> {
    const entries = (await fs.readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'en'));
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const file = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) throw new ToolError('SYMLINK_DENIED', 'Project trees cannot contain symbolic links');
      if (entry.isDirectory()) await visit(file);
      else if (entry.isFile()) {
        const stat = await fs.stat(file);
        bytes += stat.size; count++;
        if (bytes > MAX_BYTES || count > MAX_FILES) throw new ToolError('PROJECT_TOO_LARGE', 'Static MVP limit: 200 files / 20 MB');
        const content = await fs.readFile(file);
        hash.update(JSON.stringify([path.relative(workspace, file), content.length]));
        hash.update(content);
      }
    }
  }
  await visit(workspace);
  return hash.digest('hex');
}

export async function readFile(workspace: string, relative: string): Promise<Record<string, unknown>> {
  const file = await safePath(workspace, relative);
  const stat = await fs.stat(file).catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!stat) return { path: relative, exists: false, content: null };
  if (!stat.isFile() || stat.size > 1_000_000) throw new ToolError('INVALID_FILE', 'Expected a text file up to 1 MB');
  return { path: relative, exists: true, content: await fs.readFile(file, 'utf8') };
}

export async function patchFiles(workspace: string, files: { path: string; content: string }[]): Promise<void> {
  if (new Set(files.map(f => f.path)).size !== files.length) throw new ToolError('DUPLICATE_PATH', 'Patch paths must be unique');
  const changes = [];
  for (const file of files) {
    if (Buffer.byteLength(file.content, 'utf8') > 1_000_000) throw new ToolError('FILE_TOO_LARGE', 'Each patch file is limited to 1 MB');
    if (!/\.(html|css|js|mjs|json|svg|txt)$/.test(file.path)) throw new ToolError('UNSUPPORTED_FILE', 'Static MVP edits HTML, CSS, JS, JSON, SVG and text files');
    const target = await safePath(workspace, file.path);
    const before = await fs.readFile(target).catch(error => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    changes.push({ ...file, target, before });
  }
  const applied: typeof changes = [];
  try {
    for (const change of changes) {
      await fs.mkdir(path.dirname(change.target), { recursive: true });
      const temp = `${change.target}.${randomUUID()}.tmp`;
      try {
        await fs.writeFile(temp, change.content, { flag: 'wx' });
        await fs.rename(temp, change.target);
        applied.push(change);
      } finally { await fs.rm(temp, { force: true }); }
    }
    await revision(workspace); // Roll back if this patch exceeds project limits.
  } catch (error) {
    for (const change of applied.reverse()) {
      if (change.before === null) await fs.rm(change.target, { force: true });
      else await fs.writeFile(change.target, change.before);
    }
    throw error;
  }
}
