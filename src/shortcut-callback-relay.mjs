import { CALLBACK_PATH, parseAppActionCallbackURL } from './app-action-callback-protocol.mjs';

const permitted = new Set([200,400,403,404,409,410,413,429,503,504]);
const headers = {'content-type':'application/json','cache-control':'no-store','referrer-policy':'no-referrer','x-content-type-options':'nosniff'};
const reply = status => new Response(JSON.stringify(status===200 ? {received:true} : {received:false,error:status===503||status===504?'callback_unavailable':'callback_rejected'}),{status,headers});

// HTTPS ingress only forwards a validated result. It has no MCP/tool authority.
// Deploy with a separate bounded queue so guessed tokens cannot occupy the MCP queue.
export async function relayShortcutCallback(request, exchange) {
  const url = new URL(request.url);
  if (url.pathname !== CALLBACK_PATH) return null;
  if (request.method !== 'GET') return reply(405);
  if (url.protocol !== 'https:') return reply(400);
  try { parseAppActionCallbackURL(request.url); } catch { return reply(400); }
  try {
    const result = await exchange({method:'app-actions/callback',params:{path:url.pathname+url.search}});
    const status = permitted.has(result?.status) ? result.status : 503;
    return reply(status);
  } catch { return reply(503); }
}
