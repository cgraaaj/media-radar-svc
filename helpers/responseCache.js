const crypto = require('crypto');

/**
 * LRU-ish response cache with TTL + stale-while-revalidate semantics.
 *
 * Why this exists
 * ---------------
 * The Media Radar hot path does a lot of per-request work that rarely changes
 * between successive calls with identical params:
 *   1. JSON.parse of a ~1-2 MB Redis blob
 *   2. Filtering / pagination across thousands of entries
 *   3. MediaService.transformMediaEntries -> TMDB + OMDB API calls
 * Step #3 is the expensive one (network I/O, rate-limited) and it is fully
 * deterministic for a given (tier, endpoint, params) tuple for the lifetime
 * of the underlying Redis blob (i.e. its `metadata.lastUpdated`).
 *
 * We therefore memoize the *final* controller response keyed by a canonical
 * request key, with a fresh-TTL and a longer stale-TTL. Fresh entries are
 * served immediately; stale-but-not-expired entries are served immediately
 * AND a background refresh is triggered (stale-while-revalidate). This is a
 * classic CDN pattern applied in-process.
 *
 * Sizing:
 *   - default maxEntries=200. Each entry is one API response (~a few KB up
 *     to ~200 KB for a full page with TMDB enrichment).
 *   - Total memory bound: ~40 MB worst case. Acceptable for a single backend.
 *
 * Not thread-safe across processes; that's by design. For multi-replica
 * deployments put this behind a shared cache (e.g. Redis `SET NX EX`) or
 * rely on a proper CDN upstream.
 */

class ResponseCache {
  /**
   * @param {object} [opts]
   * @param {number} [opts.maxEntries=200]
   * @param {number} [opts.freshTtlMs=15_000]  how long a response is considered fresh
   * @param {number} [opts.staleTtlMs=60_000]  how long stale entries are served while revalidating
   */
  constructor(opts = {}) {
    this.maxEntries = opts.maxEntries ?? 200;
    this.freshTtlMs = opts.freshTtlMs ?? 15_000;
    this.staleTtlMs = opts.staleTtlMs ?? 60_000;
    this.store = new Map(); // key -> { etag, payload, cachedAt, version, tier }
    this.inflight = new Map(); // key -> Promise (dedupe concurrent misses)
    this.stats = { hits: 0, misses: 0, stale: 0, revalidated: 0, evicted: 0 };
  }

  /** Build a canonical cache key from a plain params object. */
  static buildKey(namespace, params) {
    const keys = Object.keys(params || {}).sort();
    const flat = keys.map(k => {
      const v = params[k];
      if (v === undefined || v === null || v === '') return `${k}=`;
      return `${k}=${String(v)}`;
    }).join('&');
    return `${namespace}?${flat}`;
  }

  /** ETag = sha1(tier-version || payload-fingerprint). Weak ETag. */
  static buildEtag({ tier, version, payload }) {
    const material = [tier || '', version || '', JSON.stringify(payload ?? '')].join('|');
    const hash = crypto.createHash('sha1').update(material).digest('hex').slice(0, 16);
    return `W/"${hash}"`;
  }

  _touch(key, entry) {
    // Re-insert to move to tail (LRU "recently used" tracking).
    this.store.delete(key);
    this.store.set(key, entry);
  }

  _evictIfNeeded() {
    while (this.store.size > this.maxEntries) {
      const oldestKey = this.store.keys().next().value;
      if (!oldestKey) break;
      this.store.delete(oldestKey);
      this.stats.evicted++;
    }
  }

