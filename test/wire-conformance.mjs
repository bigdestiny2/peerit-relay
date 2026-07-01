// wire-conformance.mjs — the GOLDEN wire contract for peerit's browser data plane.
//
// This is the Phase-2 gate from docs/HIVERELAY-OUTBOXLOG-PLAN.md (peerit repo):
// the plan generalizes this relay's `core-memory` engine into a first-class,
// app-agnostic HiveRelay service (`OutboxLog`). The linchpin — "an UNMODIFIED
// peerit web build converges through it" — is only true if OutboxLog reproduces
// this exact `sync.*` behavior. The prior audit flagged that claim as asserted,
// not tested. This file makes it executable.
//
// `runWireConformance(sync, { label })` drives ANY sync-shaped engine through a
// canonical, deterministic op sequence and asserts the responses. It runs here
// against `createMemoryCore().sync` (the reference), and is exported so the
// OutboxLog port can be dropped in and gated on the identical assertions.
//
// It ALSO documents the one deliberate DELTA the port must add: core-memory does
// NO write-time signature/writer verification (it stores whatever bytes any caller
// sends). OutboxLog MUST enforce single-writer Ed25519 — see the SPEC NOTES at the
// bottom, which demonstrate the gap so it can't be forgotten.

import assert from 'node:assert'
import { createMemoryCore } from '../lib/core-memory.mjs'

const HEX64 = /^[0-9a-f]{64}$/i
// Two deterministic author outbox ids (in peerit these are Ed25519 pubkey hex).
const A = 'a'.repeat(64)
const B = 'b'.repeat(64)

// A canonical record body; `id` is required by the engine and becomes the key tail.
const post = (id, extra = {}) => ({ id, ...extra })

export function runWireConformance (sync, { label = 'engine' } = {}) {
  let passed = 0
  const ok = (c, m) => { assert.ok(c, `[${label}] ${m}`); passed++ }
  const eq = (a, b, m) => { assert.deepStrictEqual(a, b, `[${label}] ${m}`); passed++ }

  // ── create / writer identity ──────────────────────────────────────────────
  const created = sync.create(A)
  ok(created.appId === A, 'create returns the appId')
  ok(created.writerPublicKey === A, 'writer public key == appId (single-writer outbox)')
  ok(HEX64.test(created.inviteKey), 'create returns a 64-hex inviteKey')

  // join never creates; a bad invite is rejected, a good one echoes the outbox.
  ok(sync.join(A, created.inviteKey).appId === A, 'join with the correct invite succeeds')
  assert.throws(() => sync.join(B, 'x'), `[${label}] join on an unknown outbox throws`); passed++

  // ── append: deterministic keys = type.replace(':','!') + '!' + id ──────────
  eq(sync.append(A, { type: 'post', data: post('p1', { t: 'hello' }) }), { ok: true, key: 'post!p1' }, 'append post p1 -> post!p1')
  eq(sync.append(A, { type: 'post', data: post('p2', { t: 'world' }) }), { ok: true, key: 'post!p2' }, 'append post p2 -> post!p2')
  eq(sync.append(A, { type: 'vote', data: post('p1:voterX', { dir: 1 }) }), { ok: true, key: 'vote!p1:voterX' }, 'append vote -> vote!p1:voterX')
  // the signed head record (type head, id == appId) is what directory() serves
  eq(sync.append(A, { type: 'head', data: post(A, { version: 1, count: 3, root: 'r' }) }), { ok: true, key: 'head!' + A }, 'append head -> head!<appId>')

  // ── point read / prefix list / range / count ───────────────────────────────
  eq(sync.get(A, 'post!p1'), post('p1', { t: 'hello' }), 'get returns the stored record body')
  ok(sync.get(A, 'post!nope') === null, 'get of a missing key is null')

  eq(sync.list(A, 'post!').map((r) => r.key), ['post!p1', 'post!p2'], 'list by prefix returns sorted matching keys')
  eq(sync.list(A, 'post!')[0].value, post('p1', { t: 'hello' }), 'list rows carry {key,value}')

  eq(sync.range(A, { gt: 'post!p1', limit: 10 }).map((r) => r.key), ['post!p2', 'vote!p1:voterX'], 'range gt is exclusive and ordered')
  eq(sync.range(A, { prefix: 'post!', reverse: true }).map((r) => r.key), ['post!p2', 'post!p1'], 'range reverse flips order')
  ok(sync.range(A, { limit: 0 }).length <= 1000, 'range clamps a bad limit into 1..1000')

  eq(sync.count(A, 'post!'), { count: 2 }, 'count by prefix')
  eq(sync.count(A), { count: 4 }, 'count with no prefix = all rows')

  // ── heads: per-outbox monotonic version, batched, 0 for unknown ────────────
  const h = sync.heads([A, B])
  ok(h.heads[A] === 4, 'heads reports the appId version after 4 appends')
  ok(h.heads[B] === 0, 'heads reports 0 for an outbox that does not exist')

  // a write bumps the version; a read does not
  sync.append(A, { type: 'post', data: post('p3') })
  ok(sync.heads([A]).heads[A] === 5, 'a further append bumps the version to 5')

  // ── directory: every outbox\'s signed head record in one response ───────────
  sync.create(B)
  sync.append(B, { type: 'head', data: post(B, { version: 1, count: 0, root: 'r' }) })
  const dir = sync.directory()
  ok(dir.heads[A] && dir.heads[A].version === 1, 'directory carries A\'s head record')
  ok(dir.heads[B] && dir.heads[B].id === B, 'directory carries B\'s head record')
  ok(dir.count === 2, 'directory count == number of heads returned')

  // ── validation / DoS bounds ────────────────────────────────────────────────
  assert.throws(() => sync.append(A, { type: 'post', data: { t: 'no id' } }), `[${label}] append without data.id is 400`); passed++
  assert.throws(() => sync.append(A, { type: 'post', data: post('big', { blob: 'x'.repeat(70 * 1024) }) }), `[${label}] oversized record is 413`); passed++

  return passed
}

