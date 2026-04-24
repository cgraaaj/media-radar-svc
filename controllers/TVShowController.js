const MediaModel = require('../models/MediaModel');
const MediaService = require('../services/MediaService');
const ResponseCache = require('../helpers/responseCache');
const { applyTierHeaders } = require('../helpers/cacheHeaders');
const MovieController = require('./MovieController');

function sanitizeTier(raw, fallback) {
  if (!raw) return fallback;
  const t = String(raw).toLowerCase();
  return (t === 'hot' || t === 'cold' || t === 'warm') ? t : fallback;
}

// Share the same in-process response cache as MovieController — one ring to
// rule them all. Keeps bookkeeping and invalidation semantics unified.
const responseCache = MovieController.responseCache;

class TVShowController {
  // Get TV shows with pagination (default tier: COLD = "all" catalog)
  async getTVShows(req, res) {
    try {
      const page = parseInt(req.query.page) || 1;
      const limit = parseInt(req.query.limit) || 20;
      const source = req.query.source || null;
      const language = req.query.language || null;
      const tier = sanitizeTier(req.query.tier, 'cold');
      const bypassCache = req.query.noCache === '1' || req.headers['cache-control'] === 'no-cache';

      console.log(`TV Show API request - Page: ${page}, Limit: ${limit}, Tier: ${tier}${source ? `, Source: ${source}` : ''}${language ? `, Language: ${language}` : ''}`);

      const startTime = Date.now();
      const result = await MediaModel.getMediaByType('tvshows', page, limit, { language, source, tier });

      const effectiveTier = result.metadata?.tier || tier;
      const cacheKey = result.metadata?.cacheKey;
      const version = result.metadata?.cacheMetadata?.lastUpdated;
      const rcKey = ResponseCache.buildKey('tvshows:list', { page, limit, language, source, tier: effectiveTier, v: version });

      const loader = async () => {
        const transformedTVShows = await MediaService.transformMediaEntries(
          result.entries, (page - 1) * limit, 'tvshow'
        );
        return {
          tvShows: transformedTVShows,
          pagination: {
            ...result.pagination,
            totalTVShows: result.pagination.totalItems,
            tvShowsPerPage: result.pagination.itemsPerPage,
          },
          metadata: { ...result.metadata },
        };
      };

      const cached = bypassCache
        ? await responseCache.runBypass(loader, { tier: effectiveTier, version })
        : await responseCache.get(rcKey, loader, { tier: effectiveTier, version });

      const totalTime = Date.now() - startTime;
      console.log(`⚡ TVShows ${cached.source} (age=${cached.ageMs ?? 0}ms, total=${totalTime}ms) -> ${cached.payload.tvShows.length}`);

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
      console.error('Error in TVShowController.getTVShows:', error);
      
      if (error.message.includes('Redis')) {
        return res.status(503).json({ error: 'Database connection failed', details: error.message });
      }
      
      // Fallback mock data
      const mockTVShows = [{
        id: 1,
        title: "Breaking Bad",
        year: 2008,
        poster: MediaService.DEFAULT_POSTERS?.tvshows || 'https://via.placeholder.com/300x450/2a2a2a/ffffff?text=📺',
        genre: "Crime, Drama, Thriller",
        seasons: 5,
        episodes: 62,
        downloadOptions: {
          "1080p": [{
            filename: "Breaking.Bad.S01-S05.Complete.1080p.BluRay.x264-DEMAND.mkv",
            href: "#",
            size: "45.2GB"
          }]
        },
        totalFiles: 1,
        hasRealPoster: false,
        dataSource: 'mock',
        type: 'tvshow'
      }];
      
      res.json({
        tvShows: mockTVShows,
        pagination: {
          currentPage: 1,
          totalPages: 1,
          totalTVShows: mockTVShows.length,
          tvShowsPerPage: 20,
          hasNextPage: false,
          hasPrevPage: false
        }
      });
    }
  }

