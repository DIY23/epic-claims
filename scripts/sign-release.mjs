#!/usr/bin/env node
/**
 * Signs a release checksum file with an ed25519 key.
 *
 *   EPIC_CLAIMS_SIGNING_KEY=<base64 raw 32-byte seed> node scripts/sign-release.mjs SHA256SUMS SHA256SUMS.sig
 *
 * The corresponding public key goes into the app's config
 * (updates.publicKey) or is embedded in the release notes; the updater refuses
 * an unsigned artifact when updates.requireSignature is on.
 */
import fs from 'node:fs';
import crypto from 'node:crypto';

const [input, output] = process.argv.slice(2);
if (!input || !output) {
  console.error('usage: sign-release.mjs <checksums-file> <signature-file>');
  process.exit(2);
}

const seedB64 = process.env.EPIC_CLAIMS_SIGNING_KEY;
if (!seedB64) {
  console.error('EPIC_CLAIMS_SIGNING_KEY is not set (base64-encoded 32-byte ed25519 seed)');
  process.exit(2);
}

const seed = Buffer.from(seedB64, 'base64');
if (seed.length !== 32) {
  console.error(`signing key must decode to 32 bytes, got ${seed.length}`);
  process.exit(2);
}

// Build a PKCS#8 private key from the raw seed.
const pkcs8Prefix = Buffer.from('302e020100300506032b657004220420', 'hex');
const privateKey = crypto.createPrivateKey({ key: Buffer.concat([pkcs8Prefix, seed]), format: 'der', type: 'pkcs8' });
const publicKeyRaw = crypto.createPublicKey(privateKey).export({ format: 'der', type: 'spki' }).subarray(-32);

const data = fs.readFileSync(input);
const signature = crypto.sign(null, data, privateKey);
fs.writeFileSync(output, `${signature.toString('base64')}\n`, { mode: 0o644 });

console.log(`signature written to ${output}`);
console.log(`public key (configure updates.publicKey): ${publicKeyRaw.toString('base64')}`);
