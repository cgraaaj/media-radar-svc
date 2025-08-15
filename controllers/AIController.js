const AIService = require('../services/AIService');

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
}

module.exports = new AIController(); 