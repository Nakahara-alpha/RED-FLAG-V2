// ESP32 bridge over MQTT. The `mqtt` package is optional — lazy-imported so the
// bot runs fine without it (see DECISIONS.md). Broker config from env only.
let client = null;
let connecting = null;

function topicPrefix() { return process.env.MQTT_TOPIC_PREFIX || 'redflag'; }

async function getClient() {
  if (client?.connected) return client;
  if (connecting) return connecting;
  // Client exists but isn't connected (reconnecting / errored). Tear it down
  // before building a fresh one so we don't leak a client with its own
  // reconnect loop still running.
  if (client) { try { client.end(true); } catch { /* ignore */ } client = null; }
  const url = process.env.MQTT_URL;
  if (!url) throw new Error('📡 MQTT_URL is not set in config.env.');
  let mqtt;
  try {
    mqtt = (await import('mqtt')).default;
  } catch {
    throw new Error('📡 MQTT support needs the mqtt package. Run: *npm i mqtt* in the bot folder.');
  }
  connecting = new Promise((resolve, reject) => {
    const c = mqtt.connect(url, {
      username: process.env.MQTT_USERNAME || undefined,
      password: process.env.MQTT_PASSWORD || undefined,
      connectTimeout: 8000,
      reconnectPeriod: 5000,
    });
    // DURABLE error listener — logs only. There must always be ≥1 'error'
    // listener or Node rethrows the event as an uncaught exception and kills the
    // process. The old code only had a connect-phase once('error') that removed
    // itself after firing, so a second broker error crashed the whole bot.
    c.on('error', (err) => console.error('[RF] MQTT error:', err?.message || err));

    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { c.end(true); } catch { /* ignore */ }
      reject(new Error('📡 MQTT broker timed out.'));
    }, 9000);
    const onConnectError = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { c.end(true); } catch { /* ignore */ } // initial connect failed — give up
      reject(new Error(`📡 MQTT error: ${err.message}`));
    };
    c.once('connect', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      c.removeListener('error', onConnectError); // leave only the durable logger
      client = c;
      resolve(c);
    });
    c.once('error', onConnectError);
  }).finally(() => { connecting = null; });
  return connecting;
}

/** Publish raw payload to <prefix>/<topic>. */
export async function espPublish(topic, payload) {
  const c = await getClient();
  const full = topic.includes('/') ? topic : `${topicPrefix()}/${topic}`;
  await new Promise((res, rej) => c.publish(full, String(payload), {}, e => (e ? rej(e) : res())));
  return full;
}

/** Publish to <prefix>/<topic> and wait for one reply on <prefix>/<topic>/reply. */
export async function espRequest(topic, payload, timeoutMs = 6000) {
  const c = await getClient();
  const reqTopic = `${topicPrefix()}/${topic}`;
  const replyTopic = `${reqTopic}/reply`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      c.unsubscribe(replyTopic);
      c.removeListener('message', onMsg);
      reject(new Error('📡 ESP32 did not reply (is it online?).'));
    }, timeoutMs);
    function onMsg(t, buf) {
      if (t !== replyTopic) return;
      clearTimeout(timer);
      c.unsubscribe(replyTopic);
      c.removeListener('message', onMsg);
      resolve(buf.toString());
    }
    c.on('message', onMsg);
    c.subscribe(replyTopic, (e) => {
      if (e) { clearTimeout(timer); c.removeListener('message', onMsg); reject(e); return; }
      c.publish(reqTopic, String(payload));
    });
  });
}
