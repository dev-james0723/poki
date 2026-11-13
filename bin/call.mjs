#!/usr/bin/env node
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { root } from '../src/config.mjs';

const name = process.argv[2] ?? 'poki_mcp_status';
const args = JSON.parse(process.argv[3] ?? '{}');
const client = new Client({ name: 'poki-mcp-cli', version: '0.2.0' });
try {
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(root, 'src/stdio.mjs')], env: { ...process.env } }));
  const result = await client.callTool({ name, arguments: args }, { timeout: 3700000 });
  for (const [index, content] of result.content.entries()) {
    if (content.type === 'image') {
      const dir = join(root, '.runtime/calls');
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const path = join(dir, `${Date.now()}-${index}.${content.mimeType === 'image/jpeg' ? 'jpg' : 'png'}`);
      await writeFile(path, Buffer.from(content.data, 'base64'), { mode: 0o600 });
      console.log(path);
    } else if (content.type === 'text') console.log(content.text);
  }
  if (result.isError) process.exitCode = 1;
  else if (name === 'select_device') console.error('Note: this selection lasts only for this run. bin/call.mjs closes its session on exit, so pass "device" in each later call, or use an MCP client session to keep a selection.');
} finally { await client.close(); }
