/* global Config, UI, Broker, Snowflake */

/*
Entry point.
*/

var config = new Config("node");

var ui = new UI();

var broker = new Broker(config);

var snowflake = new Snowflake(config, ui, broker);

var log = function(msg) {
  console.log('Snowflake: ' + msg);
};

var dbg = log;

log('== snowflake proxy ==');

dbg('Contacting Broker at ' + broker.url);

snowflake.beginServingClients();
