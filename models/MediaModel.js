const db = require('../config/database');
const { CircuitBreaker, CircuitBreakerOpenError } = require('../helpers/circuitBreaker');

// ---------------------------------------------------------------------------
// Cache schema (produced by the unified crawler, version >= 3.0)
//
//   {
//     movies: {
//       "Title (YEAR)": {
//         type: "movie",
//         year: 2025,
//         posterUrl: "https://…",
//         sources: ["hdhub4u" | "1tamilmv", …],
//         firstSeenAt, lastUpdatedAt,
//         qualities: {
//           "4k" | "1080p" | "720p" | "480p": {
//             direct:  [ {source, kind:"direct",  filename, size, status, finalUrl, originalUrl, postUrl, postTitle, host, label, posterUrl, mime, shareDate, …} ],
//             torrent: [ {source, kind:"torrent", torrentUrl, filename, size, language:[…], pageTitle, posterUrl, addedAt, …} ],
//             magnet:  [ {source, kind:"magnet",  magnet,      filename, size, language:[…], pageTitle, posterUrl, addedAt, …} ]
//           }
//         }
//       }
//     },
//     tvshows: { /* same shape */ },
//     sections: { oneTamilMv: { "TOP RELEASES THIS WEEK":[…], "RECENTLY ADDED":[…], extractedAt } },
//     metadata: { source, lastUpdated, expiresAt, stats:{…} }
//   }
//
// This model is written to be **tolerant** of the older flat schema
// (`qualityData = { "1080p":[files], … }`) so an incremental rollout does not
// break running deployments.
// ---------------------------------------------------------------------------

const SUPPORTED_SOURCES = ['hdhub4u', '1tamilmv'];
const QUALITY_ORDER = { '4k': 4, '1080p': 3, '720p': 2, '480p': 1, 'others': 0 };

// ---------------------------------------------------------------------------
// Cache tiering (hot / cold)
//
//   media_radar_cache:hot   -> short-TTL (~3h) fresh release pool. Powers the
//                              "Latest" surfaces: Top Releases, Recently Added.
//   media_radar_cache:cold  -> long-TTL (~7d) broader catalog. Powers the
//                              "All Movies" / "All TV Shows" paginated grid.
//   media_radar_cache       -> legacy unified key; kept as a last-resort
//                              fallback so a missing :hot / :cold blob does
//                              not black-hole the UI.
// ---------------------------------------------------------------------------
const CACHE_KEYS = {
  hot: 'media_radar_cache:hot',
  cold: 'media_radar_cache:cold',
  legacy: 'media_radar_cache',
};
// `warm` is a virtual tier composed by the app as hot ∪ cold dedup'd.
// It has no dedicated Redis key.
const VIRTUAL_TIERS = new Set(['warm']);
const VALID_TIERS = new Set(['hot', 'cold', 'legacy', 'warm']);
const BLOB_MEMO_TTL_MS = 5 * 1000; // tiny in-process memo to avoid reparsing ~2MB JSON on every request

class MediaModel {
  constructor() {
    // Kept for backwards-compat (referenced by some scripts/diagnostics). The
    // tiered logic below does NOT consult this value — it uses CACHE_KEYS.
    this.cacheKey = process.env.REDIS_CACHE_KEY || CACHE_KEYS.legacy;
    this._blobMemo = new Map(); // tier -> { ts, data }

    // Per-tier circuit breaker. A failing `:hot` must not starve `:cold`.
    // Tunable via env for ops; sensible defaults for a small service.
    this._breaker = new CircuitBreaker({
      failureThreshold: parseInt(process.env.REDIS_BREAKER_FAILURES || '3', 10),
      windowMs: parseInt(process.env.REDIS_BREAKER_WINDOW_MS || '10000', 10),
      openDurationMs: parseInt(process.env.REDIS_BREAKER_OPEN_MS || '20000', 10),
      onStateChange: ({ key, prev, next }) => {
        console.warn(`[MediaModel] circuit breaker ${key}: ${prev} -> ${next}`);
      },
    });
  }

  /** Resolve an incoming tier hint to one of `hot|cold|legacy|warm`. */
  resolveTier(tier, fallback = 'cold') {
    if (!tier) return fallback;
    const t = String(tier).toLowerCase();
    return VALID_TIERS.has(t) ? t : fallback;
  }

  cacheKeyForTier(tier) {
    const resolved = this.resolveTier(tier);
    if (resolved === 'warm') return 'media_radar_cache:warm'; // virtual
    return CACHE_KEYS[resolved] || CACHE_KEYS.legacy;
  }

