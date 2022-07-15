/* global snowflake, log, dbg, Util, Parse, WS */

/**
Represents a single:

   client <-- webrtc --> snowflake <-- websocket --> relay

Every ProxyPair has a Snowflake ID, which is necessary when responding to the
Broker with an WebRTC answer.
*/

class ProxyPair {

  /**
   * @param relayAddr the destination relay
   * @param {*} rateLimit specifies a rate limit on traffic
   * @param {Config} config
   */
  constructor(relayAddr, rateLimit, config) {
    this.prepareDataChannel = this.prepareDataChannel.bind(this);
    this.connectRelay = this.connectRelay.bind(this);
    this.onClientToRelayMessage = this.onClientToRelayMessage.bind(this);
    this.onRelayToClientMessage = this.onRelayToClientMessage.bind(this);
    this.onError = this.onError.bind(this);
    this.flush = this.flush.bind(this);

    /** @type {string | undefined} */
    this.relayURL = undefined;
    this.relayAddr = relayAddr;
    this.rateLimit = rateLimit;
    this.config = config;
    this.pcConfig = config.pcConfig;
    this.id = Util.genSnowflakeID();
    this.c2rSchedule = [];
    this.r2cSchedule = [];
    this.counted = false;
  }

  /** Prepare a WebRTC PeerConnection and await for an SDP offer. */
  begin() {
    this.pc = new RTCPeerConnection(this.pcConfig);
    this.pc.onicecandidate = (evt) => {
      // Browser sends a null candidate once the ICE gathering completes.
      if (null === evt.candidate && this.pc.connectionState !== 'closed') {
        dbg('Finished gathering ICE candidates.');
        snowflake.broker.sendAnswer(this.id, this.pc.localDescription);
      }
    };
    // OnDataChannel triggered remotely from the client when connection succeeds.
    this.pc.ondatachannel = (dc) => {
      const channel = dc.channel;
      dbg('Data Channel established...');
      this.prepareDataChannel(channel);
      this.client = channel;
    };
  }

  /**
   * @param {RTCSessionDescription} offer
   * @returns {boolean} `true` on success, `false` on fail.
   */
  receiveWebRTCOffer(offer) {
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
    return true;
  }

  /**
   * Given a WebRTC DataChannel, prepare callbacks.
   * @param {RTCDataChannel} channel
   */
  prepareDataChannel(channel) {
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

    channel.onopen = () => {
      log('WebRTC DataChannel opened!');
      snowflake.ui.increaseClients();
      this.counted = true;

      this.refreshStaleTimeout();

      // This is the point when the WebRTC datachannel is done, so the next step
      // is to establish websocket to the server.
      this.connectRelay();
    };
    channel.onclose = () => {
      log('WebRTC DataChannel closed.');
      snowflake.ui.setStatus('disconnected by webrtc.');
      if (this.counted) {
        snowflake.ui.decreaseClients();
        this.counted = false;
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

  /** Assumes WebRTC datachannel is connected. */
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
    const relay = this.relay =
      (this.relayURL === undefined) ?
        WS.makeWebsocket(this.relayAddr, params) :
        WS.makeWebsocketFromURL(this.relayURL, params);
    this.relay.label = 'websocket-relay';
    this.relay.onopen = () => {
      clearTimeout(this.connectToRelayTimeoutId);
      log(relay.label + ' connected!');
      snowflake.ui.setStatus('connected');
    };
    this.relay.onclose = () => {
      log(relay.label + ' closed.');
      snowflake.ui.setStatus('disconnected.');
      if (this.counted) {
        snowflake.ui.decreaseClients();
        this.counted = false;
      }
      this.flush();
      this.close();
    };
    this.relay.onerror = this.onError;
    this.relay.onmessage = this.onRelayToClientMessage;
    // TODO: Better websocket timeout handling.
    this.connectToRelayTimeoutId = setTimeout((() => {
      log(relay.label + ' timed out connecting.');
      relay.onclose();
    }), 5000);
  }

  /**
   * WebRTC --> websocket
   * @param {MessageEvent} msg
   */
  onClientToRelayMessage(msg) {
    dbg('WebRTC --> websocket data: ' + msg.data.byteLength + ' bytes');
    this.c2rSchedule.push(msg.data);
    this.flush();

    this.refreshStaleTimeout();
  }

  /**
   * websocket --> WebRTC
   * @param {MessageEvent} event
   */
  onRelayToClientMessage(event) {
    dbg('websocket --> WebRTC data: ' + event.data.byteLength + ' bytes');
    this.r2cSchedule.push(event.data);
    this.flush();
  }

  onError(event) {
    const ws = event.target;
    log(ws.label + ' error.');
    this.close();
  }

  /** Close both WebRTC and websocket. */
  close() {
    clearTimeout(this.connectToRelayTimeoutId);
    clearTimeout(this.messageTimer);
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

  /** Send as much data in both directions as the rate limit currently allows. */
  flush() {
    if (this.flush_timeout_id) {
      clearTimeout(this.flush_timeout_id);
    }
    this.flush_timeout_id = null;
    let busy = true;
    const checkChunks = () => {
      busy = false;
      // WebRTC --> websocket
      if (this.relayIsReady() && this.relay.bufferedAmount < this.MAX_BUFFER && this.c2rSchedule.length > 0) {
        const chunk = this.c2rSchedule.shift();
        this.rateLimit.update(chunk.byteLength);
        this.relay.send(chunk);
        busy = true;
      }
      // websocket --> WebRTC
      if (this.webrtcIsReady() && this.client.bufferedAmount < this.MAX_BUFFER && this.r2cSchedule.length > 0) {
        const chunk = this.r2cSchedule.shift();
        this.rateLimit.update(chunk.byteLength);
        this.client.send(chunk);
        busy = true;
      }
    };
    while (busy && !this.rateLimit.isLimited()) {
      checkChunks();
    }
    if (this.r2cSchedule.length > 0 || this.c2rSchedule.length > 0 || (this.relayIsReady() && this.relay.bufferedAmount > 0) || (this.webrtcIsReady() && this.client.bufferedAmount > 0)) {
      this.flush_timeout_id = setTimeout(this.flush, this.rateLimit.when() * 1000);
    }
  }

  webrtcIsReady() {
    return null !== this.client && 'open' === this.client.readyState;
  }

  relayIsReady() {
    return (null !== this.relay) && (WebSocket.OPEN === this.relay.readyState);
  }

  /**
   * @param {WebSocket} ws
   */
  isClosed(ws) {
    return undefined === ws || WebSocket.CLOSED === ws.readyState;
  }

  peerConnOpen() {
    return (null !== this.pc) && ('closed' !== this.pc.connectionState);
  }

  /**
   * @param {typeof this.relayURL} relayURL
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
ProxyPair.prototype.flush_timeout_id = null;

ProxyPair.prototype.onCleanup = null;
