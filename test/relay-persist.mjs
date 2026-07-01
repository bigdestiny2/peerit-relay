// relay-persist.mjs — the memory core's opt-in disk persistence survives a
// restart, so a Render recycle no longer wipes the store. Off by default.
//   node test/relay-persist.mjs
import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import { createMemoryCore } from '../lib/core-memory.mjs'

let passed = 0
const ok = (c, m) => { assert.ok(c, m); passed++; console.log('  ✓ ' + m) }
const A = 'a'.repeat(64), B = 'b'.repeat(64)
const p = os.tmpdir() + '/peerit-persist-test-' + process.pid + '.json'
const mk = () => createMemoryCore({ persist: { path: p, intervalMs: 1e9 } }) // huge interval → only explicit flush() writes

function main () {
  try { fs.unlinkSync(p) } catch {}
  console.log('\n— memory core: opt-in disk persistence survives a restart —')

  const c0 = mk()
  ok(c0._stats().groups === 0, 'a fresh persist path starts empty (no crash on a missing file)')

  c0.sync.create(A)
  c0.sync.append(A, { type: 'post', data: { id: 'x', cid: 'x', community: 'c', title: 'durable' } })
  c0.sync.append(A, { type: 'post', data: { id: 'y', cid: 'y', community: 'c', title: 'also durable' } })
  ok(!fs.existsSync(p), 'nothing hits disk before flush (writes are debounced)')
  c0.flush()
  ok(fs.existsSync(p), 'flush() writes the snapshot')

  const c1 = mk() // "restart"
  ok(c1.sync.status(A).viewLength === 2, 'a restarted core reloads both records from the snapshot')
  ok(c1.sync.get(A, 'post!x').title === 'durable', 'record content survives the restart')
  ok(c1.sync.heads([A]).heads[A] === 2, 'the per-outbox version survives too (heads-gating still works after a restart)')

  c1.sync.append(A, { type: 'post', data: { id: 'z', cid: 'z', community: 'c', title: 'post-restart' } })
  c1.flush()
  ok(mk().sync.status(A).viewLength === 3, 'writes made after a reload persist across the next restart')

  fs.writeFileSync(p, '{ not valid json')
  ok(mk()._stats().groups === 0, 'a corrupt snapshot is ignored (starts empty, never crashes the relay)')

  const off = createMemoryCore() // persistence disabled
  off.sync.create(B); off.sync.append(B, { type: 'post', data: { id: 'n', cid: 'n', community: 'c', title: 't' } })
  ok(typeof off.flush === 'function' && off.flush() === undefined, 'flush() is a safe no-op when persistence is off (no file written)')

  try { fs.unlinkSync(p) } catch {}
  console.log(`\n✅ all ${passed} relay persistence checks passed\n`)
}
main()
