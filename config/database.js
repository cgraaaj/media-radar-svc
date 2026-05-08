const redis = require('redis');
const fs = require('fs');

const CREDS_FILE_PATH = process.env.VAULT_CREDS_FILE || '/vault/secrets/creds.env';
const isK8sRuntime = (process.env.RUNTIME_ENV || '').toLowerCase() === 'k8s';

const RECONNECT_BACKOFF_MIN_MS = 1000;
const RECONNECT_BACKOFF_MAX_MS = 30000;
const ERROR_LOG_THROTTLE_MS = 5000;
const FILE_WATCH_INTERVAL_MS = 2000;

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
      reconnectStrategy: () => 0,
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

  await client.connect();
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

(async () => {
  watchCredsFile();
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
