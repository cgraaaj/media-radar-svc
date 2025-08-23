const { OpenAI } = require('openai');
const { Pool } = require('pg');

class AIService {
  constructor() {
    this.openaiClient = null;
    this.dbPool = null;
    this.initialized = false;
    
    // Configuration
    this.EMBEDDING_MODEL = "text-embedding-3-small";
    this.EMBEDDING_DIMENSIONS = 512;
    this.CHAT_MODEL = "gpt-4o-mini";
    this.DEFAULT_TOP_K = 5;
    this.DEFAULT_ALPHA = 0.5; // Weight for semantic similarity (0..1), (1-alpha) for full-text
    this.DEFAULT_TEMPERATURE = 0.3;
    this.DEFAULT_FREQUENCY_PENALTY = 0.2;
    
    // Database configuration
    this.DB_CONFIG = {
      host: process.env.DB_HOST,
      port: parseInt(process.env.DB_PORT),
      database: process.env.DB_NAME,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      max: 20,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 2000,
    };
    
    // System prompt for movie recommendations
    this.MOVIE_ASSISTANT_PROMPT = `You are a knowledgeable movie expert and enthusiastic film critic who loves helping people discover great movies. 

You will be given movie context and a user's question. Your job is to:
1. Provide accurate, helpful information about movies using only the provided context
2. Be enthusiastic and engaging in your recommendations
3. Include relevant details like year, rating, genre, cast, or plot when available
4. If the context doesn't contain enough information to answer the question, politely say "I don't have enough information about that in my movie database."
5. Don't make up any information.
6. The response should have the movie name in bold.

Keep responses concise but informative, and always focus on movies and film-related content.`;
  }

  async initialize() {
    try {
      if (this.initialized) return;

      // Initialize OpenAI client
      const openaiApiKey = process.env.OPENAI_API_KEY;
      if (!openaiApiKey) {
        throw new Error('OpenAI API key is missing. Please check your environment variables.');
      }
      this.openaiClient = new OpenAI({ apiKey: openaiApiKey });

      // Initialize PostgreSQL connection pool
      this.dbPool = new Pool(this.DB_CONFIG);
      
      // Test database connection
      const client = await this.dbPool.connect();
      await client.query('SELECT 1');
      client.release();

      this.initialized = true;
      console.log('✅ AI Service initialized successfully');
    } catch (error) {
      console.error('❌ Failed to initialize AI Service:', error.message);
      throw error;
    }
  }

  async generateEmbedding(text) {
    try {
      if (!this.initialized) await this.initialize();

      const response = await this.openaiClient.embeddings.create({
        input: text.trim(),
        model: this.EMBEDDING_MODEL,
        dimensions: this.EMBEDDING_DIMENSIONS
      });

      return response.data[0].embedding;
    } catch (error) {
      console.error('❌ Failed to generate embedding:', error.message);
      throw error;
    }
  }

  async hybridSearch(queryText, topK = this.DEFAULT_TOP_K, alpha = this.DEFAULT_ALPHA, includeScores = true) {
    try {
      if (!this.initialized) await this.initialize();
      
      if (alpha < 0 || alpha > 1) {
        throw new Error('Alpha must be between 0 and 1');
      }

      // Generate embedding for query
      const queryEmbedding = await this.generateEmbedding(queryText);

      // Build SQL query
      const sqlQuery = this._buildSearchQuery(includeScores);
      const queryParams = this._buildQueryParams(queryText, queryEmbedding, alpha, topK);

      // Execute search
      const client = await this.dbPool.connect();
      try {
        const result = await client.query(sqlQuery, queryParams);
        return result.rows;
      } finally {
        client.release();
      }
    } catch (error) {
      console.error('❌ Hybrid search error:', error.message);
      throw error;
    }
  }

  _buildSearchQuery(includeScores) {
    const baseColumns = `
      id,
      title,
      movie_year,
      rating,
      summary,
      genres,
      directors,
      cast_members
    `;

    const scoreColumns = includeScores ? `
      ts_rank(tsv, plainto_tsquery($1)) AS text_score,
      1 - (embedding <=> $2::vector) AS vector_score,
      ( $3::float * (1 - (embedding <=> $4::vector)) +
        (1 - $5::float) * ts_rank(tsv, plainto_tsquery($6)) ) AS hybrid_score
    ` : '';

    return `
      SELECT
        ${baseColumns}
        ${includeScores ? ', ' + scoreColumns : ''}
      FROM movies_app.movies
      WHERE tsv @@ plainto_tsquery($7) OR embedding <=> $8::vector < 1
      ORDER BY ( $9::float * (1 - (embedding <=> $10::vector)) +
                (1 - $11::float) * ts_rank(tsv, plainto_tsquery($12)) ) DESC
      LIMIT $13;
    `;
  }

