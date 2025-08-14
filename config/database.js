const redis = require('redis');
const fs = require('fs');

const CREDS_FILE_PATH = process.env.VAULT_CREDS_FILE || '/vault/secrets/creds.env';
const isK8sRuntime = (process.env.RUNTIME_ENV || '').toLowerCase() === 'k8s';

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
    REDIS_HOST: base.REDIS_HOST,        // always from env
    REDIS_PORT: base.REDIS_PORT,        // always from env
    REDIS_USERNAME: fileCreds.REDIS_USERNAME || base.REDIS_USERNAME,
    REDIS_PASSWORD: fileCreds.REDIS_PASSWORD || base.REDIS_PASSWORD,
  };
}

let redisClient = null;
let reconnectTimer = null;
let reconnectingNow = false;

async function connectWithFreshCreds() {
  const creds = buildCreds();

  if (redisClient) {
    try { await redisClient.quit(); } catch (_) { try { await redisClient.disconnect(); } catch (_) {} }
    redisClient = null;
  }

  const client = redis.createClient({
    socket: {
      host: process.env.REDIS_HOST,
      port: process.env.REDIS_PORT,
      reconnectStrategy: () => 0,
    },
    username: creds.REDIS_USERNAME,
    password: creds.REDIS_PASSWORD,
  });

  client.on('ready', () => console.log('Redis ready'));
  client.on('end', scheduleReconnect);
  client.on('error', async (e) => {
    console.error('Redis Client Error:', e.message);
    const msg = (e && e.message) ? e.message.toLowerCase() : '';
    // If creds are invalid/expired, force an immediate reconnect to re-read fresh creds
    if (msg.includes('wrongpass') || msg.includes('noauth') || msg.includes('user is disabled')) {
      await forceReconnectNow();
    }
  });

  await client.connect();
  redisClient = client;
}

function scheduleReconnect(delayMs = 1000) {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(async () => {
    reconnectTimer = null;
    try {
      await connectWithFreshCreds();
      console.log('Redis reconnected with (possibly rotated) credentials');
    } catch (e) {
      console.error('Redis reconnect failed:', e.message);
      scheduleReconnect(Math.min(delayMs * 2, 15000));
    }
  }, delayMs);
}

async function forceReconnectNow() {
  if (reconnectingNow) return;
  reconnectingNow = true;
  try {
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    await connectWithFreshCreds();
    console.log('Redis force-reconnected after auth error');
  } catch (e) {
    console.error('Redis force-reconnect failed:', e.message);
    scheduleReconnect(1000);
  } finally {
    reconnectingNow = false;
  }
}

(async () => {
  try {
    await connectWithFreshCreds();
  } catch (err) {
    console.error('Failed to initialize Redis:', err.message);
    scheduleReconnect();
  }
})();

module.exports = {
  get redisClient() { return redisClient; },
  isConnected: () => !!redisClient && redisClient.isOpen,
}; 