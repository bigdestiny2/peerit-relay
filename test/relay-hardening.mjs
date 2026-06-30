// relay-hardening.mjs — verifies the open-internet abuse limits so a public relay
// degrades gracefully (429/503) under a flood instead of OOM-ing or exhausting
// file descriptors. Run: node test/relay-hardening.mjs

import assert from 'node:assert'
import http from 'node:http'
import { createMemoryCore } from '../lib/core-memory.mjs'
import { createRelayHandler } from '../lib/server.mjs'
import { createTokenAuth } from '../lib/token.mjs'

let passed = 0
const ok = (c, m) => { assert.ok(c, m); passed++; console.log('  ✓ ' + m) }
function throwsStatus (fn, status, m) {
  try { fn(); ok(false, m + ' (did not throw)') } catch (e) { ok(e.status === status, m + ' → ' + (e.status || e.message)) }
}
const A = 'a'.repeat(64), B = 'b'.repeat(64)
const rec = (id, extra = {}) => ({ type: 'post', data: { id, cid: id, community: 'x', title: 't', ...extra } })

async function main () {
  console.log('\n— memory core: abuse caps —')
  const c1 = createMemoryCore({ maxGroups: 2 })
  c1.sync.create('g1'); c1.sync.create('g2')
  throwsStatus(() => c1.sync.create('g3'), 503, 'create beyond maxGroups is rejected (503)')

  const c2 = createMemoryCore()
  c2.sync.get('nope', 'k'); c2.sync.list('nope', ''); c2.sync.status('zzz'); c2.sync.count('qqq')
  ok(c2._stats().groups === 0, 'reads on unknown appIds do NOT create groups (read-spam is harmless)')
  throwsStatus(() => c2.sync.join('nope', 'inv'), 404, 'join on a non-existent outbox is 404 (no group created)')
  ok(c2._stats().groups === 0, 'a failed join did not create a group')
  throwsStatus(() => c2.sync.append(A, rec('x'.repeat(300))), 400, 'over-long record id is rejected (400)')
  throwsStatus(() => c2.sync.append(A, rec('big', { body: 'z'.repeat(70000) })), 413, 'over-size record is rejected (413)')
  throwsStatus(() => c2.sync.append('z'.repeat(200), rec('c')), 400, 'over-long appId is rejected (400)')

  const c3 = createMemoryCore({ maxRowsPerGroup: 2 })
  c3.sync.append(A, rec('r1')); c3.sync.append(A, rec('r2'))
  throwsStatus(() => c3.sync.append(A, rec('r3')), 503, 'append beyond maxRowsPerGroup is rejected (503)')
  c3.sync.append(A, rec('r1', { title: 'edit' }))
  ok(c3.sync.status(A).viewLength === 2, 'overwriting an existing key stays allowed under the row cap')

  const c4 = createMemoryCore({ maxTotalBytes: 2000 })
  c4.sync.append(A, rec('a', { body: 'x'.repeat(800) }))
  throwsStatus(() => c4.sync.append(B, rec('b', { body: 'y'.repeat(1500) })), 503, 'append beyond the global byte budget is rejected (503)')

  console.log('\n— server: per-IP rate limit —')
  const server = http.createServer(createRelayHandler({ core: createMemoryCore(), auth: createTokenAuth({ secret: 's' }), rateLimit: { windowMs: 60000, max: 3 } }))
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const base = 'http://127.0.0.1:' + server.address().port
  const codes = []
  for (let i = 0; i < 5; i++) codes.push((await fetch(base + '/api/token', { method: 'POST' })).status)
  ok(codes.slice(0, 3).every((c) => c === 200) && codes[3] === 429, 'first 3 requests ok, 4th is rate-limited 429 [' + codes.join(',') + ']')

  console.log('\n— server: SSE concurrency cap —')
  const srv2 = http.createServer(createRelayHandler({ core: createMemoryCore(), auth: createTokenAuth({ secret: 's' }), rateLimit: { windowMs: 60000, max: 1000 }, sseMaxPerIp: 1 }))
  await new Promise((r) => srv2.listen(0, '127.0.0.1', r))
  const b2 = 'http://127.0.0.1:' + srv2.address().port
  const tok = (await (await fetch(b2 + '/api/token', { method: 'POST' })).json()).token
  const ch = (await (await fetch(b2 + '/api/swarm/join', { method: 'POST', headers: { 'content-type': 'application/json', 'x-pear-token': tok }, body: JSON.stringify({ topicHex: 't'.repeat(64) }) })).json()).channelId
  let openSse
  const first = await new Promise((resolve) => { openSse = http.get(`${b2}/api/swarm/events?channelId=${ch}&token=${tok}`, (res) => resolve(res.statusCode)); openSse.on('error', () => resolve(0)) })
  ok(first === 200, 'first SSE stream opens (200)')
  await new Promise((r) => setTimeout(r, 60))
  ok((await fetch(`${b2}/api/swarm/events?channelId=${ch}&token=${tok}`)).status === 429, 'second concurrent SSE stream from the same IP is rejected (429)')
  try { openSse.destroy() } catch {}

  await new Promise((r) => server.close(r))
  await new Promise((r) => srv2.close(r))
  console.log(`\n✅ all ${passed} relay hardening checks passed\n`)
  process.exit(0)
}

main().catch((e) => { console.error('\n❌ FAILED:', e.message, '\n', e.stack); process.exit(1) })
