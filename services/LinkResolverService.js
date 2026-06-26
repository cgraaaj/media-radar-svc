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
const KNOWN_HOSTS_REFRESH_MS = Number(process.env.LINK_RESOLVE_HOSTS_REFRESH_MS || 5 * 60 * 1000);

/**
 * Redirector host allow-list.
 *
 * Source of truth is cold-radar's GET /known-hosts endpoint, fetched at
 * startup and on a periodic refresh. The hard-coded fallback below is the
 * conservative baseline used (a) until the first successful fetch, and
 * (b) if cold-radar is unreachable.
 *
 * Why dynamic: on 2026-05-06 we shipped a `hblinks.dad` parser in
 * cold-radar but forgot to add it here. Every user-initiated /resolve
 * for an hblinks intermediate URL was rejected with 400 host_not_allowed,
 * the frontend's catch block fell back to opening the ad page directly,
 * and the user complained their downloads "kept resolving to another
 * ad-gated link". The dynamic fetch eliminates this entire class of
 * "two services, two allow-lists" drift bugs.
 */
const FALLBACK_ALLOWED_HOST_FRAGMENTS = Object.freeze([
  'hubdrive.', 'hubcdn.', 'gadgetsweb.', 'cryptoinsights.', 'hubcloud.',
  'hdstream4u.', 'hubstream.', '4khdhub.', 'hblinks.', 'hubrouting.',
  'gamerxyt.',
]);

let allowedHostFragments = [...FALLBACK_ALLOWED_HOST_FRAGMENTS];
let lastHostsFetch = { at: 0, ok: false, error: null, source: 'fallback' };

