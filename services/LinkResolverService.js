/**
 * LinkResolverService
 *
 * Thin proxy + caching layer in front of the cold-radar `/resolve` endpoint.
 * Used by the frontend to swap an `ad_gated` / `cpm_gated` redirector URL
 * (e.g. https://gadgetsweb.xyz/...) for the final downloadable URL on demand,
 * so the user never has to walk an ad-gate manually.
 *
 * Responsibilities:
 *   - Validate the input URL belongs to a known redirector host (defence-
 *     in-depth so this endpoint can't be abused as an open-redirect probe).
 *   - Short-circuit via an in-process LRU cache keyed by (intermediateUrl,
 *     forceFresh). Cold-radar already has its own PG-backed cache, but a
 *     local cache cuts the cross-service round-trip during peak views.
 *   - Forward to ${COLD_RADAR_URL}/resolve and surface the response.
 *   - Fail fast and clearly when COLD_RADAR_URL is unset or unreachable so
 *     the UI can render a helpful message rather than spinning forever.
 *
 * Configuration:
 *   COLD_RADAR_URL          base URL of the cold-radar service. Required
 *                            for resolution. Example: http://cold-radar:8080
 *   COLD_RADAR_TIMEOUT_MS    per-request timeout (default 12000ms, slightly
 *                            above the resolver's max-hops worst case).
 *   LINK_RESOLVE_CACHE_TTL_MS local cache TTL (default 10 min).
 *   LINK_RESOLVE_CACHE_MAX    local cache size cap (default 1024 entries).
 *
 * Production hardening notes (TODOs the user can opt in to):
 *   - Add Redis-backed cache so multiple backend replicas share a hot set.
 *   - Add per-IP rate limit (express-rate-limit) at the route level — already
 *     wired in linksRoutes.js with conservative defaults.
 *   - Switch COLD_RADAR_URL list -> array for active/passive failover.
 *   - Sign requests with a shared HMAC so cold-radar can refuse unknown
 *     callers when both services move off a private network.
 */

const axios = require('axios');
const logger = require('../config/logger');

const COLD_RADAR_URL = (process.env.COLD_RADAR_URL || '').replace(/\/+$/, '');
const TIMEOUT_MS = Number(process.env.COLD_RADAR_TIMEOUT_MS || 12000);
const CACHE_TTL_MS = Number(process.env.LINK_RESOLVE_CACHE_TTL_MS || 10 * 60 * 1000);
const CACHE_MAX = Number(process.env.LINK_RESOLVE_CACHE_MAX || 1024);

// Redirector / streaming hosts the cold-radar resolver knows how to walk.
// Keep in sync with `n8n/scrapers/cold-radar/app/hdhub4u/resolver.py`.
const ALLOWED_HOST_FRAGMENTS = [
  'hubdrive.', 'hubcdn.', 'gadgetsweb.', 'cryptoinsights.', 'hubcloud.',
  'hdstream4u.', 'hubstream.', '4khdhub.',
];

