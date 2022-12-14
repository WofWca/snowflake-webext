/* global snowflake, log, dbg, debug, Util, Parse, WS */

/**
Represents a single:

   client <-- webrtc --> snowflake <-- websocket --> relay

Every ProxyPair has a Snowflake ID, which is necessary when responding to the
Broker with an WebRTC answer.
*/

class ProxyPair {

  /**
   * @param {DummyRateLimit | BucketRateLimit} rateLimit specifies a rate limit on traffic
   * @param {Config} config
   */
  constructor(rateLimit, config) {
    this.prepareDataChannel = this.prepareDataChannel.bind(this);
    this.connectRelay = this.connectRelay.bind(this);
    this.onClientToRelayMessage = this.onClientToRelayMessage.bind(this);
    this.onRelayToClientMessage = this.onRelayToClientMessage.bind(this);
    this.onError = this.onError.bind(this);
    this.flush = this.flush.bind(this);

    /** @type {string | URL} */
    this.relayURL = config.defaultRelayAddr;
    this.rateLimit = rateLimit;
    this.config = config;
    this.id = Util.genSnowflakeID();
    this.c2rSchedule = [];
    this.r2cSchedule = [];
    this.nowConnected = false;
  }

  /** Prepare a WebRTC PeerConnection and await for an SDP offer. */
  begin() {
    /** @private */
    this.pc = new RTCPeerConnection(this.config.pcConfig);
    // OnDataChannel triggered remotely from the client when connection succeeds.
    this.pc.ondatachannel = ({ channel }) => {
      dbg('Data Channel established...');
      this.prepareDataChannel(channel);
      /** @private */
      this.client = channel;
    };
  }

  /**
   * @param {RTCSessionDescription} offer
   * @param {(answer: RTCSessionDescription) => void} sendAnswer
   * @returns {boolean} `true` on success, `false` on fail.
   */
  receiveWebRTCOffer(offer, sendAnswer) {
    if ('offer' !== offer.type) {
      log('Invalid SDP received -- was not an offer.');
      return false;
    }
    try {
      this.pc.setRemoteDescription(offer);
    } catch (error) {
      log('Invalid SDP message.');
      return false;
    }
    dbg('SDP ' + offer.type + ' successfully received.');

    this.pc.createAnswer()
    .then((sdp) => {
      dbg('webrtc: Answer ready.');
      return this.pc.setLocalDescription(sdp);
    })
    .catch(() => {
      this.close();
      dbg('webrtc: Failed to create or set Answer');
    });

    // Send the answer when ready.
    const onceSendAnswer = () => {
      sendAnswer(this.pc.localDescription);

      this.pc.onicegatheringstatechange = null;
      clearTimeout(this.answerTimeoutId);
    };
    this.pc.onicegatheringstatechange = () => {
      if (this.pc.iceGatheringState === 'complete' && this.pc.connectionState !== 'closed') {
        dbg('Finished gathering ICE candidates.');
        onceSendAnswer();
      }
    };
    if (this.pc.iceGatheringState === 'complete') {
      // This probably never happens as we've `setRemoteDescription` just now,
      // but let's play it safe.
      onceSendAnswer();
    } else {
      this.answerTimeoutId = setTimeout(() => {
        dbg('answerTimeout');
        // ICE gathering is taking a while to complete - send what we got so far.
        if (!this.pc.localDescription) {
          // We don't have anything to send yet. Sigh. The client will probably timeout waiting
          // for us, but let's not bail and just try to wait some more in hope that it won't.
          // Worst case scenario - `datachannelTimeout` callback will run.
          return;
        }
        onceSendAnswer();
      }, this.config.answerTimeout);
    }

    return true;
  }

  /**
   * Given a WebRTC DataChannel, prepare callbacks.
   * @param {RTCDataChannel} channel
   * @private
   */
  prepareDataChannel(channel) {
    channel.onopen = () => {
      log('WebRTC DataChannel opened!');
      snowflake.ui.increaseClients();
      this.nowConnected = true;

      // if we don't receive any keep-alive messages from the client, close the
      // connection
      const onStaleTimeout = () => {
        console.log("Closing stale connection.");
        this.flush();
        this.close();
      };
      this.refreshStaleTimeout = () => {
        clearTimeout(this.messageTimer);
        this.messageTimer = setTimeout(onStaleTimeout, this.config.messageTimeout);
      };
      this.refreshStaleTimeout();

      // This is the point when the WebRTC datachannel is done, so the next step
      // is to establish websocket to the server.
      this.connectRelay();
    };
    channel.onclose = () => {
      log('WebRTC DataChannel closed.');
      snowflake.ui.setStatus('disconnected by webrtc.');
      if (this.nowConnected) {
        snowflake.ui.decreaseClients();
        this.nowConnected = false;
      }
      this.flush();
      this.close();
    };
    channel.onerror = function () {
      log('Data channel error!');
    };
    channel.binaryType = "arraybuffer";
    channel.onmessage = this.onClientToRelayMessage;
  }

