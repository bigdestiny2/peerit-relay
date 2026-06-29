// core-hypercore.mjs — PRODUCTION sync backend. Replicates each peerit outbox as
// a Hyperbee over Hyperswarm, so records reach the peerit-seeder fleet,
// PearBrowser-native peers, and other relays. The shared swarm hub handles
// browser-to-browser descriptor discovery within this relay (see swarm-hub.mjs).
//
// ⚠ NOT exercised by CI: it needs a live DHT and `npm i corestore hyperbee
// hyperswarm b4a`. Treat it as a reference implementation to validate on a real
// network before relying on it. The CI-proven contract reference is
// core-memory.mjs — this file matches its method shapes exactly.
//
// Untrusted by construction: the relay holds the WRITABLE hyperbee for outboxes
// that browsers create here, but it cannot forge — every row carries an Ed25519
// signature minted in the browser and re-verified by every peer at merge. The
// relay can withhold/reorder; it can never impersonate.
//
// Known item to validate on-network: peerit keys are ASCII (`type!id`), so the
// `prefix + '\xff'` upper bound used for prefix scans matches the JS string-compare
// semantics for that keyspace; confirm the boundary against Hyperbee's utf-8 byte
// ordering for any non-ASCII slug before trusting prefix queries broadly.

import Corestore from 'corestore'
import Hyperbee from 'hyperbee'
import Hyperswarm from 'hyperswarm'
import b4a from 'b4a'
import { createSwarmHub } from './swarm-hub.mjs'

export async function createHypercoreCore ({ storage = './relay-store' } = {}) {
  const store = new Corestore(storage)
  await store.ready()
  const swarm = new Hyperswarm()
  swarm.on('connection', (conn) => store.replicate(conn))

  const bees = new Map() // appId -> { bee, core, writable }
  const keyHex = (core) => b4a.toString(core.key, 'hex')

  async function openWritable (appId) {
    let entry = bees.get(appId)
    if (entry) return entry
    const core = store.get({ name: 'outbox:' + appId }) // deterministic, writable
    const bee = new Hyperbee(core, { keyEncoding: 'utf-8', valueEncoding: 'json' })
    await bee.ready()
    swarm.join(core.discoveryKey, { server: true, client: true })
    entry = { bee, core, writable: true }
    bees.set(appId, entry)
    return entry
  }

  async function openByKey (appId, inviteKey) {
    let entry = bees.get(appId)
    if (entry) return entry
    const core = store.get({ key: b4a.from(inviteKey, 'hex') }) // read-only replica of a peer's outbox
    const bee = new Hyperbee(core, { keyEncoding: 'utf-8', valueEncoding: 'json' })
    await bee.ready()
    swarm.join(core.discoveryKey, { server: false, client: true })
    entry = { bee, core, writable: false }
    bees.set(appId, entry)
    return entry
  }

  async function readRange (bee, { prefix, gt, gte, lt, lte, reverse, limit } = {}) {
    const range = {}
    if (prefix) { range.gte = prefix; range.lt = prefix + '\xff' }
    if (gte != null && gte !== '') range.gte = gte
    if (gt != null && gt !== '') range.gt = gt
    if (lte != null && lte !== '') range.lte = lte
    if (lt != null && lt !== '') range.lt = lt
    let lim = Number(limit) || 100
    if (lim < 1) lim = 100
    if (lim > 1000) lim = 1000
    const out = []
    for await (const node of bee.createReadStream({ ...range, reverse: !!reverse, limit: lim })) {
      out.push({ key: node.key, value: node.value })
    }
    return out
  }

  const sync = {
    async create (appId) { const { core } = await openWritable(appId); return { appId, inviteKey: keyHex(core), writerPublicKey: appId } },
    async join (appId, inviteKey) {
      const entry = bees.get(appId) || await openByKey(appId, inviteKey)
      return { appId, inviteKey: keyHex(entry.core), writerPublicKey: appId }
    },
    async append (appId, op) {
      if (!op || !op.type || !op.data || op.data.id == null) { const e = new Error('bad op'); e.status = 400; throw e }
      const { bee, writable } = await openWritable(appId)
      if (!writable) { const e = new Error('outbox not writable on this relay'); e.status = 409; throw e }
      const key = op.type.replace(':', '!') + '!' + op.data.id
      await bee.put(key, op.data)
      return { ok: true, key }
    },
    async get (appId, key) { const e = bees.get(appId); if (!e) return null; const n = await e.bee.get(key); return n ? n.value : null },
    async list (appId, prefix, opts = {}) { const e = bees.get(appId); if (!e) return []; return readRange(e.bee, { prefix, limit: opts.limit }) },
    async range (appId, opts = {}) { const e = bees.get(appId); if (!e) return []; return readRange(e.bee, opts) },
    async count (appId, prefix) { const rows = await sync.list(appId, prefix || '', { limit: 1000 }); return { count: rows.length } },
    async status (appId) { const e = bees.get(appId); return { appId, inviteKey: e ? keyHex(e.core) : null, writerCount: 1, viewLength: e ? e.core.length : 0 } }
  }

  return {
    sync,
    swarm: createSwarmHub(),
    async destroy () { try { await swarm.destroy() } catch {} try { await store.close() } catch {} }
  }
}
