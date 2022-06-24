/* global log, dbg, DummyRateLimit, BucketRateLimit, ProxyPair */

/*
A JavaScript WebRTC snowflake proxy

Uses WebRTC from the client, and Websocket to the server.

Assume that the webrtc client plugin is always the offerer, in which case
this proxy must always act as the answerer.

TODO: More documentation
*/

class Snowflake {

  // Prepare the Snowflake with a Broker (to find clients) and optional UI.
  constructor(config, ui, broker) {
    this.receiveOffer = this.receiveOffer.bind(this);

    this.config = config;
    this.ui = ui;
    this.broker = broker;
    this.broker.setNATType(ui.natType);
    this.proxyPairs = [];
    this.natFailures = 0;
    this.pollInterval = this.config.defaultBrokerPollInterval;
    if (void 0 === this.config.rateLimitBytes) {
      this.rateLimit = new DummyRateLimit();
    } else {
      this.rateLimit = new BucketRateLimit(this.config.rateLimitBytes * this.config.rateLimitHistory, this.config.rateLimitHistory);
    }
    this.retries = 0;
  }

  // Set the target relay address spec, which is expected to be websocket.
  // TODO: Should potentially fetch the target from broker later, or modify
  // entirely for the Tor-independent version.
  setRelayAddr(relayAddr) {
    this.relayAddr = relayAddr;
    log('Using ' + relayAddr.host + ':' + relayAddr.port + ' as Relay.');
  }

  // Initialize WebRTC PeerConnection, which requires beginning the signalling
  // process. |pollBroker| automatically arranges signalling.
  beginWebRTC() {
    this.pollBroker();
    this.pollTimeoutId = setTimeout((() => {
      this.beginWebRTC();
    }), this.pollInterval);
  }

  // Regularly poll Broker for clients to serve until this snowflake is
  // serving at capacity, at which point stop polling.
  pollBroker() {
    var msg, pair, recv;
    // Poll broker for clients.
    pair = this.makeProxyPair();
    if (!pair) {
      log('At client capacity.');
      return;
    }
    log('Polling broker..');
    // Do nothing until a new proxyPair is available.
    msg = 'Polling for client ... ';
    if (this.retries > 0) {
      msg += '[retries: ' + this.retries + ']';
    }
    this.ui.setStatus(msg);
    //update NAT type
    console.log("NAT type: " + this.ui.natType);
    this.broker.setNATType(this.ui.natType);
    recv = this.broker.getClientOffer(pair.id, this.proxyPairs.length);
    recv.then((resp) => {
      var clientNAT = resp.NAT;
      if (!this.receiveOffer(pair, resp.Offer, resp.RelayURL)) {
        pair.close();
        return;
      }
      //set a timeout for channel creation
      setTimeout((() => {
        if (!pair.webrtcIsReady()) {
          log('proxypair datachannel timed out waiting for open');
          pair.close();
          // increase poll interval
          this.pollInterval =
            Math.min(this.pollInterval + this.config.pollAdjustment,
              this.config.slowestBrokerPollInterval);
          if (clientNAT == "restricted") {
            this.natFailures++;
          }
          // if we fail to connect to a restricted client 3 times in
          // a row, assume we have a restricted NAT
          if (this.natFailures >= 3) {
            this.ui.natType = "restricted";
            console.log("Learned NAT type: restricted");
            this.natFailures = 0;
          }
          this.broker.setNATType(this.ui.natType);
        } else {
          // decrease poll interval
          this.pollInterval =
            Math.max(this.pollInterval - this.config.pollAdjustment,
              this.config.defaultBrokerPollInterval);
          this.natFailures = 0;
        }
      }), this.config.datachannelTimeout);
    }, function () {
      //on error, close proxy pair
      pair.close();
    });
    this.retries++;
  }

  // Receive an SDP offer from some client assigned by the Broker,
  // |pair| - an available ProxyPair.
  receiveOffer(pair, desc, relayURL) {
    var e, offer, sdp;

    try {
      if (relayURL !== undefined) {
        let relayURLParsed = new URL(relayURL);
        let hostname = relayURLParsed.hostname;
        let protocol = relayURLParsed.protocol;
        if (protocol !== "wss:") {
          log('incorrect relay url protocol');
          return false;
        }
        if (!this.checkRelayPattern(this.config.allowedRelayPattern, hostname)) {
          log('relay url hostname does not match allowed pattern');
          return false;
        }
        pair.setRelayURL(relayURL);
      }
      offer = JSON.parse(desc);
      dbg('Received:\n\n' + offer.sdp + '\n');
      sdp = new RTCSessionDescription(offer);
      if (pair.receiveWebRTCOffer(sdp)) {
        this.sendAnswer(pair);
        return true;
      } else {
        return false;
      }
    } catch (error) {
      e = error;
      log('ERROR: Unable to receive Offer: ' + e);
      return false;
    }
  }

  sendAnswer(pair) {
    var fail, next;
    next = function (sdp) {
      dbg('webrtc: Answer ready.');
      pair.pc.setLocalDescription(sdp).catch(fail);
    };
    fail = function () {
      pair.close();
      dbg('webrtc: Failed to create or set Answer');
    };
    pair.pc.createAnswer().then(next).catch(fail);
  }

  /**
   * @returns {null | ProxyPair}
   */
  makeProxyPair() {
    if (this.proxyPairs.length >= this.config.maxNumClients) {
      return null;
    }
    var pair;
    pair = new ProxyPair(this.relayAddr, this.rateLimit, this.config);
    this.proxyPairs.push(pair);

    log('Snowflake IDs: ' + (this.proxyPairs.map(function (p) {
      return p.id;
    })).join(' | '));

    pair.onCleanup = () => {
      var ind;
      // Delete from the list of proxy pairs.
      ind = this.proxyPairs.indexOf(pair);
      if (ind > -1) {
        this.proxyPairs.splice(ind, 1);
      }
    };
    pair.begin();
    return pair;
  }

  // Stop all proxypairs.
  disable() {
    log('Disabling Snowflake.');
    clearTimeout(this.pollTimeoutId);
    while (this.proxyPairs.length > 0) {
      this.proxyPairs.pop().close();
    }
  }

  /**
   * checkRelayPattern match str against patten
   * @param {string} pattern
   * @param {string} str typically a domain name to be checked
   * @return {boolean}
   */
  checkRelayPattern(pattern, str) {
    if (typeof pattern !== "string") {
      throw 'invalid checkRelayPattern input: pattern';
    }
    if (typeof str !== "string") {
      throw 'invalid checkRelayPattern input: str';
    }

    let exactMatch = false;
    if (pattern.charAt(0) === "^") {
      exactMatch = true;
      pattern = pattern.substring(1);
    }

    if (exactMatch) {
      return pattern.localeCompare(str) === 0;
    }
    return str.endsWith(pattern);
  }

}

Snowflake.prototype.relayAddr = null;
Snowflake.prototype.rateLimit = null;

Snowflake.MESSAGE = {
  CONFIRMATION: 'You\'re currently serving a Tor user via Snowflake.'
};
