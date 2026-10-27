// A data channel to one peer, for a rollback session's bytes
// (kinetic-session.js): unordered and never retransmitted, the datagram
// GGRS's protocol is written for, which resends what it still needs itself.
//
// `signal` carries the two descriptions between the peers —
// `{send(description), onDescription(handler)}` — and is the caller's: a
// duel machine's rows, a test's hand. Each side sends its description once
// its ICE gathering completes, so it carries every candidate and nothing
// trickles after it. `iceServers` is the terminal config's, which the
// release target writes (pronto's release-targets.md, ICE servers): empty, a
// peer offers its host candidates only, which joins two tabs on one machine or
// two machines on one network and not two homes.
export function createRtcChannel({ initiator, signal, iceServers }) {
  if (!Array.isArray(iceServers)) throw new TypeError(`rtc: iceServers is ${JSON.stringify(iceServers)}, not a list of RTCIceServer`);
  const peer = new RTCPeerConnection({ iceServers });
  const handlers = [];
  let channel = null;
  const attach = (opened) => {
    channel = opened;
    channel.binaryType = "arraybuffer";
    channel.addEventListener("message", ({ data }) => {
      for (const handler of handlers) handler(new Uint8Array(data));
    });
  };
  const gathered = () => new Promise((resolve) => {
    if (peer.iceGatheringState === "complete") return resolve();
    let timer = null;
    let maxTimer = null;
    const finish = () => {
      clearTimeout(timer);
      clearTimeout(maxTimer);
      resolve();
    };
    peer.addEventListener("icegatheringstatechange", () => {
      if (peer.iceGatheringState === "complete") finish();
    });
    peer.addEventListener("icecandidate", ({ candidate }) => {
      if (!candidate) return finish();
      clearTimeout(timer);
      const isRelay = typeof candidate.candidate === "string" && candidate.candidate.includes("typ relay");
      timer = setTimeout(finish, isRelay ? 1000 : 3000);
    });
    maxTimer = setTimeout(finish, 6000);
  });
  const open = new Promise((resolve, reject) => {
    peer.addEventListener("connectionstatechange", () => {
      if (peer.connectionState === "failed") reject(new Error("rtc: the connection to the peer failed"));
    });
    const opened = (dc) => dc.addEventListener("open", () => resolve(), { once: true });
    if (initiator) {
      const dc = peer.createDataChannel("rollback", { ordered: false, maxRetransmits: 0 });
      attach(dc);
      opened(dc);
    } else {
      peer.addEventListener("datachannel", ({ channel: dc }) => {
        attach(dc);
        opened(dc);
      });
    }
  });

  // A signal may say a description again (a peer that joined late asks);
  // the first is the one the connection is made from.
  let described = false;
  signal.onDescription(async (description) => {
    if (described) return;
    described = true;
    await peer.setRemoteDescription(description);
    if (initiator) return;
    await peer.setLocalDescription(await peer.createAnswer());
    await gathered();
    signal.send(peer.localDescription.toJSON());
  });
  if (initiator) {
    (async () => {
      await peer.setLocalDescription(await peer.createOffer());
      await gathered();
      signal.send(peer.localDescription.toJSON());
    })();
  }

  return {
    /** Resolves once the channel is open. */
    open,
    /** A datagram, lost once the peer's side has closed: GGRS reads the
     * silence as the peer's disconnection, which a throw here would preempt. */
    send(bytes) {
      if (channel.readyState === "open") channel.send(bytes);
    },
    onMessage(handler) {
      handlers.push(handler);
    },
    close() {
      channel?.close();
      peer.close();
    },
  };
}
