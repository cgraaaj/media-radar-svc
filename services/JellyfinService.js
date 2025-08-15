const axios = require('axios');

class JellyfinService {
  constructor() {
    // Use the same server for authentication and API calls
    this.jellyfinServer = process.env.JELLYFIN_SERVER || 'https://vrplayer.cgraaaj.in';
    this.authServer = process.env.JELLYFIN_AUTH_SERVER || this.jellyfinServer;
    this.webPlayerUrl = process.env.JELLYFIN_WEB_PLAYER || this.jellyfinServer;
    this.tokenCache = new Map();
    this.tokenExpiry = new Map();
  }

  async authenticateUser() {
    try {
      console.log('🔐 Authenticating with Jellyfin...');
      
      const response = await axios.post(`${this.authServer}/Users/AuthenticateByName`, {
        Username: "anonymous",
        Pw: "anonymous@jelly"
      }, {
        headers: {
          'Content-Type': 'application/json',
          'X-Emby-Authorization': 'MediaBrowser Client="MediaRadar", Device="WebApp", DeviceId="media-radar-web", Version="1.0.0"'
        }
      });

      const { AccessToken, User } = response.data;
      
      if (AccessToken && User) {
        // Cache token for 24 hours
        this.tokenCache.set('anonymous', AccessToken);
        this.tokenExpiry.set('anonymous', Date.now() + (24 * 60 * 60 * 1000));
        
        console.log('✅ Jellyfin authentication successful');
        return {
          success: true,
          token: AccessToken,
          userId: User.Id,
          username: User.Name
        };
      } else {
        throw new Error('Invalid authentication response');
      }
    } catch (error) {
      console.error('❌ Jellyfin authentication failed:', error.message);
      return {
        success: false,
        error: error.message,
        token: null
      };
    }
  }

  async getValidToken() {
    const cachedToken = this.tokenCache.get('anonymous');
    const expiry = this.tokenExpiry.get('anonymous');
    
    // Check if cached token is still valid
    if (cachedToken && expiry && Date.now() < expiry) {
      return cachedToken;
    }
    
    // Get new token
    const authResult = await this.authenticateUser();
    return authResult.success ? authResult.token : null;
  }

  async searchMovieInJellyfin(movieName) {
    try {
      const token = await this.getValidToken();
      if (!token) {
        throw new Error('Failed to authenticate with Jellyfin');
      }

      console.log(`🔍 Searching for "${movieName}" in Jellyfin...`);

      const response = await axios.get(`${this.jellyfinServer}/Items`, {
        headers: {
          'Authorization': `MediaBrowser Token=${token}`
        },
        params: {
          Recursive: true,
          searchTerm: movieName,
          includeItemTypes: 'Movie',
          Fields: 'Overview,Genres,ProductionYear,CommunityRating,OfficialRating',
          Limit: 10
        }
      });

      const items = response.data.Items || [];
      
      if (items.length > 0) {
        console.log(`✅ Found ${items.length} movies in Jellyfin`);
        
        // Return the movies with necessary info
        return {
          success: true,
          movies: items.map(movie => ({
            id: movie.Id,
            name: movie.Name,
            year: movie.ProductionYear,
            overview: movie.Overview,
            genres: movie.Genres || [],
            rating: movie.CommunityRating,
            officialRating: movie.OfficialRating,
            type: movie.Type,
            serverId: movie.ServerId
          })),
          token: token
        };
      } else {
        console.log('ℹ️ No movies found in Jellyfin');
        return {
          success: false,
          message: 'Movie not found in Jellyfin library',
          movies: [],
          token: token
        };
      }
    } catch (error) {
      console.error('❌ Jellyfin search failed:', error.message);
      return {
        success: false,
        error: error.message,
        movies: []
      };
    }
  }



  // Get the best matching movie from search results
  findBestMatch(searchTerm, movies) {
    if (!movies || movies.length === 0) return null;
    
    const searchLower = searchTerm.toLowerCase();
    
    // First try exact match
    let exactMatch = movies.find(movie => 
      movie.name.toLowerCase() === searchLower
    );
    
    if (exactMatch) return exactMatch;
    
    // Then try to find the closest match
    let bestMatch = movies[0];
    let bestScore = 0;
    
    for (const movie of movies) {
      const movieNameLower = movie.name.toLowerCase();
      
      // Calculate simple similarity score
      let score = 0;
      if (movieNameLower.includes(searchLower)) {
        score = searchLower.length / movieNameLower.length;
      }
      
      if (score > bestScore) {
        bestScore = score;
        bestMatch = movie;
      }
    }
    
    return bestMatch;
  }

  // Check if Jellyfin is configured and accessible
  async checkStatus() {
    try {
      const authResult = await this.authenticateUser();
      return {
        configured: true,
        accessible: authResult.success,
        server: this.jellyfinServer,
        webPlayer: this.webPlayerUrl,
        status: authResult.success ? 'ready' : 'authentication_failed',
        error: authResult.success ? null : authResult.error
      };
    } catch (error) {
      return {
        configured: false,
        accessible: false,
        server: this.jellyfinServer,
        webPlayer: this.webPlayerUrl,
        status: 'error',
        error: error.message
      };
    }
  }
}

module.exports = new JellyfinService(); 