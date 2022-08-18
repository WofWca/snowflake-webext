/* global Util, chrome, Config, UI, Broker, Snowflake, WS */
/* eslint no-unused-vars: 0 */

/*
UI
*/


/**
 * Decide whether we need to request or revoke the 'background' permission, and
 * set the `runInBackground` storage value appropriately.
 * @param {boolean | undefined} enabledSetting
 * @param {boolean | undefined} runInBackgroundSetting
 */
function maybeChangeBackgroundPermission(enabledSetting, runInBackgroundSetting) {
  const needBackgroundPermission =
    runInBackgroundSetting
    // When the extension is disabled, we need the permission to be revoked because
    // otherwise it'll keep the browser process running for no reason.
    && enabledSetting;
  // Yes, this is called even if the permission is already in the state we need
  // it to be in (granted/removed).
  new Promise(r => {
    chrome.permissions[needBackgroundPermission ? "request" : "remove"](
      { permissions: ['background'] },
      r
    );
  })
  .then(success => {
    // Currently the resolve value is `true` even when the permission was alrady granted
    // before it was requested (already removed before it was revoked). TODO Need to make
    // sure it's the desired behavior and if it needs to change.
    // https://developer.chrome.com/docs/extensions/reference/permissions/#method-remove
    // https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/permissions/remove#return_value
    // https://github.com/mdn/content/pull/17516
    if (success) {
      chrome.storage.local.set({ runInBackground: runInBackgroundSetting });
    }
  });
}

// If you want to gonna change this to `false`, double-check everything as some code
// may still be assuming it to be `true`.
const DEFAULT_ENABLED = true;

class WebExtUI extends UI {

  constructor() {
    super();
    this.onConnect = this.onConnect.bind(this);
    this.onMessage = this.onMessage.bind(this);
    this.onDisconnect = this.onDisconnect.bind(this);
    chrome.runtime.onConnect.addListener(this.onConnect);
  }

  checkNAT() {
    Util.checkNATType(config.datachannelTimeout).then((type) => {
      console.log("Setting NAT type: " + type);
      this.natType = type;
    }).catch((e) => {
      console.log(e);
    });
  }

  initNATType() {
    this.natType = "unknown";
    this.checkNAT();
    setInterval(() => {this.checkNAT();}, config.natCheckInterval);
  }

  tryProbe() {
    WS.probeWebsocket(config.relayAddr)
    .then(
      () => {
        this.missingFeature = false;
        this.setEnabled(true);
      },
      () => {
        log('Could not connect to bridge.');
        this.missingFeature = 'popupBridgeUnreachable';
        this.setEnabled(false);
      }
    );
  }

  initToggle() {
    // First, check if we have our status stored
    (new Promise((resolve) => {
      chrome.storage.local.get(["snowflake-enabled"], resolve);
    }))
    .then((result) => {
      let enabled = this.enabled;
      if (result['snowflake-enabled'] !== undefined) {
        enabled = result['snowflake-enabled'];
      } else {
        log("Toggle state not yet saved");
      }
      // If it isn't enabled, stop
      if (!enabled) {
        this.setEnabled(enabled);
        return;
      }
      // Otherwise, do feature checks
      if (!Util.hasWebRTC()) {
        this.missingFeature = 'popupWebRTCOff';
        this.setEnabled(false);
        return;
      }
      this.tryProbe();
    });
  }

  postActive() {
    this.setIcon();
    if (!this.port) { return; }
    this.port.postMessage({
      clients: this.clients,
      total: this.stats.reduce((t, c) => t + c, 0),
      enabled: this.enabled,
      missingFeature: this.missingFeature,
    });
  }

  onConnect(port) {
    this.port = port;
    port.onDisconnect.addListener(this.onDisconnect);
    port.onMessage.addListener(this.onMessage);
    this.postActive();
  }

