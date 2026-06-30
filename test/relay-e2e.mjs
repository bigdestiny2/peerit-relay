// relay-e2e.mjs — end-to-end proof that the relay's real HTTP/SSE surface makes
// two UNMODIFIED peerit web clients converge in gossip-bridge mode, with keys
// held locally (DevIdentity) and the relay never signing. Boots the actual
// http.Server (in-memory core), drives two clients over global fetch + a real
// SSE client. This is the web data path exercised for real, minus the live DHT
// (the shared in-memory core stands in for swarm replication between peers).
//
// Run: node test/relay-e2e.mjs

import assert from 'node:assert'
import http from 'node:http'
import { createMemoryCore } from '../lib/core-memory.mjs'
import { createRelayHandler } from '../lib/server.mjs'
import { createTokenAuth } from '../lib/token.mjs'
import { DevIdentity } from '../../peerit/js/identity.js'
import { createData } from '../../peerit/js/data.js'
import { createSync } from '../../peerit/js/sync.js'
import { genKeyPair, sign, ready as cryptoReady, isSecure } from '../../peerit/js/crypto.js'
import { makeValidator } from '../../peerit/js/pow.js'
import { normalizeRelayRosterPayload, resolveRelayCandidates, rosterSigningMessage, selectRelay } from '../../peerit/js/relay-roster.js'

let passed = 0
const ok = (c, m) => { assert.ok(c, m); passed++; console.log('  ✓ ' + m) }
const delay = (ms) => new Promise((r) => setTimeout(r, ms))
const BITS = { community: 7, post: 6, comment: 5 }
function mem () { const m = new Map(); return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k), clear: () => m.clear() } }
async function until (fn, { tries = 140, gap = 70 } = {}) { for (let i = 0; i < tries; i++) { if (await fn()) return true; await delay(gap) } return false }
function response (value, status = 200) { return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(value), json: async () => value } }

async function makeSignedRoster (relays) {
  const kp = await genKeyPair()
  const payload = normalizeRelayRosterPayload({ version: 1, expires: '2030-01-01T00:00:00.000Z', relays })
  const sig = await sign(kp.seedHex, rosterSigningMessage(payload))
  return { key: kp.pubHex, roster: { payload, signature: { alg: 'Ed25519', key: kp.pubHex, sig } } }
}

// Minimal SSE client over node http — the relay sends `data: {json}\n\n` frames.
class NodeEventSource {
  constructor (url) {
    this.url = String(url); this.onmessage = null; this.onerror = null; this._closed = false
    this._req = http.get(this.url, (res) => {
      res.setEncoding('utf8')
      let buf = ''
      res.on('data', (d) => {
        buf += d
        let idx
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, idx); buf = buf.slice(idx + 2)
          const line = frame.split('\n').find((l) => l.startsWith('data:'))
          if (line && this.onmessage) this.onmessage({ data: line.slice(5).trim() })
        }
      })
      res.on('end', () => { if (!this._closed && this.onerror) this.onerror(new Error('stream ended')) })
    })
    this._req.on('error', (e) => { if (!this._closed && this.onerror) this.onerror(e) })
  }
  close () { this._closed = true; try { this._req.destroy() } catch {} }
}

async function makeClient (base, token, name) {
  const id = new DevIdentity(mem(), mem()); await id.ready(); await id.createUser(name)
  const sync = createSync({
    apiBase: base,
    apiToken: token,
    fetch: globalThis.fetch,
    EventSource: NodeEventSource,
    storage: mem(),
    getMe: () => id.me().pubkey,
    identity: id,                 // LOCAL keys — the relay never signs
    validate: makeValidator(BITS),
    pollMs: 400
  })
  await sync.ready()
  return { id, sync, data: createData(sync, id, { minBits: BITS }), pub: id.me().pubkey, name }
}

