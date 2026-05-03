const MediaModel = require('../models/MediaModel');
const MediaService = require('../services/MediaService');
const ResponseCache = require('../helpers/responseCache');
const { applyTierHeaders } = require('../helpers/cacheHeaders');

// Accept hot / cold / warm from query string. `warm` = hot ∪ cold merged view.
function sanitizeTier(raw, fallback) {
  if (!raw) return fallback;
  const t = String(raw).toLowerCase();
  return (t === 'hot' || t === 'cold' || t === 'warm') ? t : fallback;
}

// Default source filter when the caller doesn't pass `?source=`.
//
// Set to '1tamilmv' so the public site lands on the "latest catalog,
// 1tamilmv first" view by default. The env var lets ops flip this back
// to 'all' (or any other source) without a code change. Pass
// `?source=all` (or any other source slug) on a request to override
// per-call — backwards compatible with every existing caller.
const DEFAULT_SOURCE = process.env.MEDIA_RADAR_DEFAULT_SOURCE || '1tamilmv';

// Resolve the effective `source` filter for a request, honouring an
// explicit `?source=` override (including the `all` sentinel) and
// falling back to `DEFAULT_SOURCE` when omitted.
function resolveSource(rawSource) {
  if (rawSource === undefined || rawSource === null || rawSource === '') {
    return DEFAULT_SOURCE === 'all' ? null : DEFAULT_SOURCE;
  }
  const s = String(rawSource).toLowerCase();
  return s === 'all' ? null : s;
}

// Shared cache across all movie endpoints (singleton). Exported via module
// for /health and invalidation from the analysis routes if needed.
const responseCache = new ResponseCache({
  maxEntries: parseInt(process.env.RESP_CACHE_MAX || '200', 10),
  freshTtlMs: parseInt(process.env.RESP_CACHE_FRESH_MS || '15000', 10),
  staleTtlMs: parseInt(process.env.RESP_CACHE_STALE_MS || '60000', 10),
});

class MovieController {
  // Get movies with pagination (default tier: COLD = "all" catalog)
  async getMovies(req, res) {
    try {
      const page = parseInt(req.query.page) || 1;
      const limit = parseInt(req.query.limit) || 20;
      const language = req.query.language || null;
      const source = resolveSource(req.query.source);
      const tier = sanitizeTier(req.query.tier, 'cold');
      const bypassCache = req.query.noCache === '1' || req.headers['cache-control'] === 'no-cache';
      // The UI consolidated "Top Releases" + "Recently Added" + catalog into a
      // single grid (see App.js TIER_COPY comment). Excluding top releases by
      // default silently dropped the freshest 1tamilmv entries from the
      // `tier=hot` view. Default off; opt-in via ?excludeTopReleases=1 for any
      // legacy caller that still wants the slicing.
      const excludeTopReleases =
        req.query.excludeTopReleases === '1' || req.query.excludeTopReleases === 'true';

      console.log(`Movie API request - Page: ${page}, Limit: ${limit}, Tier: ${tier}${language ? `, Language: ${language}` : ''}${source ? `, Source: ${source}` : ''}${excludeTopReleases ? ', excludeTopReleases=true' : ''}`);

      const startTime = Date.now();
      const result = await MediaModel.getMediaByType('movies', page, limit, {
        excludeTopReleases,
        language,
        source,
        tier,
      });

      const effectiveTier = result.metadata?.tier || tier;
      const cacheKey = result.metadata?.cacheKey;
      const version = result.metadata?.cacheMetadata?.lastUpdated;

      const rcKey = ResponseCache.buildKey('movies:list', {
        page, limit, language, source, tier: effectiveTier, exTop: excludeTopReleases ? 1 : 0, v: version,
      });

      // Loader runs the expensive bit: TMDB/OMDB enrichment.
      const loader = async () => {
        const transformedMovies = await MediaService.transformMediaEntries(
          result.entries,
          (page - 1) * limit,
          'movie'
        );
        return {
          movies: transformedMovies,
          pagination: {
            ...result.pagination,
            totalMovies: result.pagination.totalItems,
            moviesPerPage: result.pagination.itemsPerPage,
          },
          metadata: { ...result.metadata },
        };
      };

      const cached = bypassCache
        ? await responseCache.runBypass(loader, { tier: effectiveTier, version })
        : await responseCache.get(rcKey, loader, { tier: effectiveTier, version });

      const totalTime = Date.now() - startTime;
      console.log(`⚡ Movies ${cached.source} (age=${cached.ageMs ?? 0}ms, total=${totalTime}ms)`);

      const aborted = applyTierHeaders(req, res, {
        tier: effectiveTier,
        cacheKey,
        version,
        etag: cached.etag,
        source: cached.source,
        ageMs: cached.ageMs,
        servedFromFallback: result.metadata?.tier && tier !== result.metadata.tier,
        breakerState: MediaModel.breakerStatus()[effectiveTier]?.state,
      });
      if (aborted) return;

      res.json({
        ...cached.payload,
        metadata: {
          ...(cached.payload.metadata || {}),
          processingTimeMs: totalTime,
          responseSource: cached.source,
          responseAgeMs: cached.ageMs,
        },
      });

    } catch (error) {
      console.error('Error in MovieController.getMovies:', error);
      
      if (error.message.includes('Redis')) {
        return res.status(503).json({ error: 'Database connection failed', details: error.message });
      }
      
      // Fallback mock data
      const mockMovies = [{
        id: 1,
        title: "Sample Movie",
        year: 2025,
        poster: MediaService.DEFAULT_POSTERS?.movies || 'https://via.placeholder.com/300x450/2a2a2a/ffffff?text=🎬',
        genre: "Action, Drama",
        downloadOptions: {
          "1080p": [{
            filename: "Sample.Movie.2025.1080p.BluRay.x264.mkv",
            href: "#",
            size: "2.2GB"
          }]
        },
        totalFiles: 1,
        hasRealPoster: false,
        dataSource: 'mock',
        type: 'movie'
      }];
      
      res.json({
        movies: mockMovies,
        pagination: {
          currentPage: 1,
          totalPages: 1,
          totalMovies: mockMovies.length,
          moviesPerPage: 20,
          hasNextPage: false,
          hasPrevPage: false
        }
      });
    }
  }

