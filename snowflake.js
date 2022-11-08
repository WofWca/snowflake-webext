/* global log, dbg, DummyRateLimit, BucketRateLimit, ProxyPair */

/**
A JavaScript WebRTC snowflake proxy

Uses WebRTC from the client, and Websocket to the server.

Assume that the webrtc client plugin is always the offerer, in which case
this proxy must always act as the answerer.

TODO: More documentation
*/

class Snowflake {

  /**
   * Prepare the Snowflake with a Broker (to find clients) and optional UI.
   * @param {Config} config
   * @param {WebExtUI | BadgeUI | DebugUI} ui
   * @param {Broker} broker
   */
  constructor(config, ui, broker) {
    this.receiveOffer = this.receiveOffer.bind(this);

    this.config = config;
    this.ui = ui;
    this.broker = broker;
    this.broker.setNATType(ui.natType);
    this.proxyPairs = [];
    this.natFailures = 0;
    this.pollInterval = this.config.defaultBrokerPollInterval;
    if (undefined === this.config.rateLimitBytes) {
      this.rateLimit = new DummyRateLimit();
    } else {
      this.rateLimit = new BucketRateLimit(this.config.rateLimitBytes * this.config.rateLimitHistory, this.config.rateLimitHistory);
    }
    this.retries = 0;
  }

  /**
   * Start asking the broker for clients and serving them.
   */
  beginServingClients() {
    if (this.proxyPairs.length < this.config.maxNumClients) {
      this.pollBroker();
    } else {
      dbg('Polling skipped: at client capacity.');
    }
    this.pollTimeoutId = setTimeout((() => {
      this.beginServingClients();
    }), this.pollInterval);
  }

  /**
   * Try to get a client from the broker and start serving it upon success.
   * @private
   */
  pollBroker() {
    const pair = this.makeProxyPair();
    log('Polling broker..');

    let msg = 'Polling for client ... ';
    if (this.retries > 0) {
      msg += '[retries: ' + this.retries + ']';
    }
    this.ui.setStatus(msg);

    //update NAT type
    console.log("NAT type: " + this.ui.natType);
    this.broker.setNATType(this.ui.natType);

    const recv = this.broker.getClientOffer(pair.id, this.proxyPairs.length);
    recv.then((resp) => {
      const clientNAT = resp.NAT;
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
            this.config.maxNumClients = 1;
          }
          this.broker.setNATType(this.ui.natType);
        } else {
          // decrease poll interval
          this.pollInterval =
            Math.max(this.pollInterval - this.config.pollAdjustment,
              this.config.defaultBrokerPollInterval);
          this.natFailures = 0;
          if (this.ui.natType == "unrestricted") {
            this.pollInterval = this.config.fastBrokerPollInterval;
            this.config.maxNumClients = 2;
          }
        }
      }), this.config.datachannelTimeout);
    }, function () {
      //on error, close proxy pair
      pair.close();
    });
    this.retries++;
  }

  /**
   * Receive an SDP offer from some client assigned by the Broker
   * @param {ProxyPair} pair an available ProxyPair.
   * @param {string} desc
   * @param {string | undefined} relayURL
   * @returns {boolean} `true` on success, `false` on fail.
   * @private
   */
  receiveOffer(pair, desc, relayURL) {
    try {
      if (relayURL !== undefined) {
        const relayURLParsed = new URL(relayURL);
        const hostname = relayURLParsed.hostname;
        const protocol = relayURLParsed.protocol;
        if (protocol !== "wss:") {
          log('incorrect relay url protocol');
          return false;
        }
        if (!Snowflake.checkRelayPattern(this.config.allowedRelayPattern, hostname)) {
          log('relay url hostname does not match allowed pattern');
          return false;
        }
        pair.setRelayURL(relayURL);
      }
      /** @type {RTCSessionDescriptionInit} */
      const offer = JSON.parse(desc);
      dbg('Received:\n\n' + offer.sdp + '\n');
      const sdp = new RTCSessionDescription(offer);
      const result = pair.receiveWebRTCOffer(
        sdp,
        answer => this.broker.sendAnswer(pair.id, answer)
      );
      return result;
    } catch (e) {
      log('ERROR: Unable to receive Offer: ' + e);
      return false;
    }
  }

  /**
   * @returns {ProxyPair}
   * @private
   */
  makeProxyPair() {
    const pair = new ProxyPair(this.rateLimit, this.config);
    this.proxyPairs.push(pair);

    log('Snowflake IDs: ' + (this.proxyPairs.map(p => p.id)).join(' | '));

    pair.onCleanup = () => {
      // Delete from the list of proxy pairs.
      const ind = this.proxyPairs.indexOf(pair);
      if (ind > -1) {
        this.proxyPairs.splice(ind, 1);
      }
    };
    pair.begin();
    return pair;
  }

  /** Stop all proxypairs. */
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
   * @private
   */
  static checkRelayPattern(pattern, str) {
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

Snowflake.prototype.rateLimit = null;

Snowflake.MESSAGE = {
  CONFIRMATION: 'You\'re currently serving a Tor user via Snowflake.'
};
