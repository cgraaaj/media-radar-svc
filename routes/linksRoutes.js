/**
 * Links Resolution API Routes
 *
 * POST /api/links/resolve
 *   Body: { intermediateUrl, forceFresh?, maxAgeSeconds? }
 *   Returns: { status, intermediateUrl, finalUrl, finalUrlHost, cached,
 *              resolvedAt, hopCount, error, source }
 *
 * GET  /api/links/health
 *   Diagnostics on whether COLD_RADAR_URL is wired up and local cache size.
 *
 * Used by the Download modal to swap an ad-gated redirector URL (e.g.
 * gadgetsweb.xyz) for the resolved Drive / workers.dev / pixeldrain URL when
 * the user clicks "Open" on a `cpm_gated` / `ad_gated` direct entry.
 *
 * Production hardening:
 *   - In-memory per-IP rate limit (token bucket) to protect cold-radar from
 *     a hostile or runaway client. 30 requests / minute / IP by default.
 *     Tune via LINK_RESOLVE_RPM. For multi-replica deployments, swap this
 *     for a Redis-backed limiter (e.g. rate-limit-redis) so the budget is
 *     shared across processes.
 *   - Body size cap is enforced by express.json() in server.js.
 *   - All errors are mapped to stable JSON shapes so the UI can render them.
 */

const express = require('express');
const router = express.Router();
const LinkResolverService = require('../services/LinkResolverService');
const logger = require('../config/logger');

const RPM = Number(process.env.LINK_RESOLVE_RPM || 30);
const WINDOW_MS = 60 * 1000;

const buckets = new Map(); // ip -> { count, windowStart }

function rateLimit(req, res, next) {
  const ip = (req.headers['x-forwarded-for'] || req.ip || req.connection?.remoteAddress || 'unknown')
    .toString()
    .split(',')[0]
    .trim();
  const now = Date.now();
  const b = buckets.get(ip);
  if (!b || now - b.windowStart > WINDOW_MS) {
    buckets.set(ip, { count: 1, windowStart: now });
    return next();
  }
  if (b.count >= RPM) {
    res.set('Retry-After', Math.ceil((WINDOW_MS - (now - b.windowStart)) / 1000));
    return res.status(429).json({
      error: 'rate_limited',
      message: `Too many resolve requests. Limit: ${RPM}/min/IP.`,
    });
  }
  b.count += 1;
  return next();
}

router.post('/resolve', rateLimit, async (req, res) => {
  const { intermediateUrl, forceFresh, maxAgeSeconds } = req.body || {};
  try {
    const result = await LinkResolverService.resolve({
      intermediateUrl,
      forceFresh: !!forceFresh,
      maxAgeSeconds,
    });
    return res.json(result);
  } catch (err) {
    const code = err.statusCode || 500;
    const body = {
      error: err.message || 'resolve_failed',
      detail: err.detail || undefined,
    };
    if (code >= 500) {
      logger.error('Link resolve failed', { intermediateUrl, error: err.message, code });
    }
    return res.status(code).json(body);
  }
});

router.get('/health', (_req, res) => {
  res.json(LinkResolverService.stats());
});

module.exports = router;