function hostOf(url) {
  const m = String(url || '').match(/^https?:\/\/([^\/?#:]+)/i);
  return m ? m[1].toLowerCase() : '';
}

function isAllowedHost(url) {
  const h = hostOf(url);
  if (!h) return false;
  return ALLOWED_HOST_FRAGMENTS.some((frag) => h.includes(frag));
}

class LRUCache {
  constructor(max) {
    this.max = max;
    this.map = new Map();
  }
  get(k) {
    if (!this.map.has(k)) return null;
    const v = this.map.get(k);
    // refresh recency
    this.map.delete(k);
    this.map.set(k, v);
    return v;
  }
  set(k, v) {
    if (this.map.has(k)) this.map.delete(k);
    this.map.set(k, v);
    if (this.map.size > this.max) {
      // delete oldest
      const oldest = this.map.keys().next().value;
      this.map.delete(oldest);
    }
  }
}

const cache = new LRUCache(CACHE_MAX);

class LinkResolverService {
  static get configured() {
    return Boolean(COLD_RADAR_URL);
  }

  static get coldRadarUrl() {
    return COLD_RADAR_URL;
  }

  static isAllowedHost(url) {
    return isAllowedHost(url);
  }

  /**
   * Resolve an intermediate (ad-gated) URL to its final downloadable URL.
   *
   * @param {object} opts
   * @param {string} opts.intermediateUrl  The redirector URL stored in catalog.
   * @param {boolean} [opts.forceFresh=false] Skip local + cold-radar caches.
   * @param {number} [opts.maxAgeSeconds]  Forwarded to cold-radar; controls
   *   how stale a PG-cached resolution may be before re-walking the chain.
   * @returns {Promise<{status, intermediateUrl, finalUrl, finalUrlHost, cached, resolvedAt, hopCount, error, source}>}
   */
  static async resolve({ intermediateUrl, forceFresh = false, maxAgeSeconds }) {
    if (typeof intermediateUrl !== 'string' || !/^https?:\/\//i.test(intermediateUrl)) {
      const err = new Error('invalid_intermediate_url');
      err.statusCode = 400;
      throw err;
    }
    if (!isAllowedHost(intermediateUrl)) {
      const err = new Error('host_not_allowed');
      err.statusCode = 400;
      err.detail = `Host '${hostOf(intermediateUrl)}' is not in the redirector allow-list`;
      throw err;
    }
    if (!COLD_RADAR_URL) {
      const err = new Error('cold_radar_not_configured');
      err.statusCode = 503;
      err.detail = 'Set COLD_RADAR_URL in the backend environment to enable on-demand link resolution.';
      throw err;
    }

    const cacheKey = intermediateUrl;
    if (!forceFresh) {
      const cached = cache.get(cacheKey);
      if (cached && cached.expiresAt > Date.now()) {
        return { ...cached.payload, source: 'media-radar-cache' };
      }
    }

    const body = { intermediateUrl, forceFresh: !!forceFresh };
    if (typeof maxAgeSeconds === 'number' && maxAgeSeconds > 0) {
      body.maxAgeSeconds = maxAgeSeconds;
    }

    const start = Date.now();
    let res;
    try {
      res = await axios.post(`${COLD_RADAR_URL}/resolve`, body, {
        timeout: TIMEOUT_MS,
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (e) {
      const elapsed = Date.now() - start;
      const upstream = e.response?.data;
      logger.warn('LinkResolver: cold-radar /resolve failed', {
        intermediateUrl,
        elapsedMs: elapsed,
        message: e.message,
        upstream,
      });
      const err = new Error('cold_radar_unavailable');
      err.statusCode = e.response?.status === 502 ? 502 : 504;
      err.detail = upstream?.detail || e.message;
      throw err;
    }

    const data = res.data || {};
    // Tag where the answer came from so the UI can show a "fresh vs cached"
    // hint without us leaking cold-radar's internal cache state.
    const payload = {
      status: data.status || 'unknown',
      intermediateUrl: data.intermediateUrl || intermediateUrl,
      finalUrl: data.finalUrl || null,
      finalUrlHost: data.finalUrlHost || null,
      cached: !!data.cached,
      resolvedAt: data.resolvedAt || null,
      hopCount: typeof data.hopCount === 'number' ? data.hopCount : null,
      error: data.error || null,
    };

    // Only cache resolved results. Gated/error states are usually transient
    // and should be retried on the next click.
    if (payload.status === 'resolved' && payload.finalUrl) {
      cache.set(cacheKey, { payload, expiresAt: Date.now() + CACHE_TTL_MS });
    }

    logger.info('LinkResolver: cold-radar /resolve ok', {
      intermediateUrl,
      status: payload.status,
      finalUrlHost: payload.finalUrlHost,
      hopCount: payload.hopCount,
      cached: payload.cached,
      elapsedMs: Date.now() - start,
    });

    return { ...payload, source: payload.cached ? 'cold-radar-cache' : 'cold-radar-live' };
  }

  static stats() {
    return {
      configured: LinkResolverService.configured,
      coldRadarUrl: COLD_RADAR_URL || null,
      timeoutMs: TIMEOUT_MS,
      cacheTtlMs: CACHE_TTL_MS,
      cacheSize: cache.map.size,
      cacheMax: CACHE_MAX,
    };
  }
}

module.exports = LinkResolverService;
