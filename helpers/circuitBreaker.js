/**
 * Tiny circuit breaker for protecting a single downstream (Redis tier fetch,
 * upstream HTTP call, etc.). No external dependencies.
 *
 * States:
 *   - closed    : requests flow through. Failures are counted in a rolling
 *                 window. When threshold is exceeded -> open.
 *   - open      : all calls fail-fast with CircuitBreakerOpenError until
 *                 `openDurationMs` elapses, then -> half-open.
 *   - half-open : exactly ONE probe request is allowed through. On success,
 *                 -> closed. On failure, -> open (reset timer).
 *
 * The breaker is keyed (e.g. per Redis tier) so failures on `:hot` do not
 * trip the `:cold` path.
 */

class CircuitBreakerOpenError extends Error {
  constructor(key) {
    super(`Circuit breaker OPEN for "${key}"`);
    this.name = 'CircuitBreakerOpenError';
    this.code = 'CIRCUIT_OPEN';
    this.key = key;
  }
}

class CircuitBreaker {
  /**
   * @param {object} [opts]
   * @param {number} [opts.failureThreshold=3]  failures within window to trip open
   * @param {number} [opts.windowMs=10000]      rolling window for failure counting
   * @param {number} [opts.openDurationMs=20000] how long to stay open before half-open probe
   */
  constructor(opts = {}) {
    this.failureThreshold = opts.failureThreshold ?? 3;
    this.windowMs = opts.windowMs ?? 10_000;
    this.openDurationMs = opts.openDurationMs ?? 20_000;
    this.onStateChange = typeof opts.onStateChange === 'function' ? opts.onStateChange : () => {};
    // Per-key state: { state, failures:[ts], openedAt, halfOpenInFlight }
    this.state = new Map();
  }

  _getState(key) {
    let s = this.state.get(key);
    if (!s) {
      s = { state: 'closed', failures: [], openedAt: 0, halfOpenInFlight: false };
      this.state.set(key, s);
    }
    return s;
  }

  _transition(key, next, s) {
    if (s.state === next) return;
    const prev = s.state;
    s.state = next;
    if (next === 'open') s.openedAt = Date.now();
    if (next === 'closed') { s.failures = []; s.halfOpenInFlight = false; }
    if (next === 'half-open') s.halfOpenInFlight = false;
    try { this.onStateChange({ key, prev, next, at: Date.now() }); } catch { /* noop */ }
  }

  /** Current state for a key (after applying any time-based transitions). */
  inspect(key) {
    const s = this._getState(key);
    if (s.state === 'open' && (Date.now() - s.openedAt) >= this.openDurationMs) {
      this._transition(key, 'half-open', s);
    }
    return { state: s.state, failures: s.failures.length, openedAt: s.openedAt };
  }

  /**
   * Execute `fn()` guarded by the breaker keyed on `key`.
   * Throws CircuitBreakerOpenError without invoking `fn` when open.
   */
  async exec(key, fn) {
    const s = this._getState(key);

    if (s.state === 'open') {
      if ((Date.now() - s.openedAt) >= this.openDurationMs) {
        this._transition(key, 'half-open', s);
      } else {
        throw new CircuitBreakerOpenError(key);
      }
    }

    if (s.state === 'half-open') {
      if (s.halfOpenInFlight) {
        throw new CircuitBreakerOpenError(key);
      }
      s.halfOpenInFlight = true;
    }

    try {
      const result = await fn();
      if (s.state === 'half-open') {
        this._transition(key, 'closed', s);
      } else {
        // Drop old failures outside the window
        const cutoff = Date.now() - this.windowMs;
        s.failures = s.failures.filter(ts => ts >= cutoff);
      }
      return result;
    } catch (err) {
      if (s.state === 'half-open') {
        this._transition(key, 'open', s);
      } else {
        const now = Date.now();
        s.failures.push(now);
        s.failures = s.failures.filter(ts => ts >= now - this.windowMs);
        if (s.failures.length >= this.failureThreshold) {
          this._transition(key, 'open', s);
        }
      }
      throw err;
    } finally {
      if (s.state !== 'half-open') s.halfOpenInFlight = false;
    }
  }
}

module.exports = { CircuitBreaker, CircuitBreakerOpenError };
