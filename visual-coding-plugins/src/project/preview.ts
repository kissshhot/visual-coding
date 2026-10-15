import { createServer, type Server } from 'node:http';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { safePath } from './workspace.js';

const mime: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon',
};

export class PreviewManager {
  private servers = new Map<string, { server: Server; url: string }>();

  async start(workspace: string): Promise<string> {
    const existing = this.servers.get(workspace);
    if (existing) return existing.url;
    const server = createServer(async (req, res) => {
      try {
        if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405).end(); return; }
        const pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname);
        const file = await safePath(workspace, pathname === '/' ? 'index.html' : pathname.slice(1));
        const stat = await fs.stat(file);
        if (!stat.isFile() || stat.size > 20_000_000) { res.writeHead(404).end(); return; }
        const bytes = await fs.readFile(file);
        res.writeHead(200, { 'Content-Type': mime[path.extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' });
        res.end(req.method === 'HEAD' ? undefined : bytes);
      } catch { res.writeHead(404).end('Not found'); }
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Preview did not bind to a TCP port');
    const url = `http://127.0.0.1:${address.port}/`;
    this.servers.set(workspace, { server, url });
    return url;
  }

  async close(): Promise<void> {
    await Promise.all([...this.servers.values()].map(({ server }) => new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
      server.closeAllConnections();
    })));
    this.servers.clear();
  }
}
