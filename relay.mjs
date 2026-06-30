// relay.mjs — peerit relay entry point. Bind behind a TLS-terminating reverse
// proxy (Caddy/nginx) at e.g. https://relay.peerit.site. See README.md + examples/.
//
//   PORT                    listen port (default 8787)
//   HOST                    bind address (default 127.0.0.1 — loopback only, behind a proxy)
//   PEERIT_RELAY_CORE       'memory' (default, ephemeral) | 'hypercore' (production, joins the DHT)
//   PEERIT_RELAY_ORIGINS    comma-separated CORS allowlist (default '*' — SET THIS to https://peerit.site)
//   PEERIT_RELAY_SECRET     HMAC secret for tokens (set + share across replicas; random if unset → tokens reset on restart)
//   PEERIT_RELAY_TRUST_PROXY set to 1 ONLY behind a proxy that sets a trustworthy X-Forwarded-For
//   PEERIT_RELAY_MAX_RATE    per-IP requests/min (default 300)
//   PEERIT_RELAY_SSE_PER_IP  max concurrent event streams per IP (default 8)
//   PEERIT_RELAY_MAX_BYTES   in-memory storage budget in MiB (default 256)
//   PEERIT_RELAY_MAX_GROUPS  max distinct outboxes (default 20000)
//   PEERIT_RELAY_STORAGE     corestore path for the hypercore core (default ./relay-store)

import http from 'node:http'
import { createMemoryCore } from './lib/core-memory.mjs'
import { createRelayHandler } from './lib/server.mjs'
import { createTokenAuth } from './lib/token.mjs'

const intEnv = (name, dflt) => { const n = Number(process.env[name]); return Number.isFinite(n) && n > 0 ? n : dflt }
const PORT = intEnv('PORT', 8787)
const HOST = process.env.HOST || '127.0.0.1'
const CORE = process.env.PEERIT_RELAY_CORE || 'memory'
const ALLOW = process.env.PEERIT_RELAY_ORIGINS ? process.env.PEERIT_RELAY_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean) : '*'

// Crash-safety: a public, unattended relay must not die silently. Log + exit on a
// fatal error so the process manager (systemd Restart=always) brings it back.
process.on('uncaughtException', (e) => { console.error('[peerit-relay] uncaughtException:', e && e.stack || e); process.exit(1) })
process.on('unhandledRejection', (e) => { console.error('[peerit-relay] unhandledRejection:', e && e.stack || e) })

if (!process.env.PEERIT_RELAY_SECRET) console.warn('[peerit-relay] WARNING: PEERIT_RELAY_SECRET unset — tokens reset on every restart (all testers logged out). Set a fixed secret in production.')
if (ALLOW === '*' && process.env.NODE_ENV === 'production') console.warn('[peerit-relay] WARNING: PEERIT_RELAY_ORIGINS unset (CORS *) — set it to your site origin (e.g. https://peerit.site).')

async function makeCore () {
  if (CORE === 'hypercore') {
    const { createHypercoreCore } = await import('./lib/core-hypercore.mjs')
    return createHypercoreCore({ storage: process.env.PEERIT_RELAY_STORAGE || './relay-store' })
  }
  return createMemoryCore({
    maxTotalBytes: intEnv('PEERIT_RELAY_MAX_BYTES', 256) * 1024 * 1024,
    maxGroups: intEnv('PEERIT_RELAY_MAX_GROUPS', 20000)
  })
}

const core = await makeCore()
const auth = createTokenAuth()
const handler = createRelayHandler({
  core,
  auth,
  allowOrigin: ALLOW,
  trustProxy: process.env.PEERIT_RELAY_TRUST_PROXY === '1',
  rateLimit: { windowMs: 60000, max: intEnv('PEERIT_RELAY_MAX_RATE', 300) },
  sseMaxPerIp: intEnv('PEERIT_RELAY_SSE_PER_IP', 8)
})

const server = http.createServer(handler)
server.on('error', (e) => { console.error('[peerit-relay] server error:', e && e.message); process.exit(1) })
server.requestTimeout = 30000 // drop slowloris-style stalled requests
server.headersTimeout = 20000
server.listen(PORT, HOST, () => {
  console.log(`[peerit-relay] core=${CORE} origins=${ALLOW === '*' ? '*' : ALLOW.join(',')} rate=${intEnv('PEERIT_RELAY_MAX_RATE', 300)}/min listening on ${HOST}:${PORT}`)
})