  onMessage(m) {
    if (m.retry) {
      // FIXME: Can set a retrying state here
      this.tryProbe();
    } else if (m.enabled != undefined) {
      (new Promise((resolve) => {
        chrome.storage.local.set({ "snowflake-enabled": m.enabled }, resolve);
      }))
      .then(() => {
        log("Stored toggle state");
        this.initToggle();
      });
      if (
        typeof SUPPORTS_WEBEXT_OPTIONAL_BACKGROUND_PERMISSION !== 'undefined'
        // eslint-disable-next-line no-undef
        && SUPPORTS_WEBEXT_OPTIONAL_BACKGROUND_PERMISSION
      ) {
        new Promise(r => chrome.storage.local.get({ runInBackground: false }, r))
        .then(storage => {
          maybeChangeBackgroundPermission(m.enabled, storage.runInBackground);
        });
      }
    } else if (m.runInBackground != undefined) {
      if (
        typeof SUPPORTS_WEBEXT_OPTIONAL_BACKGROUND_PERMISSION !== 'undefined'
        // eslint-disable-next-line no-undef
        && SUPPORTS_WEBEXT_OPTIONAL_BACKGROUND_PERMISSION
      ) {
        new Promise(r => chrome.storage.local.get({ "snowflake-enabled": DEFAULT_ENABLED }, r))
        .then(storage => {
          maybeChangeBackgroundPermission(storage["snowflake-enabled"], m.runInBackground);
        });
      }
    } else {
      log("Unrecognized message");
    }
  }

  onDisconnect() {
    this.port = null;
  }

  /**
   * @param {boolean} enabled
   */
  setEnabled(enabled) {
    this.enabled = enabled;
    this.postActive();
    update();
  }

  setIcon() {
    let path = null;
    if (!this.enabled) {
      path = {
        48: "assets/toolbar-off-48.png",
        96: "assets/toolbar-off-96.png"
      };
    } else if (this.active) {
      path = {
        48: "assets/toolbar-running-48.png",
        96: "assets/toolbar-running-96.png"
      };
    } else {
      path = {
        48: "assets/toolbar-on-48.png",
        96: "assets/toolbar-on-96.png"
      };
    }
    chrome.browserAction.setIcon({
      path: path,
    });
  }

}

WebExtUI.prototype.port = null;

WebExtUI.prototype.enabled = DEFAULT_ENABLED;

/*
Entry point.
*/

/** @typedef {WebExtUI} UIOfThisContext */
var
  /** @type {boolean} */
  debug,
  /** @type {Snowflake | null} */
  snowflake,
  /** @type {Config | null} */
  config,
  /** @type {Broker | null} */
  broker,
  /** @type {UIOfThisContext | null} */
  ui,
  /** @type {(msg: unknown) => void} */
  log,
  /** @type {(msg: unknown) => void} */
  dbg,
  /** @type {() => void} */
  init,
  /** @type {() => void} */
  update,
  /** @type {boolean} */
  silenceNotifications;

(function () {

  silenceNotifications = false;
  debug = false;
  snowflake = null;
  config = null;
  broker = null;
  ui = null;

  // Log to both console and UI if applicable.
  // Requires that the snowflake and UI objects are hooked up in order to
  // log to console.
  log = function(msg) {
    console.log('Snowflake: ' + msg);
    if (snowflake != null) {
      snowflake.ui.log(msg);
    }
  };

  dbg = function(msg) {
    if (debug) {
      log(msg);
    }
  };

  init = function() {
    config = new Config("webext");
    ui = new WebExtUI();
    broker = new Broker(config);
    snowflake = new Snowflake(config, ui, broker);
    log('== snowflake proxy ==');
    ui.initToggle();
    ui.initNATType();
  };

  update = function() {
    if (!ui.enabled) {
      // Do not activate the proxy if any number of conditions are true.
      snowflake.disable();
      log('Currently not active.');
      return;
    }
    // Otherwise, begin setting up WebRTC and acting as a proxy.
    dbg('Contacting Broker at ' + broker.url);
    log('Starting snowflake');
    snowflake.setRelayAddr(config.relayAddr);
    snowflake.beginWebRTC();
  };

  window.onunload = function() {
    if (snowflake !== null) { snowflake.disable(); }
    return null;
  };

  window.onload = init;

}());
