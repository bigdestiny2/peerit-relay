// relay.mjs — peerit relay entry point. Bind behind a TLS-terminating reverse
// proxy (nginx/Caddy) at e.g. wss://relay.peerit.com. See README.md.
//
//   PORT                  listen port (default 8787)
//   PEERIT_RELAY_CORE     'memory' (default, ephemeral) | 'hypercore' (production, joins the DHT)
//   PEERIT_RELAY_ORIGINS  comma-separated CORS allowlist (default '*')
//   PEERIT_RELAY_SECRET   HMAC secret for tokens (share across replicas; random if unset)
//   PEERIT_RELAY_STORAGE  corestore path for the hypercore core (default ./relay-store)

import http from 'node:http'
import { createMemoryCore } from './lib/core-memory.mjs'
import { createRelayHandler } from './lib/server.mjs'
import { createTokenAuth } from './lib/token.mjs'

const PORT = Number(process.env.PORT || 8787)
const CORE = process.env.PEERIT_RELAY_CORE || 'memory'
const ALLOW = process.env.PEERIT_RELAY_ORIGINS ? process.env.PEERIT_RELAY_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean) : '*'

async function makeCore () {
  if (CORE === 'hypercore') {
    const { createHypercoreCore } = await import('./lib/core-hypercore.mjs')
    return createHypercoreCore({ storage: process.env.PEERIT_RELAY_STORAGE || './relay-store' })
  }
  return createMemoryCore()
}

const core = await makeCore()
const auth = createTokenAuth()
const handler = createRelayHandler({ core, auth, allowOrigin: ALLOW, trustProxy: process.env.PEERIT_RELAY_TRUST_PROXY === '1' })
http.createServer(handler).listen(PORT, () => {
  console.log(`[peerit-relay] core=${CORE} origins=${ALLOW === '*' ? '*' : ALLOW.join(',')} listening on :${PORT}`)
})