  // Search movies with pagination (default tier: COLD = search the full catalog)
  async searchMovies(req, res) {
    try {
      const query = req.query.q || '';
      const page = parseInt(req.query.page) || 1;
      const limit = parseInt(req.query.limit) || 20;
      const source = resolveSource(req.query.source);
      const tier = sanitizeTier(req.query.tier, 'cold');
      const bypassCache = req.query.noCache === '1' || req.headers['cache-control'] === 'no-cache';

      console.log(`🔍 Movie search request - Query: "${query}", Page: ${page}, Limit: ${limit}, Tier: ${tier}${source ? `, Source: ${source}` : ''}`);

      const startTime = Date.now();
      const result = await MediaModel.searchMedia('movies', query, page, limit, { source, tier });

      const effectiveTier = result.metadata?.tier || tier;
      const cacheKey = result.metadata?.cacheKey;
      const version = result.metadata?.cacheMetadata?.lastUpdated;
      const rcKey = ResponseCache.buildKey('movies:search', { q: query, page, limit, source, tier: effectiveTier, v: version });

      const loader = async () => {
        const transformedMovies = await MediaService.transformMediaEntries(
          result.entries, (page - 1) * limit, 'movie'
        );
        return {
          movies: transformedMovies,
          pagination: {
            ...result.pagination,
            totalMovies: result.pagination.totalItems,
            moviesPerPage: result.pagination.itemsPerPage,
          },
          search: result.search,
          metadata: { ...result.metadata },
        };
      };

      const cached = bypassCache
        ? await responseCache.runBypass(loader, { tier: effectiveTier, version })
        : await responseCache.get(rcKey, loader, { tier: effectiveTier, version });

      const totalTime = Date.now() - startTime;
      console.log(`⚡ Movie search ${cached.source} (age=${cached.ageMs ?? 0}ms, total=${totalTime}ms) -> ${cached.payload.movies.length}`);

      const aborted = applyTierHeaders(req, res, {
        tier: effectiveTier,
        cacheKey,
        version,
        etag: cached.etag,
        source: cached.source,
        ageMs: cached.ageMs,
        breakerState: MediaModel.breakerStatus()[effectiveTier]?.state,
      });
      if (aborted) return;

      res.json({
        ...cached.payload,
        metadata: {
          ...(cached.payload.metadata || {}),
          processingTimeMs: totalTime,
          responseSource: cached.source,
          responseAgeMs: cached.ageMs,
        },
      });

    } catch (error) {
      console.error('Error in MovieController.searchMovies:', error);
      
      if (error.message.includes('Redis')) {
        return res.status(503).json({ error: 'Database connection failed', details: error.message });
      }
      
      res.status(500).json({ error: 'Failed to search movies', details: error.message });
    }
  }

