import { readFileSync } from 'node:fs';
import { lstat, open, readdir, readlink, realpath, stat, access, constants, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { root } from './config.mjs';

export const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
const execute = promisify(execFile);
const bridge = join(root, 'build/poki-native');

const stale = () => new Error('The service is running old code. Stop the running service and restart it with npm start.');
const metadata = s => [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs].map(String).join(':');
const security = s => [s.mode, s.uid, s.gid, s.nlink].map(String).join(':');

async function files() {
  const files = (await readdir(join(root, 'src'), { recursive: true }))
    .filter(file => file.endsWith('.mjs')).map(file => join('src', file));
  files.push('package.json', 'build/poki-native');
  return files.sort();
}

async function fileStat(file) {
  return stat(join(root, file), { bigint: true }).catch(error => {
      if (error.code === 'ENOENT') return null;
      throw error;
  });
}

async function pathIdentity(file) {
  const path = join(root, file);
  const info = await lstat(path, { bigint: true }).catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!info) return null;
  const symlink = info.isSymbolicLink();
  const resolved = await realpath(path).catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  return {
    type: symlink ? 'symlink' : info.isFile() ? 'file' : 'other',
    resolved,
    link: symlink ? await readlink(path) : null,
    security: security(info),
    // Symlink metadata and authority are never relaxed, even if its target matches.
    metadata: symlink ? metadata(info) : null,
  };
}

async function plainSecurity(file, expected) {
  // Node has no portable ACL/xattr API. On macOS, accept metadata-only changes
  // only when `ls` proves the file has no ACL, xattrs or special file flags.
  // Unavailable/unparseable security metadata keeps the old strict behavior.
  if (process.platform !== 'darwin' || /[\r\n]/.test(file)) return false;
  const before = await fileStat(file);
  if (!before || metadata(before) !== metadata(expected) || security(before) !== security(expected)) throw stale();
  let output;
  try { ({ stdout: output } = await execute('/bin/ls', ['-LldneO@', '--', join(root, file)], { timeout: 3000, maxBuffer: 1024 * 1024 })); }
  catch { return false; }
  const after = await fileStat(file);
  if (!after || metadata(after) !== metadata(before) || security(after) !== security(before)) throw stale();
  const lines = output.trimEnd().split('\n');
  const first = lines[0]?.trim().split(/\s+/);
  if (!first || first.length < 6 || lines.length !== 1 || first[0].length !== 10 || first[4] !== '-') return false;
  return true;
}

async function contentDigest(file, expected) {
  // Refuse a race during the read instead of accepting a mixed snapshot.
  const handle = await open(join(root, file), 'r').catch(() => { throw stale(); });
  try {
    const before = await handle.stat({ bigint: true });
    if (metadata(before) !== metadata(expected) || security(before) !== security(expected)) throw stale();
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    const named = await fileStat(file);
    if (!named || metadata(before) !== metadata(after) || metadata(after) !== metadata(named)
        || security(before) !== security(after) || security(after) !== security(named)) throw stale();
    return createHash('sha256').update(bytes).digest('hex');
  } finally { await handle.close(); }
}

async function initialSnapshot() {
  const result = new Map();
  for (const file of await files()) {
    const path = await pathIdentity(file), info = await fileStat(file);
    const item = info && { metadata: metadata(info), security: security(info), size: info.size,
      plain: await plainSecurity(file, info), hash: await contentDigest(file, info) };
    if (JSON.stringify(await pathIdentity(file)) !== JSON.stringify(path)) throw stale();
    result.set(file, { path, info: item });
  }
  return result;
}

const startupCode = await initialSnapshot();

export async function requireCurrentCode() {
  const current = await files();
  if (current.length !== startupCode.size || current.some(file => !startupCode.has(file))) throw stale();
  for (const file of current) {
    const entry = startupCode.get(file), expected = entry.info, path = await pathIdentity(file), info = await fileStat(file);
    if (JSON.stringify(path) !== JSON.stringify(entry.path)) throw stale();
    if (!expected || !info) { if (Boolean(expected) !== Boolean(info)) throw stale(); continue; }
    if (security(info) !== expected.security || info.size !== expected.size) throw stale();
    const marker = metadata(info);
    if (marker !== expected.metadata) {
      if (!expected.plain || !await plainSecurity(file, info)) throw stale();
      if (await contentDigest(file, info) !== expected.hash) throw stale();
      // Cache the metadata only after verifying it against the startup digest.
      expected.metadata = marker;
    }
    if (JSON.stringify(await pathIdentity(file)) !== JSON.stringify(entry.path)) throw stale();
  }
}

export async function buildInfo() {
  // A container image has no git, so its build records the commit in build/commit (or POKI_BUILD_COMMIT).
  const recorded = async () => process.env.POKI_BUILD_COMMIT?.trim() || (await readFile(join(root, 'build/commit'), 'utf8').catch(() => '')).trim() || 'unknown';
  const [commit, native] = await Promise.all([
    execute('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, timeout: 1000 }).then(result => result.stdout.trim() || recorded(), recorded),
    stat(bridge).catch(() => null),
  ]);
  return { commit, native_build: native?.mtime.toISOString() ?? 'unknown' };
}

export async function warnIfNativeStale() {
  const native = await stat(bridge).catch(() => null);
  if (!native) return;
  const directory = join(root, 'native/bridge');
  const files = await readdir(directory, { recursive: true }).catch(() => []);
  for (const file of files.filter(file => /(?:\.rs|Cargo\.toml|Cargo\.lock)$/.test(file) && !file.split('/').includes('target'))) {
    const source = await stat(join(directory, file)).catch(() => null);
    if (source?.mtimeMs > native.mtimeMs) {
      console.error('Warning: build/poki-native is older than its source; run ./bin/build-native when the device is available. Continuing with the existing bridge.');
      return;
    }
  }
}
