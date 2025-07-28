const MediaModel = require('../models/MediaModel');
const MediaService = require('../services/MediaService');

class MovieController {
  // Get movies with pagination
  async getMovies(req, res) {
    try {
      const page = parseInt(req.query.page) || 1;
      const limit = parseInt(req.query.limit) || 20;
      
      console.log(`Movie API request - Page: ${page}, Limit: ${limit}`);
      
      const startTime = Date.now();
      const result = await MediaModel.getMediaByType('movies', page, limit);
      
      const transformedMovies = await MediaService.transformMediaEntries(
        result.entries, 
        (page - 1) * limit, 
        'movie'
      );
      
      const totalTime = Date.now() - startTime;
      console.log(`⚡ Total movie processing time: ${totalTime}ms`);
      console.log(`🎉 Transformed ${transformedMovies.length} movies for page ${page}`);
      
      res.json({
        movies: transformedMovies,
        pagination: {
          ...result.pagination,
          totalMovies: result.pagination.totalItems,
          moviesPerPage: result.pagination.itemsPerPage
        },
        metadata: {
          ...result.metadata,
          processingTimeMs: totalTime
        }
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
}

module.exports = new MovieController(); 