import { readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { CALLBACK_PATH, parseAppActionCallbackURL } from './app-action-callback-protocol.mjs';

const permitted = new Set([200,400,403,404,409,410,413,429,503,504]);
const invalid = () => ({status:400});
function callbackPath(payload) {
  if (!payload || payload.method !== 'app-actions/callback' || !payload.params ||
      Object.keys(payload).some(k=>!['method','params'].includes(k)) ||
      Object.keys(payload.params).some(k=>k!=='path')) return null;
  const path = payload.params.path;
  if (typeof path !== 'string' || !path.startsWith(CALLBACK_PATH+'?')) return null;
  try { parseAppActionCallbackURL(path); } catch { return null; }
  return path;
}

// The outbound bridge supplies its existing local endpoint file. This does not
// read or forward the MCP bearer token, execute a tool, or accept a remote origin.
export async function forwardShortcutCallback(payload, options = {}) {
  const path = callbackPath(payload);
  if (!path) return invalid();
  try {
    const readEndpoint = options.readEndpoint ?? (async () => {
      if (!isAbsolute(options.endpointFile ?? '')) throw Error('Endpoint unavailable');
      const raw = await readFile(options.endpointFile,'utf8');
      if (raw.length > 16384) throw Error('Endpoint unavailable');
      return JSON.parse(raw);
    });
    const endpoint = await readEndpoint();
    const base = new URL(endpoint.url);
    if (endpoint.enabled !== true || base.protocol !== 'http:' || base.hostname !== '127.0.0.1' ||
        !base.port || base.pathname !== '/mcp' || base.username || base.password || base.search || base.hash) return {status:503};
    const response = await (options.fetch ?? globalThis.fetch)(new URL(path,base.origin),{
      method:'GET',headers:{'accept':'application/json'},redirect:'error',signal:AbortSignal.timeout(8000),
    });
    const status = permitted.has(response.status) ? response.status : 503;
    await response.body?.cancel().catch(()=>{});
    return {status};
  } catch { return {status:503}; }
}
