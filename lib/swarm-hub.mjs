// swarm-hub.mjs — the in-process topic hub that lets browsers connected to ONE
// relay discover each other and exchange peerit's signed outbox descriptors.
// It is the pear.swarm.v1 stand-in for web clients: channels on the same topic
// become mutual peers and `send` routes a message to a specific peer's live SSE
// stream. Used by BOTH cores (core-memory and core-hypercore).
//
// DURABILITY: the hub also REMEMBERS every distinct signed descriptor it relays
// (keyed by content, so re-announces dedupe) and REPLAYS them to each new joiner
// as synthetic peer+message events. That way a visitor discovers an outbox even
// when its author is offline — the relay+disk becomes a self-sufficient
// availability provider, no always-on seeder required. The relay CANNOT forge
// descriptors: each carries the author's Ed25519 signature, which every client
// re-verifies before joining, so re-broadcasting stored ones is safe.
//
// Scope: this hub connects browsers attached to the same relay process. Reaching
// PearBrowser-native peers or browsers on OTHER relays (cross-relay descriptor
// gossip over the DHT) is a v2 concern.

export function createSwarmHub ({ maxDescriptorsPerTopic = 20000, onChange = null } = {}) {
  const channels = new Map()     // channelId -> { topic, onEvent|null, linked:Set }
  const descriptors = new Map()  // topic -> Map(dataStr -> dataStr)  distinct signed descriptors
  let seq = 0
  let synth = 0

  const deliver = (channelId, event) => {
    const c = channels.get(channelId)
    if (c && c.onEvent) { try { c.onEvent(event) } catch {} }
  }

  const remember = (topic, data) => {
    if (typeof data !== 'string' || !data || data.length > 16384) return
    let m = descriptors.get(topic)
    if (!m) { m = new Map(); descriptors.set(topic, m) }
    if (m.has(data)) return
    if (m.size >= maxDescriptorsPerTopic) return
    m.set(data, data)
    if (onChange) { try { onChange() } catch {} } // a new descriptor → mark the store dirty for the disk snapshot
  }

  // Replay every remembered descriptor for this channel's topic as a synthetic
  // peer + its message, so a fresh joiner discovers outboxes whose authors are
  // gone. The synthetic peerId never maps to a channel, so replies to it no-op.
  const replay = (channelId) => {
    const c = channels.get(channelId)
    if (!c || !c.onEvent) return
    const m = descriptors.get(c.topic)
    if (!m) return
    for (const data of m.keys()) {
      const pid = 'cache-' + (++synth)
      deliver(channelId, { type: 'peer', peerId: pid, pubkey: null })
      deliver(channelId, { type: 'message', peerId: pid, data })
    }
  }

  const linkPeers = (channelId) => {
    const c = channels.get(channelId)
    if (!c || !c.onEvent) return
    for (const [otherId, other] of channels) {
      if (otherId === channelId || other.topic !== c.topic || !other.onEvent) continue
      if (c.linked.has(otherId)) continue
      c.linked.add(otherId); other.linked.add(channelId)
      deliver(channelId, { type: 'peer', peerId: otherId, pubkey: null })
      deliver(otherId, { type: 'peer', peerId: channelId, pubkey: null })
    }
  }

  const leave = (channelId) => {
    const c = channels.get(channelId)
    if (c) for (const otherId of c.linked) { const o = channels.get(otherId); if (o) { o.linked.delete(channelId); deliver(otherId, { type: 'peer-leave', peerId: channelId }) } }
    channels.delete(channelId)
    return { ok: true }
  }

  return {
    join (topicHex, opts = {}) {
      const channelId = 'ch-' + (++seq)
      channels.set(channelId, { topic: topicHex || 'default', onEvent: null, linked: new Set() })
      return { channelId, topicHex: topicHex || 'default', protocol: opts.protocol || 'pear.swarm.v1', version: opts.version == null ? 1 : opts.version, tier: 'A' }
    },
    send (channelId, peerId, data) {
      const c = channels.get(channelId)
      if (c) remember(c.topic, data) // persist the signed descriptor for future joiners
      deliver(peerId, { type: 'message', peerId: channelId, data }) // tag the sender so the recipient can reply
      return { ok: true }
    },
    leave,
    // Attach the live SSE stream; defer peer-linking + descriptor replay so the
    // stream is wired first.
    subscribe (channelId, onEvent) {
      const c = channels.get(channelId)
      if (!c) return () => {}
      c.onEvent = onEvent
      setTimeout(() => { linkPeers(channelId); replay(channelId) }, 0)
      return () => leave(channelId)
    },
    _channelCount () { return channels.size },
    // Persistence hooks — the memory core includes these in its disk snapshot so
    // discoverability (not just data) survives a restart.
    _snapshotDescriptors () { const o = {}; for (const [t, m] of descriptors) o[t] = [...m.keys()]; return o },
    _loadDescriptors (obj) {
      if (!obj || typeof obj !== 'object') return
      for (const t of Object.keys(obj)) {
        const arr = obj[t]
        if (!Array.isArray(arr)) continue
        const m = new Map()
        for (const d of arr) if (typeof d === 'string' && d.length <= 16384 && m.size < maxDescriptorsPerTopic) m.set(d, d)
        descriptors.set(t, m)
      }
    }
  }
}
