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

async function connectWithFreshCreds() {
  // Read creds at (re)connect time
  const creds = buildCreds();

  // Dispose previous client if any
  if (redisClient) {
    try { await redisClient.quit(); } catch (_) { try { await redisClient.disconnect(); } catch (_) {} }
    redisClient = null;
  }

  const client = redis.createClient({
    socket: {
      host: process.env.REDIS_HOST,
      port: process.env.REDIS_PORT,
      // Disable auto reconnect; we will rebuild with fresh creds
      reconnectStrategy: () => 0,
    },
    username: creds.REDIS_USERNAME,
    password: creds.REDIS_PASSWORD,
  });

  client.on('ready', () => console.log('Redis ready'));
  client.on('error', (e) => console.error('Redis Client Error:', e.message));
  client.on('end', scheduleReconnect);

  await client.connect();
  redisClient = client;
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(async () => {
    reconnectTimer = null;
    try {
      await connectWithFreshCreds();
      console.log('Redis reconnected with (possibly rotated) credentials');
    } catch (e) {
      console.error('Redis reconnect failed:', e.message);
      scheduleReconnect();
    }
  }, 1000);
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