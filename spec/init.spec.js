/* global expect, it, describe, Snowflake, UI */

// Fake snowflake to interact with

var snowflake = {
  ui: new UI,
  broker: {
    sendAnswer: function() {}
  }
};

describe('Init', function() {

  it('gives a dialog when closing, only while active', function() {
    silenceNotifications = false;
    ui.increaseClients();
    var msg = window.onbeforeunload();
    expect(ui.active).toBe(true);
    expect(msg).toBe(Snowflake.MESSAGE.CONFIRMATION);
    ui.decreaseClients();
    msg = window.onbeforeunload();
    expect(ui.active).toBe(false);
    expect(msg).toBe(null);
  });

  it('does not give a dialog when silent flag is on', function() {
    silenceNotifications = true;
    ui.increaseClients();
    var msg = window.onbeforeunload();
    expect(ui.active).toBe(true);
    expect(msg).toBe(null);
  });

});
