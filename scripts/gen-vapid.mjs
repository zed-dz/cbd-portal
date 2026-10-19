// Generate a VAPID key pair for Web Push without any network or npm package.
//   node scripts/gen-vapid.mjs            → prints PUBLIC=… / PRIVATE=…
//   node scripts/gen-vapid.mjs out.txt    → writes them to that file (one per line), prints only PUBLIC
//
// PUBLIC  = base64url of the raw, uncompressed P-256 point (65 bytes, 0x04 || X || Y)
//           — what pushManager.subscribe({ applicationServerKey }) wants and what goes
//           in the client env var REACT_APP_VAPID_PUBLIC_KEY (it is public by design).
// PRIVATE = base64url of the raw 32-byte scalar — the VAPID_PRIVATE_KEY function secret.
import { generateKeyPairSync } from 'node:crypto';
import { writeFileSync } from 'node:fs';

const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const pub = publicKey.export({ format: 'jwk' });
const prv = privateKey.export({ format: 'jwk' });

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const raw = Buffer.concat([Buffer.from([4]), Buffer.from(pub.x, 'base64url'), Buffer.from(pub.y, 'base64url')]);
if (raw.length !== 65) throw new Error('unexpected public key length ' + raw.length);
const d = Buffer.from(prv.d, 'base64url');
if (d.length !== 32) throw new Error('unexpected private key length ' + d.length);

const lines = [`PUBLIC=${b64u(raw)}`, `PRIVATE=${b64u(d)}`];
if (process.argv[2]) {
  writeFileSync(process.argv[2], lines.join('\n') + '\n');
  console.log(`PUBLIC=${b64u(raw)}`);
  console.log(`written: ${process.argv[2]}`);
} else {
  console.log(lines.join('\n'));
}