  // Search TV shows with pagination (default tier: COLD)
  async searchTVShows(req, res) {
    try {
      const query = req.query.q || '';
      const page = parseInt(req.query.page) || 1;
      const limit = parseInt(req.query.limit) || 20;
      const source = req.query.source || null;
      const tier = sanitizeTier(req.query.tier, 'cold');
      const bypassCache = req.query.noCache === '1' || req.headers['cache-control'] === 'no-cache';

      console.log(`🔍 TV show search request - Query: "${query}", Page: ${page}, Limit: ${limit}, Tier: ${tier}${source ? `, Source: ${source}` : ''}`);

      const startTime = Date.now();
      const result = await MediaModel.searchMedia('tvshows', query, page, limit, { source, tier });

      const effectiveTier = result.metadata?.tier || tier;
      const cacheKey = result.metadata?.cacheKey;
      const version = result.metadata?.cacheMetadata?.lastUpdated;
      const rcKey = ResponseCache.buildKey('tvshows:search', { q: query, page, limit, source, tier: effectiveTier, v: version });

      const loader = async () => {
        const transformedTVShows = await MediaService.transformMediaEntries(
          result.entries, (page - 1) * limit, 'tvshow'
        );
        return {
          tvShows: transformedTVShows,
          pagination: {
            ...result.pagination,
            totalTVShows: result.pagination.totalItems,
            tvShowsPerPage: result.pagination.itemsPerPage,
          },
          search: result.search,
          metadata: { ...result.metadata },
        };
      };

      const cached = bypassCache
        ? await responseCache.runBypass(loader, { tier: effectiveTier, version })
        : await responseCache.get(rcKey, loader, { tier: effectiveTier, version });

      const totalTime = Date.now() - startTime;
      console.log(`⚡ TVShow search ${cached.source} (age=${cached.ageMs ?? 0}ms, total=${totalTime}ms) -> ${cached.payload.tvShows.length}`);

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
      console.error('Error in TVShowController.searchTVShows:', error);
      
      if (error.message.includes('Redis')) {
        return res.status(503).json({ error: 'Database connection failed', details: error.message });
      }
      
      res.status(500).json({ error: 'Failed to search TV shows', details: error.message });
    }
  }

  // Get specific TV show details
  async getTVShowById(req, res) {
    try {
      const showId = parseInt(req.params.id);
      
      const showEntry = await MediaModel.getMediaById('tvshows', showId);
      const transformedShows = await MediaService.transformMediaEntries([showEntry], showId - 1, 'tvshow');
      
      if (transformedShows.length > 0) {
        res.json(transformedShows[0]);
      } else {
        res.status(404).json({ error: 'TV show not found' });
      }
      
    } catch (error) {
      console.error('Error in TVShowController.getTVShowById:', error);
      
      if (error.message.includes('not found')) {
        res.status(404).json({ error: 'TV show not found' });
      } else {
        res.status(500).json({ error: 'Failed to fetch TV show details', details: error.message });
      }
    }
  }

  // Get TV shows by quality
  async getTVShowsByQuality(req, res) {
    try {
      const { quality } = req.params;
      const page = parseInt(req.query.page) || 1;
      const limit = parseInt(req.query.limit) || 20;
      
      console.log(`🎯 Fetching TV shows with ${quality} quality`);
      
      const result = await MediaModel.getMediaByQuality('tvshows', quality, page, limit);
      const transformedTVShows = await MediaService.transformMediaEntries(
        result.entries, 
        (page - 1) * limit, 
        'tvshow'
      );
      
      res.json({
        tvShows: transformedTVShows,
        pagination: {
          ...result.pagination,
          totalTVShows: result.pagination.totalItems,
          tvShowsPerPage: result.pagination.itemsPerPage
        },
        filter: result.filter
      });
      
    } catch (error) {
      console.error('Error in TVShowController.getTVShowsByQuality:', error);
      res.status(500).json({ error: 'Failed to fetch TV shows by quality', details: error.message });
    }
  }

  // Get TV shows by language
  async getTVShowsByLanguage(req, res) {
    try {
      const { language } = req.params;
      const page = parseInt(req.query.page) || 1;
      const limit = parseInt(req.query.limit) || 20;
      
      console.log(`🗣️ Fetching TV shows with ${language} language`);
      
      const result = await MediaModel.getMediaByLanguage('tvshows', language, page, limit);
      const transformedTVShows = await MediaService.transformMediaEntries(
        result.entries, 
        (page - 1) * limit, 
        'tvshow'
      );
      
      res.json({
        tvShows: transformedTVShows,
        pagination: {
          ...result.pagination,
          totalTVShows: result.pagination.totalItems,
          tvShowsPerPage: result.pagination.itemsPerPage
        },
        filter: result.filter
      });
      
    } catch (error) {
      console.error('Error in TVShowController.getTVShowsByLanguage:', error);
      res.status(500).json({ error: 'Failed to fetch TV shows by language', details: error.message });
    }
  }
}

module.exports = new TVShowController(); 