  // Get specific movie details
  async getMovieById(req, res) {
    try {
      const movieId = parseInt(req.params.id);
      
      const movieEntry = await MediaModel.getMediaById('movies', movieId);
      const transformedMovies = await MediaService.transformMediaEntries([movieEntry], movieId - 1, 'movie');
      
      if (transformedMovies.length > 0) {
        res.json(transformedMovies[0]);
      } else {
        res.status(404).json({ error: 'Movie not found' });
      }
      
    } catch (error) {
      console.error('Error in MovieController.getMovieById:', error);
      
      if (error.message.includes('not found')) {
        res.status(404).json({ error: 'Movie not found' });
      } else {
        res.status(500).json({ error: 'Failed to fetch movie details', details: error.message });
      }
    }
  }

  // Get movies by quality
  async getMoviesByQuality(req, res) {
    try {
      const { quality } = req.params;
      const page = parseInt(req.query.page) || 1;
      const limit = parseInt(req.query.limit) || 20;
      
      console.log(`🎯 Fetching movies with ${quality} quality`);
      
      const result = await MediaModel.getMediaByQuality('movies', quality, page, limit);
      const transformedMovies = await MediaService.transformMediaEntries(
        result.entries, 
        (page - 1) * limit, 
        'movie'
      );
      
      res.json({
        movies: transformedMovies,
        pagination: {
          ...result.pagination,
          totalMovies: result.pagination.totalItems,
          moviesPerPage: result.pagination.itemsPerPage
        },
        filter: result.filter
      });
      
    } catch (error) {
      console.error('Error in MovieController.getMoviesByQuality:', error);
      res.status(500).json({ error: 'Failed to fetch movies by quality', details: error.message });
    }
  }

  // Get movies by language
  async getMoviesByLanguage(req, res) {
    try {
      const { language } = req.params;
      const page = parseInt(req.query.page) || 1;
      const limit = parseInt(req.query.limit) || 20;
      
      console.log(`🗣️ Fetching movies with ${language} language`);
      
      const result = await MediaModel.getMediaByLanguage('movies', language, page, limit);
      const transformedMovies = await MediaService.transformMediaEntries(
        result.entries, 
        (page - 1) * limit, 
        'movie'
      );
      
      res.json({
        movies: transformedMovies,
        pagination: {
          ...result.pagination,
          totalMovies: result.pagination.totalItems,
          moviesPerPage: result.pagination.itemsPerPage
        },
        filter: result.filter
      });
      
    } catch (error) {
      console.error('Error in MovieController.getMoviesByLanguage:', error);
      res.status(500).json({ error: 'Failed to fetch movies by language', details: error.message });
    }
  }