async function main () {
  await cryptoReady()
  ok(isSecure(), 'real Ed25519 backend available')

  const core = createMemoryCore()
  const auth = createTokenAuth({ secret: 'test-secret' })
  const server = http.createServer(createRelayHandler({ core, auth }))
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const base = 'http://127.0.0.1:' + server.address().port
  const deadBase = 'http://127.0.0.1:1'

  console.log('\n— relay contract: auth + CORS + no signing —')
  ok((await fetch(base + '/api/sync/status?appId=x')).status === 401, 'requests without a token are rejected (401)')
  const tok = (await (await fetch(base + '/api/token', { method: 'POST' })).json()).token
  ok(typeof tok === 'string' && tok.length > 16, 'POST /api/token issues a first-visit token')
  const idRes = await fetch(base + '/api/identity', { headers: { 'x-pear-token': tok } })
  ok(idRes.status === 410, '/api/identity is disabled (relay never signs — keys are browser-local)')
  const pre = await fetch(base + '/api/sync/status?appId=x', { method: 'OPTIONS' })
  ok(pre.status === 204 && pre.headers.get('access-control-allow-headers').includes('x-pear-token'), 'CORS preflight allows the X-Pear-Token header (cross-origin browser access)')

  console.log('\n— signed roster + client relay selection —')
  const signed = await makeSignedRoster([deadBase, base])
  const candidates = await resolveRelayCandidates({
    relays: [deadBase],
    roster: { url: 'https://peerit.test/relay-roster.json', key: signed.key },
    fetch: async () => response(signed.roster),
    now: Date.parse('2029-01-01T00:00:00.000Z')
  })
  ok(candidates.rosterVerified && candidates.relays[0] === deadBase && candidates.relays[1] === base,
    'client verifies the signed roster and preserves relay priority')
  const selected = await selectRelay(candidates.relays, { fetch: globalThis.fetch })
  ok(selected && selected.apiBase === base && typeof selected.apiToken === 'string',
    'client skips the dead relay and gets a token from the live relay')

  console.log('\n— two web clients converge through the real relay —')
  const alice = await makeClient(selected.apiBase, selected.apiToken, 'alice')
  const bob = await makeClient(selected.apiBase, selected.apiToken, 'bob')
  ok(alice.sync.mode === 'gossip-bridge' && bob.sync.mode === 'gossip-bridge', 'both web clients run gossip-bridge over HTTP (the chip reads "gossip-bridge")')
  ok(alice.id.isDev === true && bob.id.isDev === true, 'identities are browser-local (DevIdentity), not host/relay-signed')

  await alice.data.createCommunity({ slug: 'web', title: 'Web', description: 'over the relay' })
  const aPost = await alice.data.submitPost({ community: 'web', kind: 'text', title: 'hello from the web', body: 'no PearBrowser needed' })
  ok(await until(() => bob.data.getCommunity('web')), 'bob discovers alice over the relay swarm and sees r/web')
  ok(await until(() => bob.data.listPostsIn('web').then((ps) => ps.some((p) => p.cid === aPost.cid))), "bob sees alice's post through the relay")

  const bPost = await bob.data.submitPost({ community: 'web', kind: 'text', title: 'bob replies', body: 'hi' })
  ok(await until(() => alice.data.getPost('web', bPost.cid)), "alice sees bob's reply (bidirectional convergence over HTTP)")

  await alice.data.vote(aPost.cid, 'web', 'post', 1)
  await bob.data.vote(aPost.cid, 'web', 'post', 1)
  ok(await until(async () => (await bob.data.tallyFor(aPost.cid)).score === 2), 'cross-writer votes aggregate to score 2 through the relay')

  alice.sync.destroy(); bob.sync.destroy()
  await new Promise((r) => server.close(r))
  console.log(`\n✅ all ${passed} relay e2e checks passed\n`)
}

main().catch((e) => { console.error('\n❌ FAILED:', e.message, '\n', e.stack); process.exit(1) })
