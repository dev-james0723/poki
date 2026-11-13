// Shared with the result-only HTTPS relay. No Node, MCP or device-control imports.
export const CALLBACK_PATH = '/app-actions/callback';
export const MAX_CALLBACK_URL_BYTES = 32768;
const hex = /^[a-f0-9]{64}$/;
const outcomes = new Set(['success','cancelled','error']);
const allowed = new Set(['id','outcome','token','result','errorMessage']);
const bytes = value => new TextEncoder().encode(value).length;
const invalid = () => Object.assign(new Error('Invalid app action callback'),{code:'APP_ACTION_CALLBACK_INVALID'});
export function validateAppActionCallback(fields) {
  if (!fields || typeof fields!=='object' || Array.isArray(fields)) throw invalid();
  if (Object.keys(fields).some(key=>!allowed.has(key))) throw invalid();
  if (!['id','outcome','token'].every(key=>Object.hasOwn(fields,key)&&typeof fields[key]==='string') ||
      !hex.test(fields.id) || !hex.test(fields.token) || !outcomes.has(fields.outcome)) throw invalid();
  if (fields.result!==undefined && (fields.outcome!=='success' || typeof fields.result!=='string' || bytes(fields.result)>8192)) throw invalid();
  if (fields.errorMessage!==undefined && (fields.outcome!=='error' || typeof fields.errorMessage!=='string' || bytes(fields.errorMessage)>4096)) throw invalid();
  return {id:fields.id,outcome:fields.outcome,token:fields.token,
    ...(fields.result!==undefined?{result:fields.result}:{}),
    ...(fields.errorMessage!==undefined?{errorMessage:fields.errorMessage}:{})};
}
export function parseAppActionCallbackURL(rawURL) {
  if (typeof rawURL!=='string' || bytes(rawURL)>MAX_CALLBACK_URL_BYTES) throw invalid();
  let url;
  try { url=new URL(rawURL,'https://callback.invalid'); } catch { throw invalid(); }
  if (url.pathname!==CALLBACK_PATH || url.hash) throw invalid();
  const fields=Object.create(null);
  for (const [key,value] of url.searchParams) {
    if (!allowed.has(key) || Object.hasOwn(fields,key)) throw invalid();
    fields[key]=value;
  }
  return validateAppActionCallback(fields);
}
