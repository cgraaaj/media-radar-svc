const levels = { error: 0, warn: 1, info: 2, debug: 3 };
const currentLevel = (process.env.LOG_LEVEL || 'info').toLowerCase();

function shouldLog(level) {
  return levels[level] <= (levels[currentLevel] ?? 1);
}

function fmt(level, message, meta) {
  const ts = new Date().toISOString();
  const base = { level, ts, message, ...(meta || {}) };
  try {
    return JSON.stringify(base);
  } catch (_) {
    return `${ts} ${level.toUpperCase()} ${message}`;
  }
}

module.exports = {
  info(message, meta) { if (shouldLog('info')) console.log(fmt('info', message, meta)); },
  warn(message, meta) { if (shouldLog('warn')) console.warn(fmt('warn', message, meta)); },
  error(message, meta) { if (shouldLog('error')) console.error(fmt('error', message, meta)); },
  debug(message, meta) { if (shouldLog('debug')) console.debug(fmt('debug', message, meta)); },
}; 