  /**
   * Attempt to serve `key` from cache. Returns:
   *   { hit: true,  fresh: true,  payload, etag, ageMs }
   *   { hit: true,  fresh: false, payload, etag, ageMs }    // stale-while-revalidate
   *   { hit: false }
   *
   * `version` should change whenever the underlying source (Redis blob) is
   * updated — we use `metadata.lastUpdated`. When the caller's version
   * differs from the cached version, we force a miss.
   */
  peek(key, version) {
    const entry = this.store.get(key);
    if (!entry) return { hit: false };
    if (version && entry.version && entry.version !== version) {
      this.store.delete(key);
      return { hit: false };
    }
    const age = Date.now() - entry.cachedAt;
    if (age > this.staleTtlMs) {
      this.store.delete(key);
      return { hit: false };
    }
    this._touch(key, entry);
    return {
      hit: true,
      fresh: age <= this.freshTtlMs,
      payload: entry.payload,
      etag: entry.etag,
      ageMs: age,
      tier: entry.tier,
      version: entry.version,
    };
  }

  set(key, payload, meta = {}) {
    const etag = meta.etag || ResponseCache.buildEtag({
      tier: meta.tier,
      version: meta.version,
      payload,
    });
    const entry = {
      etag,
      payload,
      cachedAt: Date.now(),
      version: meta.version || null,
      tier: meta.tier || null,
    };
    this.store.set(key, entry);
    this._evictIfNeeded();
    return entry;
  }

  /**
   * Run the loader unconditionally (cache bypass). Still computes a proper
   * ETag over the real payload so conditional requests (If-None-Match) work.
   * Does NOT store the result — use this for `?noCache=1`.
   */
  async runBypass(loader, meta = {}) {
    const payload = await loader();
    const etag = ResponseCache.buildEtag({ tier: meta.tier, version: meta.version, payload });
    return {
      hit: false,
      fresh: true,
      payload,
      etag,
      ageMs: 0,
      tier: meta.tier || null,
      version: meta.version || null,
      source: 'origin',
    };
  }

  /**
   * Fetch-through: single-flight wrapper that coalesces concurrent misses
   * and handles stale-while-revalidate transparently.
   */
  async get(key, loader, meta = {}) {
    const peeked = this.peek(key, meta.version);
    if (peeked.hit) {
      this.stats.hits++;
      if (!peeked.fresh) {
        this.stats.stale++;
        // Fire-and-forget background refresh
        this._revalidate(key, loader, meta);
      }
      return { ...peeked, source: 'cache' };
    }

    this.stats.misses++;

    // Single-flight: if another request is already loading this key, await it.
    if (this.inflight.has(key)) {
      const shared = await this.inflight.get(key);
      return { hit: true, fresh: true, ...shared, source: 'inflight' };
    }

    const promise = (async () => {
      const payload = await loader();
      const entry = this.set(key, payload, meta);
      return { payload, etag: entry.etag, version: entry.version, tier: entry.tier, ageMs: 0 };
    })();

    this.inflight.set(key, promise);
    try {
      const res = await promise;
      return { hit: false, fresh: true, ...res, source: 'origin' };
    } finally {
      this.inflight.delete(key);
    }
  }

  _revalidate(key, loader, meta) {
    if (this.inflight.has(key)) return; // already being refreshed
    const p = (async () => {
      try {
        const payload = await loader();
        this.set(key, payload, meta);
        this.stats.revalidated++;
      } catch (err) {
        // Swallow - caller already got a stale response. Log at debug level.
        if (process.env.NODE_ENV !== 'production') {
          console.warn(`[ResponseCache] revalidation failed for ${key}: ${err.message}`);
        }
      } finally {
        this.inflight.delete(key);
      }
    })();
    this.inflight.set(key, p);
  }

  /** Wipe all entries whose key starts with `prefix`. Returns count removed. */
  invalidatePrefix(prefix) {
    let n = 0;
    for (const k of this.store.keys()) {
      if (k.startsWith(prefix)) { this.store.delete(k); n++; }
    }
    return n;
  }

  clear() {
    const n = this.store.size;
    this.store.clear();
    this.inflight.clear();
    return n;
  }

  snapshot() {
    return {
      size: this.store.size,
      maxEntries: this.maxEntries,
      freshTtlMs: this.freshTtlMs,
      staleTtlMs: this.staleTtlMs,
      stats: { ...this.stats },
    };
  }
}

module.exports = ResponseCache;