function hostOf(url) {
  const m = String(url || '').match(/^https?:\/\/([^\/?#:]+)/i);
  return m ? m[1].toLowerCase() : '';
}

function isAllowedHost(url) {
  const h = hostOf(url);
  if (!h) return false;
  return allowedHostFragments.some((frag) => h.includes(frag));
}

async function refreshAllowedHosts({ logger } = {}) {
  if (!COLD_RADAR_URL) {
    return { ok: false, error: 'cold_radar_not_configured' };
  }
  try {
    const { data } = await axios.get(`${COLD_RADAR_URL}/known-hosts`, { timeout: 5000 });
    const next = Array.isArray(data?.hostFragments)
      ? data.hostFragments.filter((s) => typeof s === 'string' && s.length > 1)
      : null;
    if (!next || next.length === 0) {
      throw new Error('cold-radar /known-hosts returned no fragments');
    }
    // Always merge in the fallback so a cold-radar misconfiguration can
    // never SHRINK the allow-list below what we know is safe to walk.
    const merged = Array.from(new Set([...next, ...FALLBACK_ALLOWED_HOST_FRAGMENTS])).sort();
    const changed = JSON.stringify(merged) !== JSON.stringify(allowedHostFragments);
    allowedHostFragments = merged;
    lastHostsFetch = {
      at: Date.now(),
      ok: true,
      error: null,
      source: 'cold-radar',
      count: merged.length,
      coldRadarVersion: data?.codeVersion || null,
    };
    if (changed && logger) {
      logger.info('LinkResolver: allow-list synced from cold-radar', {
        count: merged.length,
        coldRadarVersion: data?.codeVersion,
        fragments: merged,
      });
    }
    return { ok: true, count: merged.length, changed };
  } catch (e) {
    lastHostsFetch = {
      at: Date.now(),
      ok: false,
      error: e.message,
      source: allowedHostFragments === FALLBACK_ALLOWED_HOST_FRAGMENTS ? 'fallback' : 'last-good',
    };
    if (logger) logger.warn('LinkResolver: known-hosts fetch failed', { error: e.message });
    return { ok: false, error: e.message };
  }
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
      // On-demand refresh: the allow-list cache may be stale because
      // cold-radar shipped a new parser since our last poll. Trigger a
      // refresh and re-check ONCE before giving up. This shrinks the
      // mean-time-to-recovery for new-parser rollouts from "next
      // periodic refresh" (5min default) to "next user click".
      try {
        const refresh = await refreshAllowedHosts({ logger });
        if (refresh.ok && isAllowedHost(intermediateUrl)) {
          logger.info('LinkResolver: host became allowed after on-demand refresh', {
            host: hostOf(intermediateUrl),
          });
        } else {
          const err = new Error('host_not_allowed');
          err.statusCode = 400;
          err.detail = `Host '${hostOf(intermediateUrl)}' is not in the redirector allow-list (refreshed ${refresh.ok ? 'ok' : 'failed: ' + refresh.error}; ${allowedHostFragments.length} fragments known)`;
          throw err;
        }
      } catch (refreshErr) {
        if (refreshErr.statusCode) throw refreshErr;
        const err = new Error('host_not_allowed');
        err.statusCode = 400;
        err.detail = `Host '${hostOf(intermediateUrl)}' is not in the redirector allow-list (refresh attempt errored: ${refreshErr.message})`;
        throw err;
      }
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
      // Live manual-walk target for gated statuses (see cold-radar
      // ResolveResponse.gatedUrl). Lets the frontend open a page that works in
      // the user's browser instead of the captured-but-dead intermediate.
      gatedUrl: data.gatedUrl || null,
      gatedUrlHost: data.gatedUrlHost || null,
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
      allowList: {
        fragments: [...allowedHostFragments],
        count: allowedHostFragments.length,
        lastFetch: { ...lastHostsFetch },
        refreshIntervalMs: KNOWN_HOSTS_REFRESH_MS,
      },
    };
  }

  /**
   * Boot the service: fetch the allow-list from cold-radar, then start a
   * periodic refresh. Safe to call multiple times — the timer is stored
   * on the function object so a re-init just resets it. Tolerates
   * cold-radar being briefly unreachable (falls back to the baked-in
   * fragments and keeps trying in the background).
   */
  static async init({ logger: log = logger } = {}) {
    if (!COLD_RADAR_URL) {
      log.warn('LinkResolver: COLD_RADAR_URL not set — allow-list locked to baked-in fallback');
      return;
    }
    await refreshAllowedHosts({ logger: log });
    if (LinkResolverService._timer) clearInterval(LinkResolverService._timer);
    LinkResolverService._timer = setInterval(
      () => { refreshAllowedHosts({ logger: log }).catch(() => {}); },
      KNOWN_HOSTS_REFRESH_MS,
    );
    // Don't keep the event loop alive just for this poller.
    if (LinkResolverService._timer.unref) LinkResolverService._timer.unref();
  }

  static async refreshHosts() {
    return refreshAllowedHosts({ logger });
  }

  /**
   * User-driven recheck of an EXPIRED row.
   *
   * Forwards to cold-radar's POST /recheck which:
   *   1. Looks up the link's parent post URL.
   *   2. Re-fetches that post page once.
   *   3. Re-parses + re-resolves all anchors, ingests anything new.
   *   4. Returns counts so the UI can decide whether to refresh.
   *
   * Why this is a separate path from /resolve:
   *   * /resolve walks one intermediate URL — already known dead, so re-
   *     walking it is a no-op. The interesting question is "did upstream
   *     re-upload under the SAME post URL with NEW file IDs?" — that's
   *     a post-page recrawl, not a link recrawl.
   *   * Synchronous on purpose: the user is staring at a spinner, so the
   *     response carries the actual newLinks count rather than queuing
   *     fire-and-forget work like the /resolve auto-recovery does.
   *   * Cheap: one upstream request to hdhub4u + parse. Bounded by the
   *     route-level rate limit in linksRoutes.js.
   *
   * Caveats / non-goals:
   *   * Only works for hdhub4u catalog rows (1tamilmv files don't have a
   *     re-walkable parent post — each magnet is its own forum thread).
   *     Cold-radar returns ``{found: false, error: 'post_url_missing_or_unsupported'}``.
   *   * Doesn't refresh Redis cache. The next hot/cold sweep (or a
   *     manual /admin/materialize) picks up the new rows.
   */
  static async recheck({ intermediateUrl }) {
    if (typeof intermediateUrl !== 'string' || !/^https?:\/\//i.test(intermediateUrl)) {
      const err = new Error('invalid_intermediate_url');
      err.statusCode = 400;
      throw err;
    }
    if (!COLD_RADAR_URL) {
      const err = new Error('cold_radar_not_configured');
      err.statusCode = 503;
      err.detail = 'Set COLD_RADAR_URL in the backend environment to enable upstream recheck.';
      throw err;
    }

    const start = Date.now();
    let res;
    try {
      res = await axios.post(
        `${COLD_RADAR_URL}/recheck`,
        { intermediateUrl },
        {
          timeout: Math.max(TIMEOUT_MS, 20000),
          headers: { 'Content-Type': 'application/json' },
        },
      );
    } catch (e) {
      const elapsed = Date.now() - start;
      const upstream = e.response?.data;
      logger.warn('LinkResolver: cold-radar /recheck failed', {
        intermediateUrl, elapsedMs: elapsed, message: e.message, upstream,
      });
      const err = new Error('cold_radar_unavailable');
      err.statusCode = e.response?.status === 502 ? 502 : 504;
      err.detail = upstream?.detail || e.message;
      throw err;
    }

    const data = res.data || {};
    const payload = {
      found: !!data.found,
      postUrl: data.postUrl || null,
      newLinks: typeof data.newLinks === 'number' ? data.newLinks : 0,
      movies: typeof data.movies === 'number' ? data.movies : 0,
      tvshows: typeof data.tvshows === 'number' ? data.tvshows : 0,
      error: data.error || null,
    };

    logger.info('LinkResolver: cold-radar /recheck ok', {
      intermediateUrl,
      ...payload,
      elapsedMs: Date.now() - start,
    });

    return payload;
  }
}

module.exports = LinkResolverService;