  _buildQueryParams(queryText, queryEmbedding, alpha, topK) {
    // Format vector as PostgreSQL array literal
    const vectorString = `[${queryEmbedding.join(',')}]`;
    
    return [
      queryText,        // $1 - for text_score ts_rank
      vectorString,     // $2 - for vector_score
      alpha,            // $3 - for hybrid_score weight
      vectorString,     // $4 - for hybrid_score vector part
      alpha,            // $5 - for hybrid_score weight (1-alpha)
      queryText,        // $6 - for hybrid_score text part
      queryText,        // $7 - for WHERE clause text search
      vectorString,     // $8 - for WHERE clause vector search
      alpha,            // $9 - for ORDER BY hybrid score
      vectorString,     // $10 - for ORDER BY vector part
      alpha,            // $11 - for ORDER BY weight (1-alpha)
      queryText,        // $12 - for ORDER BY text part
      topK              // $13 - LIMIT
    ];
  }

  async generateMovieResponse(movieContexts, userQuery, temperature = this.DEFAULT_TEMPERATURE) {
    try {
      if (!this.initialized) await this.initialize();

      // Combine all movie contexts
      const combinedContext = movieContexts.join('\n\n');

      const messages = [
        { role: "system", content: this.MOVIE_ASSISTANT_PROMPT },
        {
          role: "user",
          content: `Movie context:\n${combinedContext}\n\nUser Question: ${userQuery}`
        }
      ];

      const response = await this.openaiClient.chat.completions.create({
        model: this.CHAT_MODEL,
        messages: messages,
        temperature: temperature,
        frequency_penalty: this.DEFAULT_FREQUENCY_PENALTY,
        max_tokens: 500
      });

      const answer = response.choices[0].message.content;
      console.log('✅ Generated AI response');
      return answer;
    } catch (error) {
      console.error('❌ Error generating response:', error.message);
      throw error;
    }
  }

  async getMovieSuggestions(query, options = {}) {
    try {
      if (!query || !query.trim()) {
        throw new Error('Please provide a valid movie question.');
      }

      const {
        topK = this.DEFAULT_TOP_K,
        alpha = this.DEFAULT_ALPHA,
        includeSources = false
      } = options;

      console.log(`🔍 Hybrid searching for: "${query}" (alpha=${alpha})`);

      // Perform hybrid search
      const results = await this.hybridSearch(query, topK, alpha, true);

      if (!results || results.length === 0) {
        return {
          success: false,
          message: 'No movies found matching your query. Try rephrasing your question or using different keywords.',
          suggestions: null,
          sources: []
        };
      }

      // Format movie contexts for AI (simplified)
      const movieContexts = results.map(movie => {
        const genres = Array.isArray(movie.genres) ? movie.genres.slice(0, 2).join(', ') : movie.genres || '';
        const summary = movie.summary ? movie.summary.substring(0, 100) + '...' : '';
        return `**${movie.title}** (${movie.movie_year}) - ${genres} - Rating: ${movie.rating || 'N/A'} - ${summary}`;
      });


      // Generate AI response
      const aiResponse = await this.generateMovieResponse(movieContexts, query);

      return {
        success: true,
        message: aiResponse,
        suggestions: aiResponse,
        sources: includeSources ? results : [],
        matchCount: results.length,
        searchType: 'hybrid',
        alpha: alpha
      };

    } catch (error) {
      console.error('❌ Movie suggestion failed:', error.message);
      return {
        success: false,
        message: `Sorry, something went wrong: ${error.message}`,
        suggestions: null,
        sources: []
      };
    }
  }

  // Check if the service is properly configured
  isConfigured() {
    return !!(process.env.OPENAI_API_KEY);
  }

  // Cleanup method
  async cleanup() {
    if (this.dbPool) {
      await this.dbPool.end();
    }
  }
}

module.exports = new AIService(); 