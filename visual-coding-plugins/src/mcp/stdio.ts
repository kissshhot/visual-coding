#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { realpath } from 'node:fs/promises';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { createServer } from './server.js';

const { values } = parseArgs({ options: { root: { type: 'string' }, 'browser-channel': { type: 'string' } }, strict: true });
if (!values.root) throw new Error('Usage: node dist/mcp/stdio.js --root /absolute/workspace');
const channel = values['browser-channel'];
if (channel !== undefined && channel !== 'chrome' && channel !== 'chromium') throw new Error('browser-channel must be chrome or chromium');
const { server, runtime } = createServer(await realpath(values.root), channel);
let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  try { await runtime.close(); await server.close(); }
  catch (error) { console.error(error); process.exitCode = 1; }
}
process.once('SIGINT', () => void shutdown());
process.once('SIGTERM', () => void shutdown());
process.stdin.once('end', () => void shutdown());
await server.connect(new StdioServerTransport());
