// relay-discovery.mjs — the swarm hub REMEMBERS signed descriptors and REPLAYS
// them to new joiners, so a visitor discovers an outbox even when its author is
// offline (no always-on seeder required); and those descriptors survive a relay
// restart via the disk snapshot. The relay can't forge these — each carries the
// author's Ed25519 signature, re-verified client-side — so replay is safe.
//   node test/relay-discovery.mjs
import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import { createSwarmHub } from '../lib/swarm-hub.mjs'
import { createMemoryCore } from '../lib/core-memory.mjs'

let passed = 0
const ok = (c, m) => { assert.ok(c, m); passed++; console.log('  ✓ ' + m) }
const tick = () => new Promise((r) => setTimeout(r, 5)) // subscribe defers replay by one turn
const T = 'topic-'.padEnd(64, '0')

// Join a topic and collect every descriptor (message payload) the channel receives.
function joinAndCollect (hub, topic) {
  const msgs = []
  const { channelId } = hub.join(topic)
  hub.subscribe(channelId, (ev) => { if (ev.type === 'message') msgs.push(ev.data) })
  return { channelId, msgs }
}

async function main () {
  console.log('\n— swarm hub: descriptor re-broadcast (discovery without a live seeder) —')

  // 1. Author announces a signed descriptor, then disconnects.
  const hub = createSwarmHub()
  const desc = JSON.stringify({ appId: 'a'.repeat(64), sig: 'deadbeef' })
  const author = hub.join(T)
  hub.subscribe(author.channelId, () => {})
  await tick()
  hub.send(author.channelId, 'noone', desc) // broadcast the descriptor to the topic
  hub.leave(author.channelId)               // author goes offline

  // 2. A fresh visitor joins the same topic and STILL discovers the outbox.
  const v = joinAndCollect(hub, T)
  await tick()
  ok(v.msgs.includes(desc), 'a fresh joiner receives the descriptor even though the author is offline')

  // 3. Dedupe: re-announcing an identical descriptor is not replayed twice.
  const author2 = hub.join(T)
  hub.subscribe(author2.channelId, () => {})
  await tick()
  hub.send(author2.channelId, 'noone', desc) // same bytes again
  const v2 = joinAndCollect(hub, T)
  await tick()
  ok(v2.msgs.filter((m) => m === desc).length === 1, 're-announcing an identical descriptor is deduped (cached once)')

  // 4. A distinct descriptor is remembered and replayed alongside the first.
  const desc2 = JSON.stringify({ appId: 'b'.repeat(64), sig: 'cafe' })
  hub.send(author2.channelId, 'noone', desc2)
  const v3 = joinAndCollect(hub, T)
  await tick()
  ok(v3.msgs.includes(desc) && v3.msgs.includes(desc2), 'a distinct descriptor is remembered and replayed alongside the first')

  console.log('\n— memory core: remembered descriptors survive a restart —')
  const p = os.tmpdir() + '/peerit-discovery-test-' + process.pid + '.json'
  try { fs.unlinkSync(p) } catch {}
  const mk = () => createMemoryCore({ persist: { path: p, intervalMs: 1e9 } }) // explicit flush only

  const c0 = mk()
  const a0 = c0.swarm.join(T)
  c0.swarm.subscribe(a0.channelId, () => {})
  await tick()
  c0.swarm.send(a0.channelId, 'noone', desc) // remembering a descriptor marks the store dirty
  c0.flush()
  ok(fs.existsSync(p), 'a remembered descriptor marks the store dirty so the snapshot is written')

  const c1 = mk() // "restart"
  const rv = joinAndCollect(c1.swarm, T)
  await tick()
  ok(rv.msgs.includes(desc), 'after a restart, a fresh joiner still discovers the outbox (descriptor reloaded from disk)')

  try { fs.unlinkSync(p) } catch {}
  console.log(`\n✅ all ${passed} relay discovery checks passed\n`)
}
main()
