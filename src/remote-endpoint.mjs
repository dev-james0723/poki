import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import { dirname, join } from 'node:path';

// Saved RemotePairing ports, including the historical 49152 default, are records.
// A current advertisement for that same device replaces the port. An advertisement
// for a different device is never applied here.
export function chooseEndpoint(saved, observation) {
  const savedPort = saved.port;
  if (observation?.blocked?.includes(saved.id)) {
    return { ok: false, outcome: 'not_sent', code: 'remote_identity_mismatch', message: 'That host answered for a different device. Nothing was sent.' };
  }
  if (!observation || observation.available !== true) {
    return { ok: true, host: saved.host, port: savedPort, source: 'saved_unverified', presumedCurrent: false };
  }
  const mine = (observation.advertisements ?? []).filter(ad => ad && ad.id === saved.id);
  const ports = [...new Set(mine.map(ad => ad.port))];
  if (ports.length !== 1) {
    const ambiguous = ports.length > 1;
    return {
      ok: false,
      outcome: 'not_sent',
      code: ambiguous ? 'ambiguous_remote_listener' : 'remote_listener_not_advertised',
      message: ambiguous
        ? 'RemotePairing advertisements for this device disagree on the listener port. Nothing was sent.'
        : `This device has no current RemotePairing advertisement. Saved port ${savedPort} was not used. Nothing was sent.`,
    };
  }
  const host = mine.find(ad => typeof ad.host === 'string' && ad.host)?.host ?? saved.host;
  return { ok: true, host, port: ports[0], source: 'discovered', presumedCurrent: true };
}

export class RemoteListenerError extends Error {
  constructor(message, code, outcome = 'not_sent') {
    super(message);
    this.name = 'RemoteListenerError';
    this.code = code;
    this.outcome = outcome;
  }
}

const PTR = 12, TXT = 16, SRV = 33, IN = 1;

function encodeName(name) {
  const labels = name.replace(/\.$/, '').split('.').filter(Boolean);
  const parts = [];
  for (const label of labels) {
    const bytes = Buffer.from(label);
    if (bytes.length > 63) throw new Error('DNS label is too long.');
    parts.push(Buffer.from([bytes.length]), bytes);
  }
  parts.push(Buffer.from([0]));
  return Buffer.concat(parts);
}

export function encodePtrQuery(name = '_remotepairing._tcp.local', id = 1) {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(id, 0);
  header.writeUInt16BE(1, 4); // one question
  return Buffer.concat([header, encodeName(name), Buffer.from([0, PTR, 0, IN])]);
}

function readName(packet, offset, depth = 0) {
  if (depth > 8 || offset >= packet.length) throw new Error('Malformed DNS name.');
  const labels = [];
  let pos = offset;
  let end = offset;
  let jumped = false;
  while (pos < packet.length) {
    const length = packet[pos];
    if (length === 0) {
      if (!jumped) end = pos + 1;
      break;
    }
    if ((length & 0xc0) === 0xc0) {
      if (pos + 1 >= packet.length) throw new Error('Malformed DNS pointer.');
      const pointer = ((length & 0x3f) << 8) | packet[pos + 1];
      if (!jumped) end = pos + 2;
      labels.push(...readName(packet, pointer, depth + 1).labels);
      jumped = true;
      break;
    }
    if (length > 63 || pos + 1 + length > packet.length) throw new Error('Malformed DNS label.');
    labels.push(packet.subarray(pos + 1, pos + 1 + length).toString('utf8'));
    pos += 1 + length;
    if (!jumped) end = pos;
  }
  return { labels, end };
}

function parseTxt(data) {
  const values = {};
  let pos = 0;
  while (pos < data.length) {
    const length = data[pos];
    pos += 1;
    if (pos + length > data.length) break;
    const text = data.subarray(pos, pos + length).toString('utf8');
    pos += length;
    const eq = text.indexOf('=');
    if (eq > 0) values[text.slice(0, eq)] = text.slice(eq + 1);
  }
  return values;
}

// Returns listener records seen in one mDNS reply. Callers bind them to a device.
export function parseRemotePairing(packet) {
  if (!Buffer.isBuffer(packet) || packet.length < 12) return [];
  const questions = packet.readUInt16BE(4);
  const records = packet.readUInt16BE(6) + packet.readUInt16BE(8) + packet.readUInt16BE(10);
  let pos = 12;
  for (let i = 0; i < questions && pos < packet.length; i += 1) {
    pos = readName(packet, pos).end + 4;
  }
  const byName = new Map();
  for (let i = 0; i < records && pos + 10 <= packet.length; i += 1) {
    const name = readName(packet, pos);
    pos = name.end;
    if (pos + 10 > packet.length) break;
    const type = packet.readUInt16BE(pos);
    const length = packet.readUInt16BE(pos + 8);
    pos += 10;
    if (pos + length > packet.length) break;
    const data = packet.subarray(pos, pos + length);
    pos += length;
    const key = name.labels.join('.').toLowerCase();
    if (!key.includes('_remotepairing._tcp')) continue;
    const entry = byName.get(key) ?? { name: key };
    if (type === SRV && data.length >= 6) {
      entry.port = data.readUInt16BE(4);
      try { entry.target = readName(packet, pos - length + 6).labels.join('.'); } catch { /* target is optional */ }
    } else if (type === TXT) {
      const txt = parseTxt(data);
      entry.id = txt.UniqueDeviceID || txt.udid || txt.UDID || entry.id;
    }
    byName.set(key, entry);
  }
  return [...byName.values()].filter(entry => Number.isInteger(entry.port));
}

