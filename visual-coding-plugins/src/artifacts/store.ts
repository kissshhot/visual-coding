import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { Artifact } from '../core/contract.js';
import { ToolError } from '../core/contract.js';

export async function saveArtifact(workspace: string, runId: string, revision: string, name: string, bytes: Buffer, mime: string): Promise<Artifact> {
  const dir = path.join(workspace, '.visual-coding', 'runs', runId);
  // The reserved metadata directory must not be redirected outside the project.
  for (const candidate of [path.join(workspace, '.visual-coding'), path.dirname(dir), dir]) {
    const stat = await fs.lstat(candidate).catch(error => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (stat?.isSymbolicLink()) throw new ToolError('SYMLINK_DENIED', 'Artifact directories cannot be symbolic links');
    await fs.mkdir(candidate, { recursive: true });
  }
  const id = randomUUID();
  const file = path.join(dir, `${id}-${name}`);
  await fs.writeFile(file, bytes, { flag: 'wx' });
  return { id, path: file, mime_type: mime, sha256: createHash('sha256').update(bytes).digest('hex'), revision };
}
