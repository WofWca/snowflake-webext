/* global TESTING, Util, Params, Config, UI, Broker, Snowflake */

/*
UI
*/

class DebugUI extends UI {

  constructor() {
    super();
    // Setup other DOM handlers if it's debug mode.
    this.$status = document.getElementById('status');
    this.$msglog = document.getElementById('msglog');
    this.$msglog.value = '';
  }

  // Status bar
  setStatus(msg) {
    const txt = document.createTextNode('Status: ' + msg);
    while (this.$status.firstChild) {
      this.$status.removeChild(this.$status.firstChild);
    }
    return this.$status.appendChild(txt);
  }

  increaseClients() {
    super.increaseClients();
    return this.$msglog.className = this.active ? 'active' : '';
  }

  decreaseClients() {
    super.decreaseClients();
    return this.$msglog.className = this.active ? 'active' : '';
  }

  log(msg) {
    // Scroll to latest
    this.$msglog.value += msg + '\n';
    return this.$msglog.scrollTop = this.$msglog.scrollHeight;
  }

}

// DOM elements references.
DebugUI.prototype.$msglog = null;

DebugUI.prototype.$status = null;

/*
Entry point.
*/

/** @typedef {DebugUI | UI} UIOfThisContext */
var
  /** @type {boolean} */
  debug,
  /** @type {Snowflake | null} */
  snowflake,
  /** @type {URLSearchParams} */
  query,
  /** @type {UIOfThisContext} */
  ui,
  /** @type {(msg: unknown) => void} */
  log,
  /** @type {(msg: unknown) => void} */
  dbg,
  /** @type {() => void} */
  init,
  /** @type {boolean} */
  silenceNotifications;


(function() {

  if (((typeof TESTING === "undefined" || TESTING === null) || !TESTING) && !Util.featureDetect()) {
    console.log('webrtc feature not detected. shutting down');
    return;
  }

  snowflake = null;

  query = new URLSearchParams(location.search);

  debug = Params.getBool(query, 'debug', false);

  silenceNotifications = Params.getBool(query, 'silent', false);

  // Log to both console and UI if applicable.
  // Requires that the snowflake and UI objects are hooked up in order to
  // log to console.
  log = function(msg) {
    console.log('Snowflake: ' + msg);
    return snowflake != null ? snowflake.ui.log(msg) : undefined;
  };

  dbg = function(msg) {
    if (debug || ((snowflake != null ? snowflake.ui : undefined) instanceof DebugUI)) {
      return log(msg);
    }
  };

  init = function() {
    const config = new Config("testing");
    if ('off' !== query['ratelimit']) {
      config.rateLimitBytes = Params.getByteCount(query, 'ratelimit', config.rateLimitBytes);
    }
    const ui = document.getElementById('status') !== null
      ? new DebugUI()
      : new UI();
    const broker = new Broker(config);
    snowflake = new Snowflake(config, ui, broker);
    log('== snowflake proxy ==');
    if (Util.snowflakeIsDisabled(config.cookieName)) {
      // Do not activate the proxy if any number of conditions are true.
      log('Currently not active.');
      return;
    }
    // Otherwise, begin setting up WebRTC and acting as a proxy.
    dbg('Contacting Broker at ' + broker.url);
    snowflake.setRelayAddr(config.relayAddr);
    return snowflake.beginWebRTC();
  };

  // Notification of closing tab with active proxy.
  window.onbeforeunload = function() {
    if (
      !silenceNotifications &&
      snowflake !== null &&
      ui.active
    ) {
      return Snowflake.MESSAGE.CONFIRMATION;
    }
    return null;
  };

  window.onunload = function() {
    if (snowflake !== null) { snowflake.disable(); }
    return null;
  };

  window.onload = init;

}());