function dedupe(advertisements) {
  const grouped = new Map();
  for (const ad of advertisements) {
    const list = grouped.get(ad.id) ?? [];
    if (!list.some(item => item.port === ad.port && item.host === ad.host)) list.push(ad);
    grouped.set(ad.id, list);
  }
  return [...grouped.values()].flat();
}

export async function queryListeners(configs, exchange) {
  const advertisements = [];
  const blocked = new Set();
  const consider = (replies, config, { requireId, blockOnForeignId }) => {
    for (const reply of replies ?? []) {
      let records = [];
      try { records = parseRemotePairing(reply); } catch { continue; }
      for (const record of records) {
        if (!config || !Number.isInteger(record.port)) continue;
        if (record.id && record.id !== config.id) {
          if (blockOnForeignId) blocked.add(config.id);
          continue;
        }
        if (requireId && record.id !== config.id) continue;
        advertisements.push({ id: record.id || config.id, host: config.host, port: record.port });
      }
    }
  };
  for (const config of configs) {
    if (!config?.host || isIP(config.host) === 0) continue;
    consider(await exchange(encodePtrQuery(), config.host, 5353), config, { requireId: false, blockOnForeignId: true });
  }
  const multicast = await exchange(encodePtrQuery(), '224.0.0.251', 5353);
  for (const config of configs) consider(multicast, config, { requireId: true, blockOnForeignId: false });
  const mine = dedupe(advertisements);
  return { available: mine.length > 0 || blocked.size > 0, advertisements: mine, blocked: [...blocked] };
}

function exchangeUdp(packet, host, port, timeoutMs) {
  return new Promise(resolve => {
    import('node:dgram').then(({ createSocket }) => {
      const socket = createSocket({ type: host.includes(':') ? 'udp6' : 'udp4' });
      const replies = [];
      const finish = () => { socket.removeAllListeners(); socket.close(); resolve(replies); };
      const timer = setTimeout(finish, timeoutMs);
      socket.once('error', () => { clearTimeout(timer); finish(); });
      socket.on('message', message => { replies.push(Buffer.from(message)); });
      socket.bind(0, () => {
        try { socket.send(packet, port, host); }
        catch { clearTimeout(timer); finish(); }
      });
    }).catch(() => resolve([]));
  });
}

export async function observeListeners(configs, env = process.env, options = {}) {
  const mode = env.POKI_REMOTE_DISCOVERY ?? 'mdns';
  if (mode === 'off') return { available: false, advertisements: [] };
  if (env.POKI_REMOTE_ADVERTISEMENTS_FILE) {
    const parsed = JSON.parse(await readFile(env.POKI_REMOTE_ADVERTISEMENTS_FILE, 'utf8'));
    if (!Array.isArray(parsed)) throw new RemoteListenerError('Remote advertisements must be an array.', 'invalid_advertisements');
    const advertisements = parsed.filter(ad => ad && typeof ad.id === 'string' && Number.isInteger(ad.port) && typeof ad.host === 'string');
    return { available: true, advertisements };
  }
  if (mode !== 'mdns') return { available: false, advertisements: [] };
  const exchange = options.exchange ?? ((packet, host, port) => exchangeUdp(packet, host, port, options.timeoutMs ?? 250));
  try { return await queryListeners(configs, exchange); }
  catch { return { available: false, advertisements: [] }; }
}

// Copy the registry and per-device records before a later writer changes them.
// Pairing files and the previous port stay in the backup. Symlinks are refused.
export async function backupRemoteRecords(directory) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = join(directory, 'remote-backups', stamp);
  let copied = false;
  const copy = async (src, rel) => {
    let info;
    try { info = await lstat(src); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    if (info.isSymbolicLink() || !info.isFile()) throw new Error('Refusing to back up a remote record that is not a regular file.');
    await mkdir(dirname(join(dest, rel)), { recursive: true, mode: 0o700 });
    await writeFile(join(dest, rel), await readFile(src), { mode: 0o600 });
    copied = true;
  };
  await copy(join(directory, 'remote-devices.json'), 'remote-devices.json');
  let ids = [];
  try { ids = await readdir(join(directory, 'remote'), { withFileTypes: true }); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  for (const entry of ids) {
    if (!entry.isDirectory() || entry.name === 'remote-backups') continue;
    for (const name of ['config.json', 'pairing.plist']) await copy(join(directory, 'remote', entry.name, name), join('remote', entry.name, name));
  }
  return copied ? dest : null;
}
