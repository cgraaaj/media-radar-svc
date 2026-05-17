const redis = require('redis');
const fs = require('fs');

const CREDS_FILE_PATH = process.env.VAULT_CREDS_FILE || '/vault/secrets/creds.env';
const isK8sRuntime = (process.env.RUNTIME_ENV || '').toLowerCase() === 'k8s';

const RECONNECT_BACKOFF_MIN_MS = 1000;
const RECONNECT_BACKOFF_MAX_MS = 30000;
const ERROR_LOG_THROTTLE_MS = 5000;
const FILE_WATCH_INTERVAL_MS = 2000;
const CONNECT_TIMEOUT_MS = 5000;
const WATCHDOG_INTERVAL_MS = 15000;

function parseEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return {};
  const lines = fs.readFileSync(filePath, 'utf8').split('\n');
  const out = {};
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const idx = line.indexOf('=');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const val = line.slice(idx + 1).trim().replace(/(^"|"$)/g, '');
    if (key) out[key] = val;
  }
  return out;
}

function buildCreds() {
  const base = {
    REDIS_HOST: process.env.REDIS_HOST,
    REDIS_PORT: process.env.REDIS_PORT,
    REDIS_USERNAME: process.env.REDIS_USERNAME,
    REDIS_PASSWORD: process.env.REDIS_PASSWORD,
  };
  if (!isK8sRuntime) return base;
  const fileCreds = parseEnvFile(CREDS_FILE_PATH);
  return {
    REDIS_HOST: base.REDIS_HOST,
    REDIS_PORT: base.REDIS_PORT,
    REDIS_USERNAME: fileCreds.REDIS_USERNAME || base.REDIS_USERNAME,
    REDIS_PASSWORD: fileCreds.REDIS_PASSWORD || base.REDIS_PASSWORD,
  };
}

let redisClient = null;
let reconnectTimer = null;
let reconnecting = false;
let backoffMs = RECONNECT_BACKOFF_MIN_MS;
let lastErrorLogAt = 0;
let lastErrorMessage = '';

function logRedisErrorThrottled(message) {
  const now = Date.now();
  if (now - lastErrorLogAt > ERROR_LOG_THROTTLE_MS || message !== lastErrorMessage) {
    console.error('Redis Client Error:', message);
    lastErrorLogAt = now;
    lastErrorMessage = message;
  }
}

function isAuthError(err) {
  const msg = ((err && err.message) || '').toLowerCase();
  return msg.includes('wrongpass') || msg.includes('noauth') || msg.includes('user is disabled');
}

function connectWithTimeout(client, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const t = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { client.disconnect(); } catch (_) {}
      reject(new Error(`connect timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    client.connect().then(
      () => { if (settled) return; settled = true; clearTimeout(t); resolve(); },
      (err) => { if (settled) return; settled = true; clearTimeout(t); reject(err); }
    );
  });
}

async function connectWithFreshCreds() {
  const creds = buildCreds();

  if (redisClient) {
    try { await redisClient.quit(); }
    catch (_) { try { await redisClient.disconnect(); } catch (_) {} }
    redisClient = null;
  }

  const client = redis.createClient({
    socket: {
      host: creds.REDIS_HOST,
      port: Number(creds.REDIS_PORT),
      // Disable node-redis' internal reconnect entirely; our scheduleReconnect()
      // owns the retry loop and re-reads creds.env on every attempt. Returning
      // a number here (incl. 0) makes node-redis loop forever with the SAME
      // cached password, which used to wedge client.connect() during the brief
      // Vault->Redis push lag at rotation time.
      reconnectStrategy: false,
      connectTimeout: CONNECT_TIMEOUT_MS,
    },
    username: creds.REDIS_USERNAME,
    password: creds.REDIS_PASSWORD,
  });

  client.on('ready', () => {
    backoffMs = RECONNECT_BACKOFF_MIN_MS;
    console.log('Redis ready');
  });
  client.on('end', () => scheduleReconnect());
  client.on('error', (e) => {
    logRedisErrorThrottled((e && e.message) || String(e));
    if (isAuthError(e)) {
      scheduleReconnect();
    }
  });

  await connectWithTimeout(client, CONNECT_TIMEOUT_MS);
  redisClient = client;
}

function scheduleReconnect() {
  if (reconnectTimer || reconnecting) return;
  reconnectTimer = setTimeout(async () => {
    reconnectTimer = null;
    reconnecting = true;
    try {
      await connectWithFreshCreds();
      console.log('Redis reconnected with current credentials');
    } catch (e) {
      logRedisErrorThrottled(`reconnect failed: ${e.message}`);
      backoffMs = Math.min(backoffMs * 2, RECONNECT_BACKOFF_MAX_MS);
      reconnecting = false;
      scheduleReconnect();
      return;
    }
    reconnecting = false;
  }, backoffMs);
}

function watchCredsFile() {
  if (!isK8sRuntime) return;
  if (!fs.existsSync(CREDS_FILE_PATH)) return;
  fs.watchFile(CREDS_FILE_PATH, { interval: FILE_WATCH_INTERVAL_MS }, (curr, prev) => {
    if (curr.mtimeMs === prev.mtimeMs) return;
    console.log('Vault creds file changed - reloading Redis client');
    backoffMs = RECONNECT_BACKOFF_MIN_MS;
    scheduleReconnect();
  });
}

// Belt-and-suspenders: if for any reason we end up without an open client and
// no reconnect is in flight (e.g. a missed 'end' event, an exception swallowed
// by the redis library), pick it up here. Cheap and idempotent — scheduleReconnect
// itself is guarded by reconnectTimer/reconnecting.
function startConnectionWatchdog() {
  setInterval(() => {
    const open = !!redisClient && redisClient.isOpen;
    if (!open && !reconnectTimer && !reconnecting) {
      console.log('Watchdog: Redis client not open - kicking reconnect');
      backoffMs = RECONNECT_BACKOFF_MIN_MS;
      scheduleReconnect();
    }
  }, WATCHDOG_INTERVAL_MS).unref();
}

(async () => {
  watchCredsFile();
  startConnectionWatchdog();
  try {
    await connectWithFreshCreds();
  } catch (err) {
    logRedisErrorThrottled(`init failed: ${err.message}`);
    scheduleReconnect();
  }
})();

module.exports = {
  get redisClient() { return redisClient; },
  isConnected: () => !!redisClient && redisClient.isOpen,
};