// ── run against the reference engine (the golden baseline) ────────────────────
function main () {
  const core = createMemoryCore()
  const n = runWireConformance(core.sync, { label: 'core-memory' })
  console.log(`  ✓ core-memory satisfies ${n} wire-conformance assertions`)

  // ── SPEC NOTES: the DELTA OutboxLog must add over this reference ────────────
  // core-memory holds no key and verifies nothing on write — it stores whatever
  // bytes any token-holder sends to any appId. That is safe here ONLY because the
  // peerit CLIENT re-verifies every record's Ed25519 signature at merge. When this
  // engine becomes a shared multi-tenant HiveRelay service, it MUST additionally
  // enforce single-writer authenticity server-side. Demonstrate the gap so the port
  // cannot silently inherit it:
  const c2 = createMemoryCore()
  c2.sync.create(A)
  const forged = c2.sync.append(A, { type: 'post', data: { id: 'forged', _writer: B, sig: 'deadbeef' } })
  assert.ok(forged.ok, 'DEMONSTRATED GAP: core-memory accepts a record into A\'s outbox with a foreign/garbage writer+sig')
  console.log('  ⚠ SPEC NOTE — OutboxLog port MUST add write-time single-writer Ed25519 verification:')
  console.log('      • reject any append whose record is not signed by the outbox\'s writer key (appId)')
  console.log('      • verify only the signable envelope fields; never inspect an (opaque/ciphertext) body')
  console.log('      • preserve every read/heads/directory shape asserted above (byte-identical wire)')

  console.log(`\n✅ wire-conformance: ${n} golden assertions locked; OutboxLog port gate is executable\n`)
  process.exit(0)
}

// Only run main() when invoked directly, so the OutboxLog port can `import
// { runWireConformance }` without triggering the reference run.
if (import.meta.url === `file://${process.argv[1]}`) main()
