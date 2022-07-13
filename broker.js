/* global log, dbg, snowflake */

/**
Communication with the snowflake broker.

Browser snowflakes must register with the broker in order
to get assigned to clients.
*/

// Represents a broker running remotely.
class Broker {

  /**
   * When interacting with the Broker, snowflake must generate a unique session
   * ID so the Broker can keep track of each proxy's signalling channels.
   * On construction, this Broker object does not do anything until
   * `getClientOffer` is called.
   */
  constructor(config) {
    this.getClientOffer = this.getClientOffer.bind(this);
    this._postRequest = this._postRequest.bind(this);
    this.setNATType = this.setNATType.bind(this);

    this.config = config;
    this.url = config.brokerUrl;
    this.natType = "unknown";
    if (0 === this.url.indexOf('localhost', 0)) {
      // Ensure url has the right protocol + trailing slash.
      this.url = 'http://' + this.url;
    }
    if (0 !== this.url.indexOf('http', 0)) {
      this.url = 'https://' + this.url;
    }
    if ('/' !== this.url.substr(-1)) {
      this.url += '/';
    }
  }

  /**
   * Promises some client SDP Offer.
   * Registers this Snowflake with the broker using an HTTP POST request, and
   * waits for a response containing some client offer that the Broker chooses
   * for this proxy..
   * TODO: Actually support multiple clients.
   */
  getClientOffer(id, numClientsConnected) {
    return new Promise((fulfill, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.onreadystatechange = function() {
        if (xhr.DONE !== xhr.readyState) {
          return;
        }
        switch (xhr.status) {
          case Broker.CODE.OK: {
            const response = JSON.parse(xhr.responseText);
            if (response.Status == Broker.STATUS.MATCH) {
              return fulfill(response); // Should contain offer.
            } else if (response.Status == Broker.STATUS.TIMEOUT) {
              return reject(Broker.MESSAGE.TIMEOUT);
            } else {
              log('Broker ERROR: Unexpected ' + response.Status);
              return reject(Broker.MESSAGE.UNEXPECTED);
            }
          }
          default:
            log('Broker ERROR: Unexpected ' + xhr.status + ' - ' + xhr.statusText);
            snowflake.ui.setStatus(' failure. Please refresh.');
            return reject(Broker.MESSAGE.UNEXPECTED);
        }
      };
      this._xhr = xhr; // Used by spec to fake async Broker interaction
      const clients = Math.floor(numClientsConnected / 8) * 8;
      const data = {
        Version: "1.3",
        Sid: id,
        Type: this.config.proxyType,
        NAT: this.natType,
        Clients: clients,
        AcceptedRelayPattern: this.config.allowedRelayPattern,
      };
      this._postRequest(xhr, 'proxy', JSON.stringify(data));
    });
  }

  /**
   * Assumes getClientOffer happened, and a WebRTC SDP answer has been generated.
   * Sends it back to the broker, which passes it to back to the original client.
   */
  sendAnswer(id, answer) {
    dbg(id + ' - Sending answer back to broker...\n');
    dbg(answer.sdp);
    const xhr = new XMLHttpRequest();
    xhr.onreadystatechange = function() {
      if (xhr.DONE !== xhr.readyState) {
        return;
      }
      switch (xhr.status) {
        case Broker.CODE.OK:
          dbg('Broker: Successfully replied with answer.');
          dbg(xhr.responseText);
          break;
        default:
          dbg('Broker ERROR: Unexpected ' + xhr.status + ' - ' + xhr.statusText);
          snowflake.ui.setStatus(' failure. Please refresh.');
          break;
      }
    };
    const data = {"Version": "1.0", "Sid": id, "Answer": JSON.stringify(answer)};
    this._postRequest(xhr, 'answer', JSON.stringify(data));
  }

  setNATType(natType) {
    this.natType = natType;
  }

  /**
   * urlSuffix for the broker is different depending on what action
   * is desired.
   */
  _postRequest(xhr, urlSuffix, payload) {
    try {
      xhr.open('POST', this.url + urlSuffix);
    } catch (err) {
      /*
      An exception happens here when, for example, NoScript allows the domain
      on which the proxy badge runs, but not the domain to which it's trying
      to make the HTTP xhr. The exception message is like "Component
      returned failure code: 0x805e0006 [nsIXMLHttpRequest.open]" on Firefox.
      */
      log('Broker: exception while connecting: ' + err.message);
      return;
    }
    xhr.send(payload);
  }

}

Broker.CODE = {
  OK: 200,
  BAD_REQUEST: 400,
  INTERNAL_SERVER_ERROR: 500
};

Broker.STATUS = {
  MATCH: "client match",
  TIMEOUT: "no match"
};

Broker.MESSAGE = {
  TIMEOUT: 'Timed out waiting for a client offer.',
  UNEXPECTED: 'Unexpected status.'
};

