import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createECDH } from 'node:crypto';
import { copyFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { root } from '../src/config.mjs';
import { KEM, keyId, phoneKey, seal } from '../src/install/model-key.mjs';

const exec = promisify(execFile);
const swiftSeal = join(root, 'native/ios-app/Poki/Setup/ModelKeySeal.swift');

// Poki's own ModelKeySeal.swift, built for this Mac with a main that opens one sealed file with a
// software key (the phone uses the Secure Enclave; the agreement is the same P-256 ECDH).
async function swiftOpener(t) {
  const dir = await mkdtemp(join(tmpdir(), 'poki-seal-swift-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await copyFile(swiftSeal, join(dir, 'ModelKeySeal.swift'));
  await writeFile(join(dir, 'main.swift'), `import CryptoKit
import Foundation
let a = CommandLine.arguments
let key = try P256.KeyAgreement.PrivateKey(rawRepresentation: Data(base64Encoded: a[1])!)
let sealed = try Data(contentsOf: URL(fileURLWithPath: a[3]))
do {
    let opened = try ModelKeySeal.open(sealed, publicKey: key.publicKey, bundleID: a[2]) { try key.sharedSecretFromKeyAgreement(with: $0) }
    print("\\(opened.provider) \\(opened.secret)")
} catch { print("refused \\(error)") }
`);
  await exec('swiftc', ['-O', '-o', join(dir, 'open'), join(dir, 'ModelKeySeal.swift'), join(dir, 'main.swift')], { timeout: 180000 });
  return async (privateKey, bundleId, sealed) => {
    const file = join(dir, `sealed-${Math.random().toString(36).slice(2)}.json`);
    await writeFile(file, sealed);
    // CryptoKit's raw P-256 representation is a fixed-width, big-endian scalar.
    assert.ok(privateKey.length > 0 && privateKey.length <= 32);
    const rawKey = Buffer.alloc(32);
    privateKey.copy(rawKey, rawKey.length - privateKey.length);
    return (await exec(join(dir, 'open'), [rawKey.toString('base64'), bundleId, file])).stdout.trim();
  };
}

const hasSwift = await exec('swiftc', ['--version']).then(() => true, () => false);

test('a key the installer seals opens in Poki\'s Swift code, only for that phone key, that app and that provider', { skip: !hasSwift && 'no swiftc on this Mac' }, async t => {
  const open = await swiftOpener(t);
  const phone = createECDH('prime256v1');
  // Node omits leading zero bytes; exercise the scalar format that previously failed at random.
  phone.setPrivateKey(Buffer.from('000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f', 'hex'));
  assert.equal(phone.getPrivateKey().length, 31);
  const hello = { model_key: { kem: KEM, public_key: phone.getPublicKey().toString('base64url'), key_id: keyId(phone.getPublicKey()) } };
  const bundleId = 'nz.zheha.poki.TEAMID1234';
  const secret = ['sk', 'proj', 'FAKEinteropKEY0123456789'].join('-');
  const sealed = seal({ secret, provider: 'openai', bundleId, phone: phoneKey(hello) });
  assert.ok(!sealed.toString().includes(secret), 'the sealed file does not carry the key in the clear');
  assert.equal(await open(phone.getPrivateKey(), bundleId, sealed), `openai ${secret}`);

  assert.match(await open(phone.getPrivateKey(), 'nz.zheha.poki.OTHERTEAM', sealed), /refused otherApp/, 'another app does not open it');
  const other = createECDH('prime256v1');
  other.generateKeys();
  assert.match(await open(other.getPrivateKey(), bundleId, sealed), /refused otherKey/, 'another phone key does not open it');
  const relabelled = JSON.stringify({ ...JSON.parse(sealed), provider: 'anthropic' });
  assert.match(await open(phone.getPrivateKey(), bundleId, relabelled), /refused broken/, 'a provider changed on the way does not open');
  const late = seal({ secret, provider: 'openai', bundleId, phone: phoneKey(hello), now: Date.now() - 11 * 60 * 1000 });
  assert.match(await open(phone.getPrivateKey(), bundleId, late), /refused expired/, 'a sealed key older than 10 minutes does not open');
});

test('a hello whose key does not match its id, or is not a P-256 point, gets no sealed key', () => {
  const phone = createECDH('prime256v1');
  phone.generateKeys();
  const good = { kem: KEM, public_key: phone.getPublicKey().toString('base64url'), key_id: keyId(phone.getPublicKey()) };
  assert.ok(phoneKey({ model_key: good }));
  assert.equal(phoneKey({ model_key: { ...good, key_id: '0000000000000000' } }), null);
  assert.equal(phoneKey({ model_key: { ...good, public_key: Buffer.alloc(65, 7).toString('base64url') } }), null);
  assert.equal(phoneKey({ model_key: { ...good, kem: 'RSA' } }), null);
  assert.equal(phoneKey({}), null);
});
