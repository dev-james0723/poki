import { readFile } from 'node:fs/promises';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { createServer } from './tools.mjs';
import { endpointFile } from './config.mjs';
import { randomUUID } from 'node:crypto';
import { version } from './build-info.mjs';

const notRunning = () => new Error('Local Poki MCP is not running. Run npm start in its project first.');
const readEndpoint = async () => {
  const entry = await readFile(endpointFile, 'utf8').then(JSON.parse).catch(() => { throw notRunning(); });
  const url = new URL(entry.url);
  if (!entry.enabled || url.hostname !== '127.0.0.1' || url.protocol !== 'http:' || url.pathname !== '/mcp') throw new Error('Invalid local MCP endpoint');
  return { url, token: entry.token };
};
let endpoint;
const session = process.env.POKI_MCP_SESSION ?? randomUUID();
const send = (path, init) => {
  const headers = new Headers(init?.headers);
  headers.set('Authorization', `Bearer ${endpoint.token}`);
  headers.set('x-poki-mcp-session', session);
  return fetch(new URL(path, endpoint.url), { ...init, headers });
};
const refused = error => error.cause?.code === 'ECONNREFUSED';
const lost = error => error.name === 'TypeError' && error.cause ? new Error('The connection to Poki MCP was lost during this call. The device may already have acted, so look at the screen before retrying. If the service stopped, run npm start in its project.') : error;
// A restarted service has a new token and may have a new port. A 401 or a refused connection means it
// never ran the request, so sending it once more cannot repeat anything on the device. Any other lost
// connection can, so that one is reported and not sent again.
async function request(path, init) {
  endpoint ??= await readEndpoint();
  try {
    const response = await send(path, init);
    if (response.status !== 401) return response;
    await response.body?.cancel();
  } catch (error) {
    if (!refused(error)) throw lost(error);
  }
  endpoint = await readEndpoint();
  let response;
  try { response = await send(path, init); }
  catch (error) { throw refused(error) ? notRunning() : lost(error); }
  if (response.status !== 401) return response;
  await response.body?.cancel();
  throw new Error(`The running Poki MCP rejected the token in ${endpointFile}. Restart it with npm start.`);
}
const controls = new Set();
const control = (path, extra = {}) => {
  const result = request(path, { method: 'POST', headers: extra, signal: AbortSignal.timeout(35000) });
  controls.add(result); result.finally(() => controls.delete(result)).catch(() => {});
  return result;
};
// Local tool discovery does not depend on a running daemon. A chat keeps the
// native catalog while launchd restarts the service; execution connects lazily.
let remote, opening;
function connection() {
  if (remote) return Promise.resolve(remote);
  return opening ??= (async () => {
    endpoint = await readEndpoint();
    const client = new Client({ name: 'poki-mcp-bridge', version });
    try {
      await client.connect(new StreamableHTTPClientTransport(endpoint.url, { fetch: (input, init) => request(new URL(input).pathname, init) }));
      remote = client;
      return client;
    } catch (error) {
      await client.close().catch(() => {});
      throw error;
    }
  })().finally(() => { opening = undefined; });
}
const server = createServer(async (name, args, extra) => {
  const id = randomUUID();
  const cancel = () => { void control('/request/cancel', { 'x-poki-request': id }).catch(() => {}); };
  extra.signal.addEventListener('abort', cancel, { once: true });
  try {
    extra.signal.throwIfAborted();
    const client = await connection();
    extra.signal.throwIfAborted();
    return await client.callTool({ name, arguments: args, _meta: { 'poki/request_id': id } }, { timeout: 3700000, signal: extra.signal });
  } finally { extra.signal.removeEventListener('abort', cancel); }
});
const transport = new StdioServerTransport();
await server.connect(transport);
let stopping;
function stop() {
  return stopping ??= (async () => {
    if (opening) await opening.catch(() => {});
    if (remote) await control('/session/close').catch(() => {});
    await Promise.allSettled([...controls]);
    await server.close(); await remote?.close();
  })();
}
process.stdin.once('end', () => { void stop(); });
process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());
