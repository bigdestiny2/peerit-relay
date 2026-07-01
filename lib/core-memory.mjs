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
import fs from 'node:fs'
import { createSwarmHub } from './swarm-hub.mjs'

const hex = (n) => randomBytes(n).toString('hex')

export function createMemoryCore ({
  maxGroups = 20000,                  // distinct outboxes (minted appIds)
  maxRowsPerGroup = 50000,            // records in one outbox
  maxIdLength = 256,
  maxAppIdLength = 128,
  maxValueBytes = 65536,              // 64 KiB per record (a post body is ~40 KiB)
  maxTotalBytes = 256 * 1024 * 1024,  // 256 MiB heap budget across ALL records — the real bound
  persist = null                      // { path, intervalMs } → snapshot the store to disk so a restart reloads it
} = {}) {
  const groups = new Map() // appId -> { inviteKey, rows: Map<key,value>, version }
  let totalBytes = 0
  let dirty = false
  const fail = (msg, status) => { const e = new Error(msg); e.status = status; return e }
  // The swarm hub remembers signed descriptors and marks us dirty when it learns
  // a new one, so discoverability (not just data) is captured in the snapshot.
  const swarm = createSwarmHub({ onChange: () => { dirty = true } })

  // ---- durability: snapshot to disk (opt-in via `persist.path`) --------------
  // A restart/redeploy otherwise wipes the in-memory store. Load the last
  // snapshot on boot; write it back atomically (tmp+rename), debounced, whenever
  // the store changed. Corrupt/absent file → start empty (never crash the relay).
  function loadSnapshot () {
    if (!persist || !persist.path) return
    let raw
    try { raw = fs.readFileSync(persist.path, 'utf8') } catch { return } // no snapshot yet
    try {
      const snap = JSON.parse(raw)
      if (!snap || !snap.groups) return
      let bytes = 0
      for (const appId of Object.keys(snap.groups)) {
        if (groups.size >= maxGroups) break
        if (typeof appId !== 'string' || appId.length > maxAppIdLength) continue
        const g = snap.groups[appId]; if (!g || typeof g !== 'object') continue
        const rows = new Map()
        for (const k of Object.keys(g.rows || {})) {
          const v = g.rows[k]
          try { bytes += Buffer.byteLength(JSON.stringify(v)) } catch { continue }
          if (bytes > maxTotalBytes || rows.size >= maxRowsPerGroup) break
          rows.set(k, v)
        }
        groups.set(appId, { inviteKey: g.inviteKey || hex(32), rows, version: g.version | 0 })
      }
      totalBytes = bytes
      if (snap.descriptors) swarm._loadDescriptors(snap.descriptors) // restore discoverability, not just data
      console.log(`[core-memory] loaded snapshot: ${groups.size} outboxes, ${(totalBytes / 1024).toFixed(0)} KiB from ${persist.path}`)
    } catch (e) { console.warn('[core-memory] snapshot load failed (starting empty):', e && e.message) }
  }
  function snapshot () {
    const out = {}
    for (const [appId, g] of groups) { const rows = {}; for (const [k, v] of g.rows) rows[k] = v; out[appId] = { inviteKey: g.inviteKey, version: g.version, rows } }
    return JSON.stringify({ v: 1, totalBytes, groups: out, descriptors: swarm._snapshotDescriptors() })
  }
  function flush () {
    if (!persist || !persist.path || !dirty) return
    try { fs.writeFileSync(persist.path + '.tmp', snapshot()); fs.renameSync(persist.path + '.tmp', persist.path); dirty = false }
    catch (e) { console.warn('[core-memory] snapshot write failed:', e && e.message) }
  }
  loadSnapshot()
  if (persist && persist.path) { const t = setInterval(flush, persist.intervalMs || 5000); if (t.unref) t.unref() }

  // Reads NEVER create a group, so hitting get/list/status with minted appIds
  // can't grow the map. Writers create on demand, bounded by maxGroups.
  const getGroup = (appId) => groups.get(appId) || null
  const ensureGroup = (appId) => {
    if (typeof appId !== 'string' || !appId || appId.length > maxAppIdLength) throw fail('bad appId', 400)
    let g = groups.get(appId)
    if (!g) {
      if (groups.size >= maxGroups) throw fail('relay at group capacity', 503)
      g = { inviteKey: hex(32), rows: new Map(), version: 0 }
      groups.set(appId, g)
    }
    return g
  }
  const EMPTY = { inviteKey: null, rows: new Map() }
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
        const g = getGroup(appId) // never create on join — read-side griefing can't grow the map
        if (!g) throw fail('no such outbox', 404)
        if (inviteKey && inviteKey !== g.inviteKey) throw fail('bad invite', 400)
        return { appId, inviteKey: g.inviteKey, writerPublicKey: appId }
      },
      append (appId, op) {
        if (!op || typeof op.type !== 'string' || op.type.length > 64 || !op.data || op.data.id == null) throw fail('bad op', 400)
        const id = String(op.data.id)
        if (id.length > maxIdLength) throw fail('id too long', 400)
        let size
        try { size = Buffer.byteLength(JSON.stringify(op.data)) } catch { throw fail('unserializable record', 400) }
        if (size > maxValueBytes) throw fail('record too large', 413)
        const g = ensureGroup(appId)
        const key = op.type.replace(':', '!') + '!' + id
        const old = g.rows.get(key)
        const oldSize = old === undefined ? 0 : Buffer.byteLength(JSON.stringify(old))
        if (old === undefined && g.rows.size >= maxRowsPerGroup) throw fail('outbox at row capacity', 503)
        if (size > oldSize && totalBytes - oldSize + size > maxTotalBytes) throw fail('relay at storage capacity', 503)
        g.rows.set(key, op.data)
        totalBytes += size - oldSize
        g.version++ // monotonic per-outbox change marker for /api/sync/heads
        dirty = true // schedule a snapshot to disk (if persistence is enabled)
        return { ok: true, key }
      },
      get (appId, key) { const g = getGroup(appId); return g ? (g.rows.get(key) ?? null) : null },
      list (appId, prefix, opts = {}) { return rangeRows(getGroup(appId) || EMPTY, { prefix, limit: opts.limit }) },
      range (appId, opts = {}) { return rangeRows(getGroup(appId) || EMPTY, opts) },
      count (appId, prefix) {
        const g = getGroup(appId)
        if (!g) return { count: 0 }
        if (!prefix) return { count: g.rows.size }
        let n = 0
        for (const k of g.rows.keys()) if (k >= prefix && k < prefix + '\xff') n++
        return { count: n }
      },
      status (appId) { const g = getGroup(appId); return g ? { appId, inviteKey: g.inviteKey, writerCount: 1, viewLength: g.rows.size } : { appId, inviteKey: null, writerCount: 0, viewLength: 0 } },
      // Batched change-markers so a client polls ONE request for N outboxes and
      // only re-reads the ones whose version moved. Untrusted hint: a client must
      // periodically full-reconcile in case the relay reports a stale version.
      heads (appIds) {
        const out = {}
        if (Array.isArray(appIds)) for (const a of appIds) { if (typeof a !== 'string' || a.length > maxAppIdLength) continue; const g = getGroup(a); out[a] = g ? g.version : 0 }
        return { heads: out }
      }
    },
    swarm,
    flush, // force a durability snapshot now (call on graceful shutdown)
    _stats () { return { groups: groups.size, totalBytes } }
  }
}
