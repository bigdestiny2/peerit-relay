// swarm-hub.mjs — the in-process topic hub that lets browsers connected to ONE
// relay discover each other and exchange peerit's signed outbox descriptors.
// It is the pear.swarm.v1 stand-in for web clients: channels on the same topic
// become mutual peers and `send` routes a message to a specific peer's live SSE
// stream. Used by BOTH cores (core-memory and core-hypercore) — so the
// browser-discovery path is the same code the e2e test already exercises.
//
// Scope: this hub connects browsers attached to the same relay process. Reaching
// PearBrowser-native swarm peers or browsers on OTHER relays (cross-relay
// descriptor gossip over the DHT) is a v2 concern; outbox DATA already crosses
// the DHT via the hyperbee replication in core-hypercore, independent of this.

export function createSwarmHub () {
  const channels = new Map() // channelId -> { topic, onEvent|null, linked:Set }
  let seq = 0

  const deliver = (channelId, event) => {
    const c = channels.get(channelId)
    if (c && c.onEvent) { try { c.onEvent(event) } catch {} }
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
      deliver(peerId, { type: 'message', peerId: channelId, data }) // tag the sender so the recipient can reply
      return { ok: true }
    },
    leave,
    // Attach the live SSE stream; defer peer-linking so the stream is wired first.
    subscribe (channelId, onEvent) {
      const c = channels.get(channelId)
      if (!c) return () => {}
      c.onEvent = onEvent
      setTimeout(() => linkPeers(channelId), 0)
      return () => leave(channelId)
    },
    _channelCount () { return channels.size }
  }
}