  // Get top releases (movies released this week). Default tier: HOT = "latest".
  async getTopReleases(req, res) {
    try {
      const limit = parseInt(req.query.limit) || 10;
      const source = resolveSource(req.query.source);
      const tier = sanitizeTier(req.query.tier, 'hot');
      const bypassCache = req.query.noCache === '1' || req.headers['cache-control'] === 'no-cache';

      console.log(`🔥 Fetching top movie releases (tier: ${tier}, limit: ${limit}${source ? `, source: ${source}` : ''})`);

      const startTime = Date.now();
      const result = await MediaModel.getTopReleases('movies', limit, { source, tier });

      const effectiveTier = result.metadata?.tier || tier;
      const cacheKey = result.metadata?.cacheKey;
      const version = result.metadata?.cacheMetadata?.lastUpdated;
      const rcKey = ResponseCache.buildKey('movies:top', { limit, source, tier: effectiveTier, v: version });

      const loader = async () => {
        const transformedMovies = await MediaService.transformMediaEntries(result.entries, 0, 'movie');
        return {
          movies: transformedMovies,
          count: transformedMovies.length,
          type: 'topReleases',
          metadata: { ...(result.metadata || {}) },
        };
      };

      const cached = bypassCache
        ? await responseCache.runBypass(loader, { tier: effectiveTier, version })
        : await responseCache.get(rcKey, loader, { tier: effectiveTier, version });

      const totalTime = Date.now() - startTime;
      console.log(`⚡ Top releases ${cached.source} (age=${cached.ageMs ?? 0}ms, total=${totalTime}ms) -> ${cached.payload.count}`);

      const aborted = applyTierHeaders(req, res, {
        tier: effectiveTier,
        cacheKey,
        version,
        etag: cached.etag,
        source: cached.source,
        ageMs: cached.ageMs,
        breakerState: MediaModel.breakerStatus()[effectiveTier]?.state,
      });
      if (aborted) return;

      res.json({
        ...cached.payload,
        metadata: {
          ...(cached.payload.metadata || {}),
          processingTimeMs: totalTime,
          responseSource: cached.source,
          responseAgeMs: cached.ageMs,
        },
      });

    } catch (error) {
      console.error('Error in MovieController.getTopReleases:', error);
      
      if (error.message.includes('Redis')) {
        return res.status(503).json({ error: 'Database connection failed', details: error.message });
      }
      
      res.status(500).json({ error: 'Failed to fetch top releases', details: error.message });
    }
  }

  // Get recently added movies. Default tier: HOT = "latest".
  async getRecentlyAdded(req, res) {
    try {
      const limit = parseInt(req.query.limit) || 20;
      const source = resolveSource(req.query.source);
      const tier = sanitizeTier(req.query.tier, 'hot');
      const bypassCache = req.query.noCache === '1' || req.headers['cache-control'] === 'no-cache';

      console.log(`📅 Fetching recently added movies (tier: ${tier}, limit: ${limit}${source ? `, source: ${source}` : ''})`);

      const startTime = Date.now();
      const result = await MediaModel.getRecentlyAdded('movies', limit, { source, tier });

      const effectiveTier = result.metadata?.tier || tier;
      const cacheKey = result.metadata?.cacheKey;
      const version = result.metadata?.cacheMetadata?.lastUpdated;
      const rcKey = ResponseCache.buildKey('movies:recent', { limit, source, tier: effectiveTier, v: version });

      const loader = async () => {
        const transformedMovies = await MediaService.transformMediaEntries(result.entries, 0, 'movie');
        return {
          movies: transformedMovies,
          count: transformedMovies.length,
          type: 'recentlyAdded',
          metadata: { ...(result.metadata || {}) },
        };
      };

      const cached = bypassCache
        ? await responseCache.runBypass(loader, { tier: effectiveTier, version })
        : await responseCache.get(rcKey, loader, { tier: effectiveTier, version });

      const totalTime = Date.now() - startTime;
      console.log(`⚡ Recently added ${cached.source} (age=${cached.ageMs ?? 0}ms, total=${totalTime}ms) -> ${cached.payload.count}`);

      const aborted = applyTierHeaders(req, res, {
        tier: effectiveTier,
        cacheKey,
        version,
        etag: cached.etag,
        source: cached.source,
        ageMs: cached.ageMs,
        breakerState: MediaModel.breakerStatus()[effectiveTier]?.state,
      });
      if (aborted) return;

      res.json({
        ...cached.payload,
        metadata: {
          ...(cached.payload.metadata || {}),
          processingTimeMs: totalTime,
          responseSource: cached.source,
          responseAgeMs: cached.ageMs,
        },
      });

    } catch (error) {
      console.error('Error in MovieController.getRecentlyAdded:', error);
      
      if (error.message.includes('Redis')) {
        return res.status(503).json({ error: 'Database connection failed', details: error.message });
      }
      
      res.status(500).json({ error: 'Failed to fetch recently added movies', details: error.message });
    }
  }
}

const controllerInstance = new MovieController();
controllerInstance.responseCache = responseCache;
// Re-export the source-default helper so TVShowController + any future
// controller can apply identical "default = 1tamilmv, ?source=all opts out"
// semantics without re-defining the env-var fallback in N places.
controllerInstance.resolveSource = resolveSource;
controllerInstance.DEFAULT_SOURCE = DEFAULT_SOURCE;
module.exports = controllerInstance;
