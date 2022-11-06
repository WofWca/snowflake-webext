/* global expect, it, describe, spyOn, Snowflake, Config, UI */

/*
jasmine tests for Snowflake
*/

// Fake browser functionality:
class RTCPeerConnection {
  setRemoteDescription() {
    return true;
  }
  createAnswer() {
    return Promise.resolve('foo');
  }
  setLocalDescription() {
    return Promise.resolve();
  }
  send() {}
}

class RTCSessionDescription {}
RTCSessionDescription.prototype.type = 'offer';

class WebSocket {
  constructor() {
    this.bufferedAmount = 0;
  }
  send() {}
}
WebSocket.prototype.OPEN = 1;
WebSocket.prototype.CLOSED = 0;

var log = function() {};

var config = new Config();

var ui = new UI();

class FakeBroker {
  getClientOffer() {
    return new Promise(function() {
      return {};
    });
  }
  setNATType(natType) {
  }
  sendAnswer() {}
}

describe('Snowflake', function() {

  it('constructs correctly', function() {
    var s;
    s = new Snowflake(config, ui, new FakeBroker());
    expect(s.rateLimit).not.toBeNull();
    expect(s.broker).toEqual(new FakeBroker());
    expect(s.ui).not.toBeNull();
    expect(s.retries).toBe(0);
  });

  it('sets relay address correctly', function() {
    var s;
    s = new Snowflake(config, ui, new FakeBroker());
    s.setRelayAddr('foo');
    expect(s.relayAddr).toEqual('foo');
  });

  it('initalizes WebRTC connection', function() {
    var s;
    s = new Snowflake(config, ui, new FakeBroker());
    spyOn(s.broker, 'getClientOffer').and.callThrough();
    s.beginServingClients();
    expect(s.retries).toBe(1);
    expect(s.broker.getClientOffer).toHaveBeenCalled();
  });

  it('receives SDP offer and sends answer', function() {
    var broker, pair, s;
    broker = new FakeBroker();
    s = new Snowflake(config, ui, broker);
    pair = {
      id: 'foo',
      receiveWebRTCOffer: function(_offer, sendAnswer) {
        sendAnswer('bar');
        return true;
      }
    };
    spyOn(broker, 'sendAnswer');
    s.receiveOffer(pair, '{"type":"offer","sdp":"foo"}');
    expect(broker.sendAnswer).toHaveBeenCalled();
  });

  it('does not send answer when receiving invalid offer', function() {
    var broker, pair, s;
    broker = new FakeBroker();
    s = new Snowflake(config, ui, broker);
    pair = {
      id: 'foo',
      receiveWebRTCOffer: function(_offer, sendAnswer) {
        return false;
      }
    };
    spyOn(broker, 'sendAnswer');
    s.receiveOffer(pair, '{"type":"not a good offer","sdp":"foo"}');
    expect(broker.sendAnswer).not.toHaveBeenCalled();
  });

  it('can make a proxypair', function() {
    var s;
    s = new Snowflake(config, ui, new FakeBroker());
    s.makeProxyPair();
    expect(s.proxyPairs.length).toBe(1);
  });

});
