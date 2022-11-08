/*
Only websocket-specific stuff.
*/

// eslint-disable-next-line no-unused-vars
class WS {
  /**
   * Creates a websocket connection from a URL and params to override
   * @param {URL|string} url
   * @param {URLSearchParams|string[][]} params
   * @return {WebSocket}
   */
  static makeWebsocket(url, params) {
    let parsedURL = new URL(url);
    let urlpa = new URLSearchParams(params);
    urlpa.forEach(function (value, key) {
      parsedURL.searchParams.set(key, value);
    });

    let ws = new WebSocket(url);
    /*
    'User agents can use this as a hint for how to handle incoming binary data:
    if the attribute is set to 'blob', it is safe to spool it to disk, and if it
    is set to 'arraybuffer', it is likely more efficient to keep the data in
    memory.'
    */
    ws.binaryType = 'arraybuffer';
    return ws;
  }

  /**
   * @param {URL | string} addr
   */
  static probeWebsocket(addr) {
    return /** @type {Promise<void>} */(new Promise((resolve, reject) => {
      const ws = WS.makeWebsocket(addr, []);
      ws.onopen = () => {
        resolve();
        ws.close();
      };
      ws.onerror = () => {
        reject();
        ws.close();
      };
    }));
  }

}
