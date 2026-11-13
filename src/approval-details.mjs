import {parseAppActionCallbackURL} from './app-action-callback-protocol.mjs';

// Redact only the exact result-only Shortcut envelope we create. Unknown URL
// behavior stays visible rather than hiding a different action in an approval.
export function urlApprovalDetail(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'shortcuts:' || url.host !== 'x-callback-url' ||
        url.pathname !== '/run-shortcut' || url.username || url.password || url.hash) return value;
    const withInput = url.searchParams.has('input') || url.searchParams.has('text');
    const keys = ['name','x-success','x-cancel','x-error',...(withInput ? ['input','text'] : [])];
    if (Array.from(url.searchParams.keys()).length !== keys.length ||
        !keys.every(key => url.searchParams.getAll(key).length === 1) ||
        (withInput && url.searchParams.get('input') !== 'text') || !url.searchParams.get('name')) return value;
    const origins = new Set();
    let actionId;
    for (const [key,outcome] of [['x-success','success'],['x-cancel','cancelled'],['x-error','error']]) {
      const callback = new URL(url.searchParams.get(key));
      if (callback.protocol !== 'https:' || callback.username || callback.password) return value;
      const fields = parseAppActionCallbackURL(callback.href);
      if (fields.outcome !== outcome || fields.result !== undefined || fields.errorMessage !== undefined ||
          (actionId !== undefined && fields.id !== actionId)) return value;
      actionId = fields.id;
      origins.add(callback.origin);
    }
    const inputDetail = withInput ? `text input: ${Buffer.byteLength(url.searchParams.get('text'))} bytes` : 'no text input';
    return `Shortcut ${JSON.stringify(url.searchParams.get('name'))}; ${inputDetail}; result callbacks: ${[...origins].join(', ')}; callback credentials hidden`;
  } catch { return value; }
}