  /** Expose breaker inspection for /health and diagnostics. */
  breakerStatus() {
    const out = {};
    for (const tier of Object.keys(CACHE_KEYS)) {
      out[tier] = this._breaker.inspect(tier);
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // Schema helpers
  // -------------------------------------------------------------------------

  /**
   * Returns the nested `{ "4k": {direct,torrent,magnet}, … }` quality map for
   * an entry regardless of the schema version. Old flat entries are returned
   * as-is so downstream callers can still iterate them.
   */
  getQualityMap(entry) {
    if (!entry || typeof entry !== 'object') return {};
    if (entry.qualities && typeof entry.qualities === 'object') return entry.qualities;
    return entry;
  }

  /** Returns the sources declared on a wrapped entry (or [] for legacy). */
  getEntrySources(entry) {
    if (!entry || typeof entry !== 'object') return [];
    if (Array.isArray(entry.sources)) return entry.sources.filter(Boolean);
    return [];
  }

  /**
   * Flattens the quality bucket into a single file array. Works for both new
   * `{direct,torrent,magnet}` shape and legacy arrays.
   */
  flattenBucket(bucket) {
    if (!bucket) return [];
    if (Array.isArray(bucket)) return bucket;
    if (typeof bucket !== 'object') return [];
    const out = [];
    for (const kind of ['direct', 'torrent', 'magnet']) {
      if (Array.isArray(bucket[kind])) out.push(...bucket[kind]);
    }
    return out;
  }

  /** Unique id used for de-duplication across source+kind. */
  fileDedupId(file) {
    if (!file || typeof file !== 'object') return null;
    if (file.kind === 'magnet' && file.magnet) {
      const m = file.magnet.match(/btih:([a-fA-F0-9]{40})/i);
      if (m) return `magnet:${m[1].toLowerCase()}`;
    }
    if (file.kind === 'torrent' && file.torrentUrl) {
      return `torrent:${file.torrentUrl}`;
    }
    if (file.kind === 'direct') {
      return `direct:${file.finalUrl || file.originalUrl || file.href || file.filename || ''}`;
    }
    // Legacy fallback (pre-v3 schema)
    const magnet = file.magnetLink || file.magnet_link || '';
    const m = magnet.match(/btih:([a-fA-F0-9]{40})/i);
    if (m) return `magnet:${m[1].toLowerCase()}`;
    return `legacy:${file.href || file.filename || JSON.stringify(file)}`;
  }

  /** Total number of files across all qualities/kinds in an entry. */
  countFiles(entry) {
    const qmap = this.getQualityMap(entry);
    let n = 0;
    for (const bucket of Object.values(qmap || {})) {
      n += this.flattenBucket(bucket).length;
    }
    return n;
  }

  /** Does `entry` contain anything from `source`? (Falls back to scanning files.) */
  entryMatchesSource(entry, source) {
    if (!source || source === 'all') return true;
    const declared = this.getEntrySources(entry);
    if (declared.length > 0) return declared.includes(source);
    // Legacy: look at file.source
    const qmap = this.getQualityMap(entry);
    for (const bucket of Object.values(qmap || {})) {
      for (const file of this.flattenBucket(bucket)) {
        if (file && file.source === source) return true;
      }
    }
    return false;
  }

  // -------------------------------------------------------------------------
  // Deduplication
  // -------------------------------------------------------------------------

  /** Deduplicate files within a flat array by their canonical id. */
  deduplicateFiles(files) {
    if (!Array.isArray(files)) return files;
    const seen = new Set();
    const out = [];
    for (const file of files) {
      if (!file) continue;
      const id = this.fileDedupId(file);
      if (id && seen.has(id)) continue;
      if (id) seen.add(id);
      out.push(file);
    }
    return out;
  }

  /**
   * Returns the entry's quality map with each quality de-duplicated.
   * For new schema we keep the `{direct,torrent,magnet}` shape; for the legacy
   * flat array we dedupe in place.
   */
  deduplicateQualityData(qualityData) {
    if (!qualityData || typeof qualityData !== 'object') return qualityData;
    const out = {};
    for (const [quality, bucket] of Object.entries(qualityData)) {
      if (Array.isArray(bucket)) {
        out[quality] = this.deduplicateFiles(bucket);
      } else if (bucket && typeof bucket === 'object') {
        out[quality] = {
          direct: this.deduplicateFiles(bucket.direct || []),
          torrent: this.deduplicateFiles(bucket.torrent || []),
          magnet: this.deduplicateFiles(bucket.magnet || []),
        };
      } else {
        out[quality] = bucket;
      }
    }
    return out;
  }

  /** Source-aware clone: strip out files not matching the requested source. */
  filterEntryBySource(entry, source) {
    if (!source || source === 'all') return entry;
    const qmap = this.getQualityMap(entry);
    const filteredQualities = {};
    for (const [quality, bucket] of Object.entries(qmap || {})) {
      if (Array.isArray(bucket)) {
        const files = bucket.filter(f => f && (!f.source || f.source === source));
        if (files.length > 0) filteredQualities[quality] = files;
      } else if (bucket && typeof bucket === 'object') {
        const filtered = {
          direct: (bucket.direct || []).filter(f => f && f.source === source),
          torrent: (bucket.torrent || []).filter(f => f && f.source === source),
          magnet: (bucket.magnet || []).filter(f => f && f.source === source),
        };
        if (filtered.direct.length || filtered.torrent.length || filtered.magnet.length) {
          filteredQualities[quality] = filtered;
        }
      }
    }

    // Preserve wrapper metadata if present.
    if (entry && typeof entry === 'object' && entry.qualities) {
      return {
        ...entry,
        qualities: filteredQualities,
        sources: this.getEntrySources(entry).filter(s => s === source),
      };
    }
    return filteredQualities;
  }

  // -------------------------------------------------------------------------
  // Redis fetch
  // -------------------------------------------------------------------------

  /**
   * Fetch the raw unified blob for a tier. Falls back gracefully:
   *   hot -> cold -> legacy
   *   cold -> legacy -> hot
   *   legacy -> cold -> hot
   * so that a missing :hot or :cold key (e.g. during the cold crawler's first
   * run) never surfaces as an empty UI.
   *
   * Uses a short in-process memo (BLOB_MEMO_TTL_MS) because the cold blob is
   * ~1.1MB and repeatedly JSON.parse()'ing it per request is wasteful.
   */
  async getAllMedia(tier = 'cold') {
    if (!db.isConnected()) {
      throw new Error('Redis is not connected');
    }

    const resolved = this.resolveTier(tier);

    // Virtual tier: merge hot ∪ cold on the fly. If one side is down the
    // other is used as-is. Both sides memo'd individually so the union is
    // cheap on repeated calls.
    if (resolved === 'warm') {
      return this._getWarmBlob();
    }

    const order = resolved === 'hot'
      ? ['hot', 'cold', 'legacy']
      : resolved === 'cold'
        ? ['cold', 'legacy', 'hot']
        : ['legacy', 'cold', 'hot'];

    let lastErr = null;
    for (const t of order) {
      try {
        const data = await this._fetchBlobForTier(t);
        if (data) {
          if (t !== resolved) {
            console.warn(`[MediaModel] tier=${resolved} unavailable, served from ${t} (${CACHE_KEYS[t]})`);
          }
          // Stamp the effective tier so downstream code/UI can tell.
          if (typeof data === 'object' && data !== null && !Array.isArray(data)) {
            data.__tier = t;
            data.__cacheKey = CACHE_KEYS[t];
          }
          return data;
        }
      } catch (err) {
        lastErr = err;
        // If breaker is open for this tier, keep walking the fallback chain.
        if (err instanceof CircuitBreakerOpenError) continue;
      }
    }
    throw lastErr || new Error('No media data found in cache (all tiers empty)');
  }

  async _fetchBlobForTier(tier) {
    const key = CACHE_KEYS[tier];
    if (!key) return null;

    const memo = this._blobMemo.get(tier);
    if (memo && (Date.now() - memo.ts) < BLOB_MEMO_TTL_MS) {
      return memo.data;
    }

    // Guard the actual Redis GET + JSON.parse with the breaker. Parse errors
    // count as failures, which is what we want — a corrupt blob should trip
    // the breaker and let us fail over to another tier.
    return this._breaker.exec(tier, async () => {
      const raw = await db.redisClient.get(key);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      this._blobMemo.set(tier, { ts: Date.now(), data: parsed });
      return parsed;
    });
  }

  // -------------------------------------------------------------------------
  // Warm tier — app-side union of hot ∪ cold
  //
  // Semantics:
  //   - movies / tvshows:    hot wins on title-key collisions for top-level
  //                          wrapper metadata (type/year/posterUrl/sources),
  //                          BUT qualities/files are unioned with dedup so we
  //                          keep every link we know about.
  //   - sections.oneTamilMv: hot's sections are preferred (they're the
  //                          curated fresh list); cold's are only used when
  //                          hot has none.
  //   - metadata:            hot metadata is surfaced as the "primary" (it's
  //                          freshest). Cold metadata is exposed under
  //                          `metadata.coldOverlay` for diagnostics.
  //
  // Cost: one-time merge per ~5s (the blob memo window). Repeated warm reads
  // within that window hit the memoized merge result.
  // -------------------------------------------------------------------------
  async _getWarmBlob() {
    const memo = this._blobMemo.get('warm');
    if (memo && (Date.now() - memo.ts) < BLOB_MEMO_TTL_MS) {
      return memo.data;
    }

    // Fetch both tiers in parallel. Tolerate either side being down.
    const [hot, cold] = await Promise.all([
      this._fetchBlobForTier('hot').catch(err => { console.warn('[warm] hot fetch failed:', err.message); return null; }),
      this._fetchBlobForTier('cold').catch(err => { console.warn('[warm] cold fetch failed:', err.message); return null; }),
    ]);

    if (!hot && !cold) {
      // Try legacy as a last resort
      const legacy = await this._fetchBlobForTier('legacy').catch(() => null);
      if (!legacy) throw new Error('Warm tier unavailable: hot, cold, and legacy are all empty');
      legacy.__tier = 'warm';
      legacy.__cacheKey = 'media_radar_cache:warm';
      legacy.__composition = { hot: false, cold: false, legacy: true };
      return legacy;
    }

    const merged = this._mergeHotCold(hot, cold);
    merged.__tier = 'warm';
    merged.__cacheKey = 'media_radar_cache:warm';
    merged.__composition = { hot: !!hot, cold: !!cold };

    this._blobMemo.set('warm', { ts: Date.now(), data: merged });
    return merged;
  }

  /**
   * Merge two wrapper-shaped blobs. Null-safe. Deterministic (hot wins on
   * scalar conflicts). Pure — never mutates inputs.
   */
  _mergeHotCold(hot, cold) {
    if (!hot) return cold;
    if (!cold) return hot;

    const merged = {
      movies: this._mergeMediaMap(hot.movies, cold.movies),
      tvshows: this._mergeMediaMap(hot.tvshows, cold.tvshows),
      sections: this._mergeSections(hot.sections, cold.sections),
      metadata: {
        ...(hot.metadata || {}),
        mode: 'warm',
        source: 'warm[hot ∪ cold]',
        composedAt: new Date().toISOString(),
        coldOverlay: cold.metadata || null,
        hotOverlay: hot.metadata || null,
        lastUpdated: this._laterOf(hot?.metadata?.lastUpdated, cold?.metadata?.lastUpdated),
      },
    };
    return merged;
  }

  _laterOf(a, b) {
    const ta = Date.parse(a || 0) || 0;
    const tb = Date.parse(b || 0) || 0;
    return ta >= tb ? (a || b) : (b || a);
  }

  _mergeSections(hotSections, coldSections) {
    if (!hotSections && !coldSections) return undefined;
    if (!hotSections) return coldSections;
    if (!coldSections) return hotSections;
    const out = { ...coldSections, ...hotSections }; // hot wins on key collision
    if (hotSections.oneTamilMv || coldSections.oneTamilMv) {
      out.oneTamilMv = { ...(coldSections.oneTamilMv || {}), ...(hotSections.oneTamilMv || {}) };
    }
    return out;
  }

  _mergeMediaMap(hotMap, coldMap) {
    const out = {};
    const keys = new Set([...Object.keys(hotMap || {}), ...Object.keys(coldMap || {})]);
    for (const key of keys) {
      const h = hotMap ? hotMap[key] : null;
      const c = coldMap ? coldMap[key] : null;
      if (h && !c) { out[key] = h; continue; }
      if (c && !h) { out[key] = c; continue; }
      out[key] = this._mergeEntry(h, c);
    }
    return out;
  }

  _mergeEntry(hot, cold) {
    // Wrapper scalars: hot wins; but poster/year fall back to cold if hot is empty.
    const wrapper = {
      ...(cold || {}),
      ...(hot || {}),
      posterUrl: hot?.posterUrl || cold?.posterUrl,
      year: hot?.year || cold?.year,
      type: hot?.type || cold?.type,
      sources: Array.from(new Set([...(hot?.sources || []), ...(cold?.sources || [])])),
      firstSeenAt: this._earlierOf(hot?.firstSeenAt, cold?.firstSeenAt),
      lastUpdatedAt: this._laterOf(hot?.lastUpdatedAt, cold?.lastUpdatedAt),
      qualities: this._mergeQualityMaps(
        this.getQualityMap(hot),
        this.getQualityMap(cold)
      ),
    };
    return wrapper;
  }

  _earlierOf(a, b) {
    const ta = Date.parse(a || 0) || 0;
    const tb = Date.parse(b || 0) || 0;
    if (!ta) return b || a;
    if (!tb) return a || b;
    return ta <= tb ? a : b;
  }

  _mergeQualityMaps(hotQ, coldQ) {
    const qualities = new Set([
      ...Object.keys(hotQ || {}),
      ...Object.keys(coldQ || {}),
    ]);
    const out = {};
    for (const q of qualities) {
      const hb = hotQ ? hotQ[q] : null;
      const cb = coldQ ? coldQ[q] : null;
      out[q] = this._mergeQualityBucket(hb, cb);
    }
    return out;
  }

  _mergeQualityBucket(hotBucket, coldBucket) {
    // Normalise both sides to the new {direct,torrent,magnet} shape so the
    // merge is uniform.
    const norm = (bucket) => {
      if (!bucket) return { direct: [], torrent: [], magnet: [] };
      if (Array.isArray(bucket)) {
        // Legacy flat array — bucket by kind if present, else direct.
        const out = { direct: [], torrent: [], magnet: [] };
        for (const f of bucket) {
          const k = (f && f.kind) || 'direct';
          (out[k] || out.direct).push(f);
        }
        return out;
      }
      return {
        direct: Array.isArray(bucket.direct) ? bucket.direct : [],
        torrent: Array.isArray(bucket.torrent) ? bucket.torrent : [],
        magnet: Array.isArray(bucket.magnet) ? bucket.magnet : [],
      };
    };
    const h = norm(hotBucket);
    const c = norm(coldBucket);
    return {
      direct: this.deduplicateFiles([...h.direct, ...c.direct]),
      torrent: this.deduplicateFiles([...h.torrent, ...c.torrent]),
      magnet: this.deduplicateFiles([...h.magnet, ...c.magnet]),
    };
  }

  /** Expose which Redis keys are currently hydrated. Useful for health checks. */
  async describeTiers() {
    if (!db.isConnected()) return { connected: false, tiers: {}, breaker: this.breakerStatus() };
    const out = { connected: true, tiers: {}, breaker: this.breakerStatus() };
    for (const [tier, key] of Object.entries(CACHE_KEYS)) {
      try {
        const exists = await db.redisClient.exists(key);
        out.tiers[tier] = { key, exists: exists === 1 };
      } catch (err) {
        out.tiers[tier] = { key, exists: false, error: err.message };
      }
    }
    // Surface the virtual `warm` tier – it's "available" iff hot or cold is.
    out.tiers.warm = {
      key: 'media_radar_cache:warm (virtual)',
      virtual: true,
      exists: !!(out.tiers.hot?.exists || out.tiers.cold?.exists),
      composedFrom: ['hot', 'cold'],
    };
    return out;
  }

  // -------------------------------------------------------------------------
  // Language detection (unchanged in behaviour, schema-tolerant)
  // -------------------------------------------------------------------------

  detectLanguage(key, entry) {
    const qmap = this.getQualityMap(entry);
    for (const bucket of Object.values(qmap || {})) {
      const files = this.flattenBucket(bucket);
      for (const file of files) {
        if (file && file.language) {
          const langVal = Array.isArray(file.language) ? file.language[0] : file.language;
          if (langVal) {
            const lang = langVal.toString().toLowerCase();
            if (lang.includes('tamil') || lang === 'tam') return 'tamil';
            if (lang.includes('telugu') || lang === 'tel') return 'telugu';
            if (lang.includes('kannada') || lang === 'kan') return 'kannada';
            if (lang.includes('malayalam') || lang === 'mal') return 'malayalam';
            if (lang.includes('hindi') || lang === 'hin') return 'hindi';
            if (lang.includes('english') || lang === 'eng') return 'english';
          }
        }
      }
    }

    const titleLower = key.toLowerCase();
    if (titleLower.includes('tamil')) return 'tamil';
    if (titleLower.includes('telugu')) return 'telugu';
    if (titleLower.includes('kannada')) return 'kannada';
    if (titleLower.includes('malayalam')) return 'malayalam';
    if (titleLower.includes('hindi')) return 'hindi';
    if (titleLower.includes('english') || titleLower.includes('eng')) return 'english';

    return 'others';
  }

  // -------------------------------------------------------------------------
  // Query APIs
  // -------------------------------------------------------------------------

  async getMediaByType(type, page = 1, limit = 20, options = {}) {
    // Back-compat: old signature was (type, page, limit, excludeTopReleases, language)
    if (typeof options === 'boolean') {
      options = { excludeTopReleases: arguments[3], language: arguments[4] };
    }
    const {
      excludeTopReleases = false,
      language = null,
      source = null,
      tier = 'cold', // "all" / paginated catalog = COLD blob
    } = options;

    const rawData = await this.getAllMedia(tier);
    const offset = (page - 1) * limit;

    // Resolve the bucket of entries for the requested type.
    let mediaObj;
    let dataStructure = 'unknown';
    if (Array.isArray(rawData)) {
      if (rawData.length > 0 && typeof rawData[0] === 'object') {
        mediaObj = rawData[0];
        dataStructure = 'array_wrapped';
      } else {
        throw new Error('Invalid array structure in Redis data');
      }
    } else if (typeof rawData === 'object' && rawData !== null) {
      if (rawData[type] && typeof rawData[type] === 'object') {
        mediaObj = rawData[type];
        dataStructure = 'nested_object';
      } else if (rawData.movies && rawData.tvshows) {
        mediaObj = rawData[type] || {};
        dataStructure = 'split_object';
      } else {
        mediaObj = rawData;
        dataStructure = 'mixed_object';
      }
    } else {
      throw new Error('Invalid data type in Redis cache');
    }

    // Step 1: Filter to the requested media type.
    let filteredEntries;
    if (dataStructure === 'mixed_object') {
      filteredEntries = Object.entries(mediaObj).filter(([k, v]) =>
        this.determineMediaType(k, v) === type
      );
    } else {
      filteredEntries = Object.entries(mediaObj);
    }

    // Step 2: Entries must have at least one download across all qualities.
    filteredEntries = filteredEntries.filter(([, entry]) => this.countFiles(entry) > 0);

    // Step 3: Source filter (entry-level, then file-level trim).
    if (source && source !== 'all' && SUPPORTED_SOURCES.includes(source)) {
      filteredEntries = filteredEntries
        .filter(([, entry]) => this.entryMatchesSource(entry, source))
        .map(([k, entry]) => [k, this.filterEntryBySource(entry, source)])
        .filter(([, entry]) => this.countFiles(entry) > 0);
    }

    // Step 4: Exclude top releases (uses the new `sections.oneTamilMv` key but
    // falls back to the legacy `metadata.topReleaseKeys`).
    if (excludeTopReleases) {
      const topKeys = new Set(this.collectTopReleaseKeys(rawData, type));
      if (topKeys.size) {
        filteredEntries = filteredEntries.filter(([k]) => !topKeys.has(k));
      }
    }

    // Step 5: Language filter.
    if (language && language !== 'all') {
      filteredEntries = filteredEntries.filter(([key, entry]) =>
        this.detectLanguage(key, entry) === language
      );
    }

    const totalItems = filteredEntries.length;
    const totalPages = Math.ceil(totalItems / limit);
    const paginated = filteredEntries.slice(offset, offset + limit);

    const dedupedEntries = paginated.map(([key, entry]) => [
      key,
      this.withDedupedQualities(entry),
    ]);

    return {
      entries: dedupedEntries,
      pagination: {
        currentPage: page,
        totalPages,
        totalItems,
        itemsPerPage: limit,
        hasNextPage: page < totalPages,
        hasPrevPage: page > 1,
      },
      metadata: {
        dataStructure,
        totalInRedis: Object.keys(mediaObj).length,
        filteredCount: totalItems,
        source: source || 'all',
        tier: rawData && rawData.__tier ? rawData.__tier : this.resolveTier(tier),
        cacheKey: rawData && rawData.__cacheKey ? rawData.__cacheKey : this.cacheKeyForTier(tier),
        cacheMetadata: rawData && rawData.metadata ? {
          lastUpdated: rawData.metadata.lastUpdated,
          expiresAt: rawData.metadata.expiresAt,
          version: rawData.metadata.version,
          source: rawData.metadata.source,
          mode: rawData.metadata.mode,
          codeVersion: rawData.metadata.codeVersion,
        } : undefined,
      },
    };
  }

  /**
   * Returns an entry clone with each quality bucket deduplicated. Preserves
   * the new wrapper (`type/year/posterUrl/sources/qualities`) when present.
   */
  withDedupedQualities(entry) {
    if (!entry || typeof entry !== 'object') return entry;
    if (entry.qualities) {
      return { ...entry, qualities: this.deduplicateQualityData(entry.qualities) };
    }
    return this.deduplicateQualityData(entry);
  }

  collectTopReleaseKeys(rawData, type) {
    const keys = [];
    // New schema
    if (rawData && rawData.sections && rawData.sections.oneTamilMv) {
      const sec = rawData.sections.oneTamilMv;
      for (const bucketName of ['TOP RELEASES THIS WEEK']) {
        const arr = sec[bucketName];
        if (!Array.isArray(arr)) continue;
        for (const it of arr) {
          const slugKey = this.resolveEntryKeyFromLink(it, rawData[type] || {});
          if (slugKey) keys.push(slugKey);
        }
      }
    }
    // Legacy
    if (rawData && rawData.metadata && Array.isArray(rawData.metadata.topReleaseKeys)) {
      keys.push(...rawData.metadata.topReleaseKeys);
    }
    return keys;
  }

  async searchMedia(type, query, page = 1, limit = 20, options = {}) {
    const { source = null, tier = 'cold' } = options;
    const { entries } = await this.getMediaByType(type, 1, 10000, { source, tier });
    const offset = (page - 1) * limit;

    if (!query || query.trim() === '') {
      return this.getMediaByType(type, page, limit, { source, tier });
    }

    const searchTerm = query.toLowerCase().trim();

    const filteredEntries = entries.filter(([key, entry]) => {
      const titleMatch = key.toLowerCase().includes(searchTerm);

      const qmap = this.getQualityMap(entry);
      const fileMatch = Object.values(qmap || {}).some(bucket =>
        this.flattenBucket(bucket).some(file => {
          if (!file || typeof file !== 'object') return false;
          try {
            const filename = (file.filename || '').toString().toLowerCase();
            const postTitle = (file.postTitle || file.pageTitle || '').toString().toLowerCase();
            const language = Array.isArray(file.language)
              ? file.language.join(',').toLowerCase()
              : (file.language || '').toString().toLowerCase();
            const releaseYear = (file.releaseYear || '').toString().toLowerCase();
            return (
              filename.includes(searchTerm) ||
              postTitle.includes(searchTerm) ||
              language.includes(searchTerm) ||
              releaseYear.includes(searchTerm)
            );
          } catch {
            return false;
          }
        })
      );

      return titleMatch || fileMatch;
    });

    const totalFiltered = filteredEntries.length;
    const paginated = filteredEntries.slice(offset, offset + limit);
    const dedupedEntries = paginated.map(([key, entry]) => [key, this.withDedupedQualities(entry)]);

    return {
      entries: dedupedEntries,
      pagination: {
        currentPage: page,
        totalPages: Math.ceil(totalFiltered / limit),
        totalItems: totalFiltered,
        itemsPerPage: limit,
        hasNextPage: page < Math.ceil(totalFiltered / limit),
        hasPrevPage: page > 1,
      },
      search: { query, totalFound: totalFiltered, searchTerm },
      metadata: {
        dataStructure: 'search_filtered',
        totalInRedis: entries.length,
        filteredCount: totalFiltered,
        source: source || 'all',
        tier: this.resolveTier(tier),
        cacheKey: this.cacheKeyForTier(tier),
      },
    };
  }

  async getMediaById(type, id) {
    const { entries } = await this.getMediaByType(type, 1, 10000);
    if (id > 0 && id <= entries.length) return entries[id - 1];
    throw new Error(`${type} not found`);
  }

  async getMediaByQuality(type, quality, page = 1, limit = 20, options = {}) {
    const { source = null, tier = 'cold' } = options;
    const { entries } = await this.getMediaByType(type, 1, 10000, { source, tier });
    const offset = (page - 1) * limit;

    const filteredEntries = entries.filter(([, entry]) => {
      const qmap = this.getQualityMap(entry);
      const bucket = qmap && qmap[quality];
      return this.flattenBucket(bucket).length > 0;
    });

    const totalFiltered = filteredEntries.length;
    const paginated = filteredEntries.slice(offset, offset + limit);

    return {
      entries: paginated,
      pagination: {
        currentPage: page,
        totalPages: Math.ceil(totalFiltered / limit),
        totalItems: totalFiltered,
        itemsPerPage: limit,
        hasNextPage: page < Math.ceil(totalFiltered / limit),
        hasPrevPage: page > 1,
      },
      filter: { quality, totalFound: totalFiltered, source: source || 'all' },
    };
  }

  async getMediaByLanguage(type, language, page = 1, limit = 20, options = {}) {
    const { source = null, tier = 'cold' } = options;
    const { entries } = await this.getMediaByType(type, 1, 10000, { source, tier });
    const offset = (page - 1) * limit;

    const filteredEntries = entries.filter(([, entry]) => {
      const qmap = this.getQualityMap(entry);
      return Object.values(qmap || {}).some(bucket =>
        this.flattenBucket(bucket).some(file => {
          if (!file || typeof file !== 'object') return false;
          const val = Array.isArray(file.language) ? file.language.join(',') : file.language;
          return (val || '').toString().toLowerCase().includes(language.toLowerCase());
        })
      );
    });

    const totalFiltered = filteredEntries.length;
    const paginated = filteredEntries.slice(offset, offset + limit);

    return {
      entries: paginated,
      pagination: {
        currentPage: page,
        totalPages: Math.ceil(totalFiltered / limit),
        totalItems: totalFiltered,
        itemsPerPage: limit,
        hasNextPage: page < Math.ceil(totalFiltered / limit),
        hasPrevPage: page > 1,
      },
      filter: { language, totalFound: totalFiltered, source: source || 'all' },
    };
  }

  // -------------------------------------------------------------------------
  // Media type heuristic
  // -------------------------------------------------------------------------

  determineMediaType(key, data) {
    // Explicit wrapper type wins.
    if (data && typeof data === 'object' && typeof data.type === 'string') {
      const t = data.type.toLowerCase();
      if (t === 'tv' || t === 'tvshow' || t === 'tvshows' || t === 'series') return 'tvshows';
      if (t === 'movie' || t === 'movies') return 'movies';
    }

    const tvIndicators = [
      /\bS\d+/i,
      /\bSeason\s+\d+/i,
      /\bEpisode/i,
      /\bTV\s+Show/i,
      /\bSeries/i,
      /\bComplete\s+Series/i,
    ];

    const keyLower = key.toLowerCase();
    const hasSeasonEpisode = tvIndicators.some(p => p.test(keyLower));

    const qmap = this.getQualityMap(data);
    const hasInFiles = Object.values(qmap || {}).some(bucket =>
      this.flattenBucket(bucket).some(file =>
        file && tvIndicators.some(p => p.test((file.filename || '').toLowerCase()))
      )
    );

    return (hasSeasonEpisode || hasInFiles) ? 'tvshows' : 'movies';
  }

  // -------------------------------------------------------------------------
  // "Top Releases" and "Recently Added" – now sourced from `sections.oneTamilMv`
  // -------------------------------------------------------------------------

  /**
   * Best-effort match of a crawler link ({href, title}) to the canonical
   * entry key in the movies/tvshows map. Tries title-exact match first
   * (preferred, resilient to slug rewrites) and falls back to slug parsing.
   */
  resolveEntryKeyFromLink(linkItem, mediaObj) {
    if (!linkItem || !mediaObj) return null;
    const keys = Object.keys(mediaObj);
    if (!keys.length) return null;

    // 1) title-based: strip HTML entities and quality brackets
    if (linkItem.title) {
      const rawTitle = String(linkItem.title)
        .replace(/&#\d+;|&amp;/g, ' ')
        .replace(/\[[^\]]*\]/g, ' ')
        .replace(/\(\d{4}\)/, '')
        .toLowerCase();
      const tokens = rawTitle.replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean);
      if (tokens.length >= 2) {
        const candidate = keys.find(k => {
          const kl = k.toLowerCase();
          return tokens.slice(0, 3).every(t => kl.includes(t));
        });
        if (candidate) return candidate;
      }
    }

    // 2) slug-based fallback
    if (linkItem.href) {
      const urlParts = String(linkItem.href).split('/').filter(Boolean);
      const slug = urlParts[urlParts.length - 1] || urlParts[urlParts.length - 2] || '';
      const slugParts = slug.split('-');
      const nameParts = [];
      for (const p of slugParts.slice(1)) {
        if (/^\d{4}$/.test(p) || ['tamil', 'telugu', 'hindi', 'true', 'web', 'bluray', 'hdtv', 'webrip', 'webdl'].includes(p.toLowerCase())) break;
        nameParts.push(p);
      }
      const needle = nameParts.join(' ').toLowerCase().trim();
      if (needle) {
        const candidate = keys.find(k => k.toLowerCase().includes(needle) || needle.includes(k.toLowerCase().split('(')[0].trim()));
        if (candidate) return candidate;
      }
    }

    return null;
  }

  async getSpecialSection(type, sectionName, limit = 20, options = {}) {
    const { source = null, tier = 'hot' } = options; // "latest" surfaces read from HOT by default
    const rawData = await this.getAllMedia(tier);

    const mediaObj = type === 'movies' ? rawData.movies : rawData.tvshows;
    if (!mediaObj) {
      return {
        entries: [],
        count: 0,
        type: sectionName,
        metadata: {
          tier: rawData && rawData.__tier ? rawData.__tier : this.resolveTier(tier),
          cacheKey: rawData && rawData.__cacheKey ? rawData.__cacheKey : this.cacheKeyForTier(tier),
        },
      };
    }

    // For now only 1TamilMV publishes curated sections; hdhub4u has its own
    // ordering which we fall back to (latest-firstSeenAt) below.
    const sectionLinks = rawData.sections && rawData.sections.oneTamilMv
      ? rawData.sections.oneTamilMv[sectionName]
      : null;

    const matched = [];
    const seen = new Set();

    if (Array.isArray(sectionLinks) && sectionLinks.length) {
      for (const link of sectionLinks.slice(0, limit * 3)) {
        const key = this.resolveEntryKeyFromLink(link, mediaObj);
        if (!key || seen.has(key)) continue;
        const entry = mediaObj[key];
        if (!entry || this.countFiles(entry) === 0) continue;
        if (source && source !== 'all' && !this.entryMatchesSource(entry, source)) continue;
        matched.push([key, entry]);
        seen.add(key);
        if (matched.length >= limit) break;
      }
    }

    // Fallback: take recently-seen entries (by lastUpdatedAt/firstSeenAt)
    if (matched.length < limit) {
      const allEntries = Object.entries(mediaObj)
        .filter(([, e]) => this.countFiles(e) > 0)
        .filter(([, e]) => !source || source === 'all' || this.entryMatchesSource(e, source))
        .sort(([, a], [, b]) => {
          const aT = Date.parse(a?.lastUpdatedAt || a?.firstSeenAt || 0) || 0;
          const bT = Date.parse(b?.lastUpdatedAt || b?.firstSeenAt || 0) || 0;
          return bT - aT;
        });
      for (const [key, entry] of allEntries) {
        if (seen.has(key)) continue;
        matched.push([key, entry]);
        seen.add(key);
        if (matched.length >= limit) break;
      }
    }

    const deduped = matched.map(([key, entry]) => [key, this.withDedupedQualities(
      source && source !== 'all' ? this.filterEntryBySource(entry, source) : entry
    )]);

    return {
      entries: deduped,
      count: deduped.length,
      type: sectionName === 'TOP RELEASES THIS WEEK' ? 'topReleases' : 'recentlyAdded',
      metadata: {
        tier: rawData && rawData.__tier ? rawData.__tier : this.resolveTier(tier),
        cacheKey: rawData && rawData.__cacheKey ? rawData.__cacheKey : this.cacheKeyForTier(tier),
        cacheMetadata: rawData && rawData.metadata ? {
          lastUpdated: rawData.metadata.lastUpdated,
          expiresAt: rawData.metadata.expiresAt,
          version: rawData.metadata.version,
          mode: rawData.metadata.mode,
          codeVersion: rawData.metadata.codeVersion,
        } : undefined,
      },
    };
  }

  async getTopReleases(type, limit = 10, options = {}) {
    // Latest surface -> HOT by default
    return this.getSpecialSection(type, 'TOP RELEASES THIS WEEK', limit, { tier: 'hot', ...options });
  }

  async getRecentlyAdded(type, limit = 20, options = {}) {
    // Latest surface -> HOT by default
    return this.getSpecialSection(type, 'RECENTLY ADDED', limit, { tier: 'hot', ...options });
  }

  // -------------------------------------------------------------------------
  // Convenience
  // -------------------------------------------------------------------------

  isTVShow(item) {
    if (typeof item === 'string') return this.determineMediaType(item, {}) === 'tvshows';
    if (item && typeof item === 'object') {
      const key = item.title || item.name || '';
      return this.determineMediaType(key, item) === 'tvshows';
    }
    return false;
  }
}

const instance = new MediaModel();
instance.SUPPORTED_SOURCES = SUPPORTED_SOURCES;
instance.QUALITY_ORDER = QUALITY_ORDER;
instance.CACHE_KEYS = CACHE_KEYS;
module.exports = instance;
