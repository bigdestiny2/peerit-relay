// token.mjs — first-visit access tokens for the relay.
//
// Stateless HMAC tokens: payload.signature, where signature = HMAC-SHA256(secret,
// payload). No server-side session store, so it scales across relay replicas as
// long as they share PEERIT_RELAY_SECRET. The token is NOT a secret credential —
// anyone can request one — it only scopes rate-limiting and proves the holder
// asked the relay for access. Authenticity of CONTENT is the Ed25519 signature
// inside each record (verified in the browser), never the token.

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

export function createTokenAuth ({ secret, ttlMs = 7 * 24 * 60 * 60 * 1000 } = {}) {
  secret = secret || process.env.PEERIT_RELAY_SECRET || randomBytes(32).toString('hex')
  const sign = (payload) => createHmac('sha256', secret).update(payload).digest('base64url')

  function issue () {
    const payload = Buffer.from(JSON.stringify({ iat: Date.now(), n: randomBytes(6).toString('hex') })).toString('base64url')
    return payload + '.' + sign(payload)
  }

  function verify (token) {
    if (typeof token !== 'string' || token.length < 8 || token.length > 4096) return false
    const i = token.lastIndexOf('.')
    if (i <= 0) return false
    const payload = token.slice(0, i)
    const sig = token.slice(i + 1)
    const expect = sign(payload)
    if (sig.length !== expect.length) return false
    try { if (!timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return false } catch { return false }
    try {
      const { iat } = JSON.parse(Buffer.from(payload, 'base64url').toString())
      return typeof iat === 'number' && (Date.now() - iat) < ttlMs && (Date.now() - iat) > -60000
    } catch { return false }
  }

  return { issue, verify }
}
