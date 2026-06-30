// sign-roster.mjs — offline helper for publishing a signed peerit relay roster.
//
// Usage:
//   PEERIT_ROSTER_SEED=<64-hex-ed25519-seed> \
//     node scripts/sign-roster.mjs --relay https://relay-a.peerit.com \
//       --relay https://relay-b.peerit.com --expires 2026-12-31T00:00:00.000Z \
//       --out ../peerit/relay-roster.json
//
// To create a key:
//   node scripts/sign-roster.mjs --generate-key

import { createPrivateKey, createPublicKey } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { genKeyPair, sign } from '../../peerit/js/crypto.js'
import { normalizeRelayRosterPayload, rosterSigningMessage } from '../../peerit/js/relay-roster.js'

const PKCS8_PREFIX = '302e020100300506032b657004220420'
const HEX64 = /^[0-9a-f]{64}$/i

function arg (name) {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : null
}

function args (name) {
  const out = []
  for (let i = 0; i < process.argv.length; i++) if (process.argv[i] === name && process.argv[i + 1]) out.push(process.argv[i + 1])
  return out
}

function die (message) {
  console.error(message)
  process.exit(1)
}

function pubFromSeed (seedHex) {
  const privateKey = createPrivateKey({ key: Buffer.from(PKCS8_PREFIX + seedHex, 'hex'), format: 'der', type: 'pkcs8' })
  const spki = createPublicKey(privateKey).export({ type: 'spki', format: 'der' })
  return Buffer.from(spki).toString('hex').slice(-64)
}

if (process.argv.includes('--generate-key')) {
  const kp = await genKeyPair()
  console.log(JSON.stringify({ seed: kp.seedHex, publicKey: kp.pubHex, alg: 'Ed25519' }, null, 2))
  process.exit(0)
}

const seed = String(arg('--seed') || process.env.PEERIT_ROSTER_SEED || '').trim().toLowerCase()
if (!HEX64.test(seed)) die('missing --seed / PEERIT_ROSTER_SEED (64 hex chars)')

const relays = [
  ...args('--relay'),
  ...(process.env.PEERIT_RELAY_ROSTER_RELAYS ? process.env.PEERIT_RELAY_ROSTER_RELAYS.split(',') : [])
].map((s) => s.trim()).filter(Boolean)
if (!relays.length) die('provide at least one --relay')

const expires = arg('--expires') || process.env.PEERIT_ROSTER_EXPIRES || new Date(Date.now() + 30 * 86400000).toISOString()
const payload = normalizeRelayRosterPayload({ version: 1, expires, relays })
if (!payload.relays.length) die('no valid relay URLs after normalization')

const key = pubFromSeed(seed)
const sig = await sign(seed, rosterSigningMessage(payload))
const roster = { payload, signature: { alg: 'Ed25519', key, sig } }
const json = JSON.stringify(roster, null, 2) + '\n'
const out = arg('--out')
if (out) writeFileSync(out, json)
else process.stdout.write(json)
