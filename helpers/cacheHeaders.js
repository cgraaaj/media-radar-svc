/**
 * HTTP cache plumbing for tiered media responses.
 *
 * Goals:
 *   - Advertise which Redis tier served the response (`X-Cache-Tier`) so
 *     ops/debuggers can trace cache behaviour without reading JSON bodies.
 *   - Emit a weak `ETag` so browsers/CDNs can `If-None-Match` + 304.
 *   - Set `Cache-Control` appropriate to the tier:
 *       * hot    -> short max-age (minutes), stale-while-revalidate (minutes)
 *       * cold   -> long max-age (hours),    stale-while-revalidate (hours)
 *       * warm   -> middle ground
 *   - Never cache responses that contain user-specific or error data.
 *
 * Usage:
 *   res.setTierCache({ tier, cacheKey, version, etag, source, ageMs })
 *   -> returns true if a 304 was dispatched (caller should not send a body).
 */

// Per-tier cache budgets. Tuned to be conservative.
const TIER_POLICY = {
  hot:    { maxAge: 60,    swr: 120 },  // 1 min fresh + 2 min stale
  warm:   { maxAge: 300,   swr: 900 },  // 5 min fresh + 15 min stale
  cold:   { maxAge: 1800,  swr: 7200 }, // 30 min fresh + 2 h stale
  legacy: { maxAge: 300,   swr: 600 },  // 5 min fresh + 10 min stale
};

function applyTierHeaders(req, res, ctx = {}) {
  const {
    tier,
    cacheKey,
    version,      // e.g. metadata.lastUpdated
    etag,
    source,       // 'cache' | 'origin' | 'inflight'
    ageMs,
    breakerState, // 'closed' | 'open' | 'half-open'
    servedFromFallback,
  } = ctx;

  if (tier) res.setHeader('X-Cache-Tier', tier);
  if (cacheKey) res.setHeader('X-Cache-Key', cacheKey);
  if (version) res.setHeader('X-Cache-Version', version);
  if (source) res.setHeader('X-Cache-Source', source); // app-cache hit/miss
  if (typeof ageMs === 'number') res.setHeader('X-Cache-Age-Ms', Math.max(0, Math.round(ageMs)).toString());
  if (breakerState) res.setHeader('X-Breaker-State', breakerState);
  if (servedFromFallback) res.setHeader('X-Cache-Fallback', '1');

  const policy = TIER_POLICY[tier] || TIER_POLICY.legacy;
  res.setHeader(
    'Cache-Control',
    `public, max-age=${policy.maxAge}, stale-while-revalidate=${policy.swr}`
  );
  res.setHeader('Vary', 'Accept-Encoding, X-Cache-Tier');

  if (etag) {
    res.setHeader('ETag', etag);
    const inm = req.headers['if-none-match'];
    if (inm) {
      // Accept a comma-separated list of ETag values per RFC7232.
      const tokens = inm.split(',').map(t => t.trim());
      if (tokens.includes(etag) || tokens.includes('*')) {
        res.status(304).end();
        return true;
      }
    }
  }
  return false;
}

module.exports = { applyTierHeaders, TIER_POLICY };
