const MediaModel = require('../models/MediaModel');
const MediaService = require('../services/MediaService');

class TVShowController {
  // Get TV shows with pagination
  async getTVShows(req, res) {
    try {
      const page = parseInt(req.query.page) || 1;
      const limit = parseInt(req.query.limit) || 20;
      const source = req.query.source || null;
      const language = req.query.language || null;

      console.log(`TV Show API request - Page: ${page}, Limit: ${limit}${source ? `, Source: ${source}` : ''}${language ? `, Language: ${language}` : ''}`);

      const startTime = Date.now();
      const result = await MediaModel.getMediaByType('tvshows', page, limit, { language, source });
      
      const transformedTVShows = await MediaService.transformMediaEntries(
        result.entries, 
        (page - 1) * limit, 
        'tvshow'
      );
      
      const totalTime = Date.now() - startTime;
      console.log(`⚡ Total TV show processing time: ${totalTime}ms`);
      console.log(`🎉 Transformed ${transformedTVShows.length} TV shows for page ${page}`);
      
      res.json({
        tvShows: transformedTVShows,
        pagination: {
          ...result.pagination,
          totalTVShows: result.pagination.totalItems,
          tvShowsPerPage: result.pagination.itemsPerPage
        },
        metadata: {
          ...result.metadata,
          processingTimeMs: totalTime
        }
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

  // Search TV shows with pagination
  async searchTVShows(req, res) {
    try {
      const query = req.query.q || '';
      const page = parseInt(req.query.page) || 1;
      const limit = parseInt(req.query.limit) || 20;
      const source = req.query.source || null;

      console.log(`🔍 TV show search request - Query: "${query}", Page: ${page}, Limit: ${limit}${source ? `, Source: ${source}` : ''}`);

      const startTime = Date.now();
      const result = await MediaModel.searchMedia('tvshows', query, page, limit, { source });
      
      const transformedTVShows = await MediaService.transformMediaEntries(
        result.entries, 
        (page - 1) * limit, 
        'tvshow'
      );
      
      const totalTime = Date.now() - startTime;
      console.log(`⚡ Total TV show search processing time: ${totalTime}ms`);
      console.log(`🎉 Found ${transformedTVShows.length} TV shows matching "${query}" for page ${page}`);
      
      res.json({
        tvShows: transformedTVShows,
        pagination: {
          ...result.pagination,
          totalTVShows: result.pagination.totalItems,
          tvShowsPerPage: result.pagination.itemsPerPage
        },
        search: result.search,
        metadata: {
          ...result.metadata,
          processingTimeMs: totalTime
        }
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