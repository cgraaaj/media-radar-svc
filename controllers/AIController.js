const AIService = require('../services/AIService');
const JellyfinService = require('../services/JellyfinService');

class AIController {
  // Get AI-powered movie suggestions
  async getMovieSuggestions(req, res) {
    try {
      const { query, matchThreshold, matchCount, includeSources } = req.body;
      
      if (!query || !query.trim()) {
        return res.status(400).json({
          success: false,
          error: 'Query is required',
          message: 'Please provide a valid movie question or description.'
        });
      }

      console.log(`🤖 AI suggestion request: "${query}"`);

      // Check if AI service is configured
      if (!AIService.isConfigured()) {
        return res.status(503).json({
          success: false,
          error: 'AI service not configured',
          message: 'AI movie suggestions are currently unavailable. Please check the server configuration.'
        });
      }

      const options = {
        matchThreshold: matchThreshold ? parseFloat(matchThreshold) : undefined,
        matchCount: matchCount ? parseInt(matchCount) : undefined,
        includeSources: includeSources === 'true' || includeSources === true
      };

      const result = await AIService.getMovieSuggestions(query, options);

      res.json({
        ...result,
        query: query,
        timestamp: new Date().toISOString()
      });

    } catch (error) {
      console.error('Error in AIController.getMovieSuggestions:', error);
      res.status(500).json({
        success: false,
        error: 'Internal server error',
        message: 'An error occurred while generating movie suggestions.'
      });
    }
  }

  // Check AI service status
  async getStatus(req, res) {
    try {
      const isConfigured = AIService.isConfigured();
      const status = isConfigured ? 'available' : 'unavailable';
      
      res.json({
        status: status,
        configured: isConfigured,
        service: 'PopcornPal AI',
        version: '1.0.0',
        features: {
          movieSuggestions: isConfigured,
          vectorSearch: isConfigured,
          aiChat: isConfigured
        }
      });
    } catch (error) {
      console.error('Error in AIController.getStatus:', error);
      res.status(500).json({
        status: 'error',
        configured: false,
        error: error.message
      });
    }
  }



  // Get example queries for the UI
  async getExampleQueries(req, res) {
    try {
      const examples = [
        "What are some good action movies?",
        "Recommend comedy movies from the 2020s",
        "Movies similar to Inception",
        "Best rated movies in 2024",
        "Animated movies for kids",
        "Movies directed by Christopher Nolan",
        "Romantic comedies with happy endings",
        "Sci-fi movies with time travel",
        "Horror movies that aren't too scary",
        "Movies with great soundtracks"
      ];

      res.json({
        success: true,
        examples: examples,
        count: examples.length
      });
    } catch (error) {
      console.error('Error in AIController.getExampleQueries:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to fetch example queries'
      });
    }
  }

  // Get watch link for a specific movie
  async getWatchLink(req, res) {
    try {
      const { movieName } = req.body;
      
      if (!movieName || !movieName.trim()) {
        return res.status(400).json({
          success: false,
          error: 'Movie name is required',
          message: 'Please provide a valid movie name.'
        });
      }

      console.log(`🎬 Getting watch link for: "${movieName}"`);

      // Search for the movie in Jellyfin
      const searchResult = await JellyfinService.searchMovieInJellyfin(movieName);
      console.log(`🔍 Jellyfin search result for "${movieName}":`, {
        success: searchResult.success,
        movieCount: searchResult.movies?.length || 0,
        error: searchResult.error
      });
      
      if (!searchResult.success) {
        return res.json({
          success: false,
          message: searchResult.message || 'Movie not found in Jellyfin library',
          error: searchResult.error,
          available: false
        });
      }

      // Find the best matching movie
      const bestMatch = JellyfinService.findBestMatch(movieName, searchResult.movies);
      
      if (!bestMatch) {
        return res.json({
          success: false,
          message: 'No suitable match found in Jellyfin library',
          available: false
        });
      }

      // Return simplified watch data for token-login approach
      res.json({
        success: true,
        available: true,
        movie: {
          id: bestMatch.id,
          name: bestMatch.name,
          year: bestMatch.year,
          overview: bestMatch.overview,
          genres: bestMatch.genres,
          rating: bestMatch.rating
        },
        watchData: {
          server: JellyfinService.jellyfinServer,
          movieId: bestMatch.id
        },
        message: `Found "${bestMatch.name}" in Jellyfin library`
      });

    } catch (error) {
      console.error('Error in AIController.getWatchLink:', error);
      res.status(500).json({
        success: false,
        error: 'Internal server error',
        message: 'An error occurred while getting the watch link.'
      });
    }
  }




}

module.exports = new AIController(); 