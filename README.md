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

npm run roster:sign -- --generate-key
PEERIT_ROSTER_SEED=<seed> npm run roster:sign -- \
  --relay https://relay-a.peerit.com --relay https://relay-b.peerit.com

npm test                       # end-to-end: two web clients converge over real HTTP
```

### Environment
| var | default | meaning |
|---|---|---|
| `PORT` | `8787` | listen port (put TLS in front) |
| `HOST` | `127.0.0.1` | bind address — loopback only by default, so the relay is reachable only through the reverse proxy. Set `0.0.0.0` only if you deliberately expose it. |
| `PEERIT_RELAY_CORE` | `memory` | `memory` (ephemeral) or `hypercore` (DHT-replicated) |
| `PEERIT_RELAY_ORIGINS` | `*` | comma-separated CORS allowlist, e.g. `https://peerit.site` |
| `PEERIT_RELAY_SECRET` | random | HMAC token secret — set + share across replicas |
| `PEERIT_RELAY_STORAGE` | `./relay-store` | corestore path (hypercore core) |
| `PEERIT_RELAY_TRUST_PROXY` | unset | set to `1` ONLY behind a proxy that sets a trustworthy `X-Forwarded-For`; otherwise per-IP rate-limiting uses the socket address (clients can't spoof it) |
| `PEERIT_RELAY_MAX_RATE` | `300` | per-IP requests/minute before `429` |
| `PEERIT_RELAY_SSE_PER_IP` | `8` | max concurrent event streams per IP before `429` (total cap 2000) |
| `PEERIT_RELAY_MAX_BYTES` | `256` | in-memory record budget in MiB before `503` (memory core) |
| `PEERIT_RELAY_MAX_GROUPS` | `20000` | max distinct outboxes before `503` (memory core) |
| `PEERIT_RELAY_PERSIST` | unset | path on a **persistent disk** to snapshot the memory store to, so a restart/redeploy reloads content instead of wiping it (memory core). Unset = ephemeral. |
| `PEERIT_ROSTER_SEED` | unset | 64-hex Ed25519 seed used only by `npm run roster:sign`; keep it offline |
| `PEERIT_RELAY_ROSTER_RELAYS` | unset | comma-separated relay URLs for `npm run roster:sign` |
| `PEERIT_ROSTER_EXPIRES` | 30 days from now | ISO timestamp for the signed roster expiry |

## Signed relay roster

The relay does not sign user content and does not need this key at runtime. Use
`scripts/sign-roster.mjs` offline to publish the relay fleet as a signed JSON
file that the web client verifies against a public key pinned into the audited
web bundle:

```sh
npm run roster:sign -- --generate-key
PEERIT_ROSTER_SEED=<seed from offline key storage> npm run roster:sign -- \
  --relay https://relay-a.peerit.com --relay https://relay-b.peerit.com \
  --expires 2026-12-31T00:00:00.000Z --out ../peerit/relay-roster.json
```

Then build the web bundle with:

```sh
cd ../peerit
node build-web.mjs --relay https://relay-a.peerit.com \
  --relay-roster relay-roster.json --relay-roster-key <publicKey>
```

Format:

```json
{
  "payload": {
    "version": 1,
    "expires": "2026-12-31T00:00:00.000Z",
    "relays": ["https://relay-a.peerit.com", "https://relay-b.peerit.com"]
  },
  "signature": { "alg": "Ed25519", "key": "<publicKey>", "sig": "<signature>" }
}
```

Clients verify the key, signature, and expiry, then try relays in roster order
until one issues a token. If the roster is missing or invalid, they fall back to
the static `peerit-relay` meta list.

## Hardening / abuse limits

A public relay is an open endpoint, so it must degrade gracefully under a flood
instead of OOM-ing or running out of file descriptors. The defaults are safe;
tune them via the env vars above. All of these are covered by
`npm run test:hardening`.

- **Bounded memory (memory core).** Records are capped per outbox
  (`maxRowsPerGroup`), per record (64 KiB → `413`), by number of outboxes
  (`PEERIT_RELAY_MAX_GROUPS` → `503`), and by a **global byte budget**
  (`PEERIT_RELAY_MAX_BYTES` → `503`) — the real bound on heap. Reads never create
  an outbox, so read-spam with random ids can't grow the map; `join` on an
  unknown outbox is `404`, not a silent create.
- **Per-IP rate limit.** `PEERIT_RELAY_MAX_RATE`/min, including token issuance, so
  a single IP can't mint tokens or hammer the API unbounded (`429`). Behind a
  proxy, set `PEERIT_RELAY_TRUST_PROXY=1` so the limiter sees the real client IP;
  without it a spoofed `X-Forwarded-For` is ignored and the socket address is used.
- **SSE concurrency cap.** Long-lived event streams are capped per IP
  (`PEERIT_RELAY_SSE_PER_IP`, default 8) and in total (2000), so streams can't
  exhaust file descriptors (`429` over the cap).
- **Slowloris + crash safety.** `requestTimeout`/`headersTimeout` drop stalled
  requests; `uncaughtException`/`server error` log and exit so the process
  manager restarts a wedged relay (see the systemd unit).
- **Bind + firewall.** The relay binds `127.0.0.1` by default — only the reverse
  proxy reaches it. Keep `:8787` off the public internet:
  ```sh
  sudo ufw allow 22,80,443/tcp && sudo ufw deny 8787/tcp && sudo ufw enable
  ```
- **Memory backstop.** Run under systemd with `MemoryMax` set comfortably above
  `PEERIT_RELAY_MAX_BYTES` (see `examples/peerit-relay.service`) so a runaway is
  reaped by the kernel and restarted, not left to hurt the host.

## Deploy checklist (operator)

Ready-to-edit configs live in [`examples/`](examples): `Caddyfile` (TLS + same-origin
`/api` proxy with SSE flushing), `peerit-relay.service` (systemd: `Restart=always`,
`MemoryMax`, sandboxing), and `.env.example` (every var with prod-safe values).

1. **TLS + DNS:** terminate TLS at Caddy/nginx in front of the relay (see
   `examples/Caddyfile`); point `relay.peerit.site` at it. The relay itself binds
   loopback (`HOST=127.0.0.1`); only the proxy is public.
2. **Origins:** set `PEERIT_RELAY_ORIGINS=https://peerit.site` (+ mirrors) — never
   leave CORS at `*` in production.
3. **Secret:** set a fixed `PEERIT_RELAY_SECRET` (`openssl rand -hex 32`), the same
   on every replica, so tokens survive restarts and replica failover.
4. **Trust proxy + limits:** set `PEERIT_RELAY_TRUST_PROXY=1` (because the proxy
   sets `X-Forwarded-For`) and review the abuse limits above for your box.
5. **Firewall:** allow `22/80/443`, deny the relay port (`8787`) from the internet.
6. **Service:** run under systemd (`examples/peerit-relay.service`) with
   `Restart=always` and `MemoryMax`; install `examples/.env.example` as
   `/etc/peerit-relay.env`.
7. **Production core:** `npm i` the optional deps, run `start:prod`. Validate on
   a live network (see the caveats in `lib/core-hypercore.mjs`) before relying on it.
8. **Durability:** run `02-apps/peerit-seeder` so outboxes stay available when no
   browser is online; relays are availability providers, not the source of truth.
9. **Point the app at it:** add to the peerit web export's `index.html`:
   ```html
   <meta name="peerit-relay" content="https://relay.peerit.site">
   <meta name="peerit-relay-roster" content="relay-roster.json">
   <meta name="peerit-relay-roster-key" content="<publicKey>">
   <!-- omit peerit-relay-readonly, or set "false", to allow writes -->
   ```
   This `<meta>` is ignored by PearBrowser (it uses the injected `window.pear`),
   so it never changes the native P2P experience.
10. **Run more than one.** A single relay is a liveness chokepoint. Publish a
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
