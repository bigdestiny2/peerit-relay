# peerit-relay

A public, **untrusted** availability relay that lets a normal browser (no
PearBrowser) reach peerit's P2P network. It speaks the exact `/api/*` contract
that peerit's browser client (`02-apps/peerit/js/pear-api.js`) already uses, so
an unmodified peerit web build runs in `gossip-bridge` mode through it.

## Why it's safe to run an untrusted relay

The relay **holds no signing keys and never signs.** Web clients mint and keep
their Ed25519 key in the browser (`forceDev` → SubtleCrypto), and every record
is re-verified client-side at merge. So the relay can **withhold or reorder**
data, but it can **never forge, tamper, or impersonate** — `/api/identity` is
deliberately disabled (returns 410). Censoring or seizing a relay is a
*liveness* attack, not an *integrity* one; run several and let clients fail over.

## Run it

```sh
# dev / CI / small single-relay deployment — ephemeral, no dependencies
npm start                      # PEERIT_RELAY_CORE=memory on :8787

# production — replicates outboxes over the Hyperswarm DHT
npm i corestore hyperbee hyperswarm b4a
npm run start:prod             # PEERIT_RELAY_CORE=hypercore

npm test                       # end-to-end: two web clients converge over real HTTP
```

### Environment
| var | default | meaning |
|---|---|---|
| `PORT` | `8787` | listen port (put TLS in front) |
| `PEERIT_RELAY_CORE` | `memory` | `memory` (ephemeral) or `hypercore` (DHT-replicated) |
| `PEERIT_RELAY_ORIGINS` | `*` | comma-separated CORS allowlist, e.g. `https://peerit.com` |
| `PEERIT_RELAY_SECRET` | random | HMAC token secret — set + share across replicas |
| `PEERIT_RELAY_STORAGE` | `./relay-store` | corestore path (hypercore core) |
| `PEERIT_RELAY_TRUST_PROXY` | unset | set to `1` ONLY behind a proxy that sets a trustworthy `X-Forwarded-For`; otherwise per-IP rate-limiting uses the socket address (clients can't spoof it) |

## Deploy checklist (operator)

1. **TLS + DNS:** terminate TLS at nginx/Caddy in front of the relay; point
   `relay.peerit.com` at it. Browsers reach it over `https://`/`wss://`.
2. **Origins:** set `PEERIT_RELAY_ORIGINS=https://peerit.com` (+ mirrors).
3. **Secret:** set a fixed `PEERIT_RELAY_SECRET` (and the same on every replica).
4. **Production core:** `npm i` the optional deps, run `start:prod`. Validate on
   a live network (see the caveats in `lib/core-hypercore.mjs`) before relying on it.
5. **Durability:** run `02-apps/peerit-seeder` so outboxes stay available when no
   browser is online; relays are availability providers, not the source of truth.
6. **Point the app at it:** add to the peerit web export's `index.html`:
   ```html
   <meta name="peerit-relay" content="https://relay.peerit.com">
   <!-- omit peerit-relay-readonly, or set "false", to allow writes -->
   ```
   This `<meta>` is ignored by PearBrowser (it uses the injected `window.pear`),
   so it never changes the native P2P experience.
7. **Run more than one.** A single relay is a liveness chokepoint. Publish a
   signed roster and let clients fail over (peerit Phase 2).

## Architecture

```
browser (keys + verify)  ──HTTP/SSE──►  relay (this)  ──Hyperswarm──►  seeders · PearBrowser peers · other relays
        signs locally                 untrusted pipe                   the real P2P network
```

- `lib/server.mjs` — the `/api/*` HTTP+SSE surface (token auth, CORS, rate limit).
- `lib/core-memory.mjs` — in-memory sync + swarm (CI-proven contract reference).
- `lib/core-hypercore.mjs` — DHT-replicated sync (production; reference impl).
- `lib/swarm-hub.mjs` — in-process topic hub for browser↔browser descriptor discovery (shared by both cores).
- `lib/token.mjs` — stateless HMAC first-visit tokens.
