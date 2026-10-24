import { assertEquals } from "jsr:@std/assert@1";
import { createRtcChannel } from "../interpreter/rtc-channel.js";

// A send after the peer closed used to throw InvalidStateError inside the
// frame loop, which stopped the race before GGRS could read the silence as
// the peer's disconnection.
Deno.test("a send once the channel has closed is lost, not thrown", () => {
  const sent: Uint8Array[] = [];
  const channel = {
    readyState: "open",
    binaryType: "",
    addEventListener() {},
    send(bytes: Uint8Array) {
      if (this.readyState !== "open") throw new DOMException("closed", "InvalidStateError");
      sent.push(bytes);
    },
    close() {},
  };
  const real = (globalThis as Record<string, unknown>).RTCPeerConnection;
  (globalThis as Record<string, unknown>).RTCPeerConnection = class {
    iceGatheringState = "complete";
    localDescription = { toJSON: () => ({ type: "offer" }) };
    addEventListener() {}
    createDataChannel() {
      return channel;
    }
    createOffer() {
      return Promise.resolve({});
    }
    setLocalDescription() {
      return Promise.resolve();
    }
    close() {}
  };
  try {
    const rtc = createRtcChannel({ initiator: true, iceServers: [], signal: { send() {}, onDescription() {} } });
    rtc.send(Uint8Array.of(1));
    channel.readyState = "closed";
    rtc.send(Uint8Array.of(2));
    assertEquals(sent, [Uint8Array.of(1)]);
  } finally {
    (globalThis as Record<string, unknown>).RTCPeerConnection = real;
  }
});