  /**
   * Assumes WebRTC datachannel is connected.
   * @private
   */
  connectRelay() {
    dbg('Connecting to relay...');
    // Get a remote IP address from the PeerConnection, if possible. Add it to
    // the WebSocket URL's query string if available.
    // MDN marks remoteDescription as "experimental". However the other two
    // options, currentRemoteDescription and pendingRemoteDescription, which
    // are not marked experimental, were undefined when I tried them in Firefox
    // 52.2.0.
    // https://developer.mozilla.org/en-US/docs/Web/API/RTCPeerConnection/remoteDescription
    const desc = this.pc.remoteDescription;
    const peer_ip = Parse.ipFromSDP(desc!= null ? desc.sdp : undefined);
    const params = [];
    if (peer_ip != null) {
      params.push(["client_ip", peer_ip]);
    }
    const relay = this.relay = WS.makeWebsocket(this.relayURL, params);
    relay.label = 'websocket-relay';
    relay.onopen = () => {
      clearTimeout(this.connectToRelayTimeoutId);
      log(relay.label + ' connected!');
      snowflake.ui.setStatus('connected');
    };
    relay.onclose = () => {
      log(relay.label + ' closed.');
      snowflake.ui.setStatus('disconnected.');
      if (this.nowConnected) {
        snowflake.ui.decreaseClients();
        this.nowConnected = false;
      }
      this.flush();
      this.close();
    };
    relay.onerror = this.onError;
    relay.onmessage = this.onRelayToClientMessage;
    // TODO: Better websocket timeout handling.
    this.connectToRelayTimeoutId = setTimeout((() => {
      log(relay.label + ' timed out connecting.');
      relay.onclose();
    }), 5000);
  }

  /**
   * WebRTC --> websocket
   * @param {MessageEvent} msg
   * @private
   */
  onClientToRelayMessage(msg) {
    this.c2rSchedule.push(msg.data);
    this.flush();

    this.refreshStaleTimeout();
  }

  /**
   * websocket --> WebRTC
   * @param {MessageEvent} event
   * @private
   */
  onRelayToClientMessage(event) {
    this.r2cSchedule.push(event.data);
    this.flush();
  }

  /** @private */
  onError(event) {
    const ws = event.target;
    log(ws.label + ' error.');
    this.close();
  }

  /** Close both WebRTC and websocket. */
  close() {
    if (debug) {
      this.pc.getStats().then(report => {
        let transportStats;
        for (const stat of report.values()) {
          // Also consider 'data-channel'.
          if (stat.type === 'transport') {
            transportStats = stat;
            break;
          }
        }
        if (!transportStats) {
          return;
        }
        function bytesToMBytesStr(numBytes) {
          return (numBytes / 1024 / 1024).toFixed(3);
        }
        log(
          `Connection closed. Traffic (up|down):`
          + ` ${bytesToMBytesStr(transportStats.bytesReceived)} MB|`
          + `${bytesToMBytesStr(transportStats.bytesSent)} MB`
          + `, packets: ${transportStats.packetsReceived}|`
          + `${transportStats.packetsSent}`
        );
      });
    }

    clearTimeout(this.connectToRelayTimeoutId);
    clearTimeout(this.messageTimer);
    clearTimeout(this.answerTimeoutId);
    if (this.webrtcIsReady()) {
      this.client.close();
    }
    if (this.peerConnOpen()) {
      this.pc.close();
    }
    if (this.relayIsReady()) {
      this.relay.close();
    }
    this.onCleanup();
  }

  /**
   * Send as much data in both directions as the rate limit currently allows.
   * @private
   */
  flush() {
    let busy = true;
    while (busy && !this.rateLimit.isLimited()) {
      busy = false;
      // WebRTC --> websocket
      if (this.c2rSchedule.length > 0 && this.relayIsReady() && this.relay.bufferedAmount < this.MAX_BUFFER) {
        const chunk = this.c2rSchedule.shift();
        this.relay.send(chunk);
        this.rateLimit.update(chunk.byteLength);
        busy = true;
      }
      // websocket --> WebRTC
      if (this.r2cSchedule.length > 0 && this.webrtcIsReady() && this.client.bufferedAmount < this.MAX_BUFFER) {
        const chunk = this.r2cSchedule.shift();
        this.client.send(chunk);
        this.rateLimit.update(chunk.byteLength);
        busy = true;
      }
    }

    if (this.flush_timeout_id) {
      clearTimeout(this.flush_timeout_id);
      this.flush_timeout_id = null;
    }
    if (this.r2cSchedule.length > 0 || this.c2rSchedule.length > 0) {
      this.flush_timeout_id = setTimeout(this.flush, this.rateLimit.when() * 1000);
    }
  }

  webrtcIsReady() {
    return null !== this.client && 'open' === this.client.readyState;
  }

  relayIsReady() {
    return (null !== this.relay) && (WebSocket.OPEN === this.relay.readyState);
  }

  peerConnOpen() {
    return (null !== this.pc) && ('closed' !== this.pc.connectionState);
  }

  /**
   * @param {URL | string} relayURL
   */
  setRelayURL(relayURL) {
    this.relayURL = relayURL;
  }

}

ProxyPair.prototype.MAX_BUFFER = 10 * 1024 * 1024;

ProxyPair.prototype.pc = null;
ProxyPair.prototype.client = null; // WebRTC Data channel
ProxyPair.prototype.relay = null; // websocket

ProxyPair.prototype.connectToRelayTimeoutId = 0;
ProxyPair.prototype.messageTimer = 0;
ProxyPair.prototype.answerTimeoutId = 0;
ProxyPair.prototype.flush_timeout_id = null;

ProxyPair.prototype.onCleanup = null;
