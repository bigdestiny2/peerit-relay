// server.mjs — the public HTTP/SSE surface of the peerit relay. Implements the
// exact /api/* contract that js/pear-api.js (the browser client) speaks, so an
// unmodified peerit web build converges through it. Pure request handler over an
// injected `core` (core-memory for tests/dev, core-hypercore for production) and
// `auth` (token issue/verify) — TLS is terminated by a reverse proxy in front.
//
// What the relay can and cannot do: it stores and serves records, joins peers on
// the swarm, and relays descriptor messages — but it never signs (no /api/identity)
// and every record it returns is re-verified in the browser, so it is an
// untrusted availability provider by construction.

const MAX_BODY = 1 << 20 // 1 MiB per request

function rangeOptsFrom (url) {
  const sp = url.searchParams
  const out = { limit: sp.get('limit') }
  for (const b of ['gt', 'gte', 'lt', 'lte']) { const v = sp.get(b); if (v != null) out[b] = v }
  if (sp.get('reverse')) out.reverse = true
  return out
}

function readBody (req) {
  return new Promise((resolve, reject) => {
    let len = 0
    const chunks = []
    req.on('data', (c) => {
      len += c.length
      if (len > MAX_BODY) { reject(Object.assign(new Error('body too large'), { status: 413 })); req.destroy() }
      else chunks.push(c)
    })
    req.on('end', () => {
      if (!chunks.length) return resolve({})
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))) } catch { reject(Object.assign(new Error('bad json'), { status: 400 })) }
    })
    req.on('error', reject)
  })
}

export function createRelayHandler ({ core, auth, allowOrigin = '*', rateLimit = { windowMs: 60000, max: 1200 }, trustProxy = false } = {}) {
  if (!core || !auth) throw new Error('createRelayHandler requires { core, auth }')
  const buckets = new Map() // ip -> { start, count }

  function overLimit (ip) {
    const now = Date.now()
    let b = buckets.get(ip)
    if (!b || now - b.start > rateLimit.windowMs) { b = { start: now, count: 0 }; buckets.set(ip, b) }
    b.count++
    // Evict only EXPIRED windows when the map is large — never wipe all state
    // (that would let an IP-spoofing flood reset everyone's limit at once).
    if (buckets.size > 50000) for (const [k, v] of buckets) if (now - v.start > rateLimit.windowMs) buckets.delete(k)
    return b.count > rateLimit.max
  }

  function cors (res, req) {
    const origin = allowOrigin === '*' ? '*' : (req.headers.origin && allowOrigin.includes(req.headers.origin) ? req.headers.origin : allowOrigin[0] || '*')
    res.setHeader('access-control-allow-origin', origin)
    res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS')
    res.setHeader('access-control-allow-headers', 'content-type, x-pear-token')
    res.setHeader('access-control-max-age', '86400')
    res.setHeader('vary', 'origin')
  }
  function sendJson (req, res, status, obj) {
    cors(res, req)
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(obj === undefined ? 'null' : JSON.stringify(obj))
  }
  const tokenFrom = (req, url) => req.headers['x-pear-token'] || url.searchParams.get('token')

  function sse (req, res, url) {
    const channelId = url.searchParams.get('channelId')
    cors(res, req)
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
    res.write(': ok\n\n')
    const unsub = core.swarm.subscribe(channelId, (ev) => { try { res.write('data: ' + JSON.stringify(ev) + '\n\n') } catch {} })
    const ping = setInterval(() => { try { res.write(': ping\n\n') } catch {} }, 25000)
    if (ping.unref) ping.unref()
    req.on('close', () => { clearInterval(ping); try { unsub() } catch {} })
  }

  return async function handler (req, res) {
    let url
    try { url = new URL(req.url, 'http://relay.local') } catch { return sendJson(req, res, 400, { error: 'bad url' }) }
    const p = url.pathname

    if (req.method === 'OPTIONS') { cors(res, req); res.writeHead(204); return res.end() }
    if (!p.startsWith('/api/')) return sendJson(req, res, 404, { error: 'not found' })

    // Only believe X-Forwarded-For behind a trusted proxy; otherwise a client
    // spoofs it to dodge per-IP rate limits. Default: the real socket address.
    const ip = (trustProxy && (req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || req.socket.remoteAddress || 'unknown'
    if (overLimit(ip)) return sendJson(req, res, 429, { error: 'rate limited' })

    // Token issuance is the one unauthenticated route.
    if (p === '/api/token' && req.method === 'POST') return sendJson(req, res, 200, { token: auth.issue() })

    if (!auth.verify(tokenFrom(req, url))) return sendJson(req, res, 401, { error: 'missing or invalid token' })

    try {
      if (p === '/api/bridge/status') return sendJson(req, res, 200, { ready: true })
      // Intentionally unimplemented: web clients hold their Ed25519 key locally
      // and must NEVER ask the relay to sign. 410 documents that.
      if (p.startsWith('/api/identity')) return sendJson(req, res, 410, { error: 'identity is browser-local; this relay never signs' })

      // await covers both the synchronous memory core and the async hypercore core
      if (p === '/api/sync/create' && req.method === 'POST') { const b = await readBody(req); return sendJson(req, res, 200, await core.sync.create(b.appId)) }
      if (p === '/api/sync/join' && req.method === 'POST') { const b = await readBody(req); return sendJson(req, res, 200, await core.sync.join(b.appId, b.inviteKey)) }
      if (p === '/api/sync/append' && req.method === 'POST') { const b = await readBody(req); return sendJson(req, res, 200, await core.sync.append(b.appId, b.op)) }
      if (p === '/api/sync/get') return sendJson(req, res, 200, await core.sync.get(url.searchParams.get('appId'), url.searchParams.get('key')))
      if (p === '/api/sync/list') return sendJson(req, res, 200, await core.sync.list(url.searchParams.get('appId'), url.searchParams.get('prefix') || '', { limit: url.searchParams.get('limit') }))
      if (p === '/api/sync/range') return sendJson(req, res, 200, await core.sync.range(url.searchParams.get('appId'), rangeOptsFrom(url)))
      if (p === '/api/sync/count') return sendJson(req, res, 200, await core.sync.count(url.searchParams.get('appId'), url.searchParams.get('prefix') || ''))
      if (p === '/api/sync/status') return sendJson(req, res, 200, await core.sync.status(url.searchParams.get('appId')))

      if (p === '/api/swarm/join' && req.method === 'POST') { const b = await readBody(req); return sendJson(req, res, 200, await core.swarm.join(b.topicHex, b)) }
      if (p === '/api/swarm/send' && req.method === 'POST') { const b = await readBody(req); return sendJson(req, res, 200, await core.swarm.send(b.channelId, b.peerId, b.data)) }
      if (p === '/api/swarm/leave' && req.method === 'POST') { const b = await readBody(req); return sendJson(req, res, 200, await core.swarm.leave(b.channelId)) }
      if (p === '/api/swarm/events' && req.method === 'GET') return sse(req, res, url)

      return sendJson(req, res, 404, { error: 'not found' })
    } catch (e) { return sendJson(req, res, e.status || 500, { error: e.message || 'relay error' }) }
  }
}
