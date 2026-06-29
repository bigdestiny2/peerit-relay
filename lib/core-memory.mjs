// core-memory.mjs — in-process sync + swarm core for the peerit relay.
//
// The TESTED default backend (see test/relay-e2e.mjs): per-appId single-writer
// outboxes keyed by the bridge's generic reducer, plus the shared swarm hub. Two
// browser clients pointed at one relay using this core converge for real — it
// stands in for the Hyperswarm DHT that the production core (core-hypercore.mjs)
// reaches. Ephemeral (memory only) and single-process; use it for CI, local dev,
// and small single-relay deployments.
//
// Holds NO signing key: append() stores whatever bytes the client sends, and
// authenticity is the client-verified Ed25519 signature inside each record — so
// this core can withhold or reorder but never forge.

import { randomBytes } from 'node:crypto'
import { createSwarmHub } from './swarm-hub.mjs'

const hex = (n) => randomBytes(n).toString('hex')

export function createMemoryCore () {
  const groups = new Map() // appId -> { inviteKey, rows: Map<key,value> }

  const ensureGroup = (appId) => {
    if (!groups.has(appId)) groups.set(appId, { inviteKey: hex(32), rows: new Map() })
    return groups.get(appId)
  }
  const sortedRows = (g) => [...g.rows.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([key, value]) => ({ key, value }))

  function rangeRows (g, opts = {}) {
    let rows = sortedRows(g)
    if (opts.prefix) rows = rows.filter((r) => r.key >= opts.prefix && r.key < opts.prefix + '\xff')
    if (opts.gte != null && opts.gte !== '') rows = rows.filter((r) => r.key >= opts.gte)
    if (opts.gt != null && opts.gt !== '') rows = rows.filter((r) => r.key > opts.gt)
    if (opts.lte != null && opts.lte !== '') rows = rows.filter((r) => r.key <= opts.lte)
    if (opts.lt != null && opts.lt !== '') rows = rows.filter((r) => r.key < opts.lt)
    if (opts.reverse) rows.reverse()
    let limit = Number(opts.limit) || 100
    if (limit < 1) limit = 100
    if (limit > 1000) limit = 1000
    return rows.slice(0, limit)
  }

  return {
    sync: {
      create (appId) { const g = ensureGroup(appId); return { appId, inviteKey: g.inviteKey, writerPublicKey: appId } },
      join (appId, inviteKey) {
        const g = ensureGroup(appId)
        if (inviteKey && inviteKey !== g.inviteKey) { const e = new Error('bad invite'); e.status = 400; throw e }
        return { appId, inviteKey: g.inviteKey, writerPublicKey: appId }
      },
      append (appId, op) {
        if (!op || !op.type || !op.data || op.data.id == null) { const e = new Error('bad op'); e.status = 400; throw e }
        const g = ensureGroup(appId)
        const key = op.type.replace(':', '!') + '!' + op.data.id
        g.rows.set(key, op.data)
        return { ok: true, key }
      },
      get (appId, key) { return ensureGroup(appId).rows.get(key) ?? null },
      list (appId, prefix, opts = {}) { return rangeRows(ensureGroup(appId), { prefix, limit: opts.limit }) },
      range (appId, opts = {}) { return rangeRows(ensureGroup(appId), opts) },
      count (appId, prefix) {
        const g = ensureGroup(appId)
        if (!prefix) return { count: g.rows.size }
        let n = 0
        for (const k of g.rows.keys()) if (k >= prefix && k < prefix + '\xff') n++
        return { count: n }
      },
      status (appId) { const g = ensureGroup(appId); return { appId, inviteKey: g.inviteKey, writerCount: 1, viewLength: g.rows.size } }
    },
    swarm: createSwarmHub(),
    _stats () { return { groups: groups.size } }
  }
}
