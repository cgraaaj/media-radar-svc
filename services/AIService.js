const { OpenAI } = require('openai');
const { createClient } = require('@supabase/supabase-js');

class AIService {
  constructor() {
    this.openaiClient = null;
    this.supabaseClient = null;
    this.initialized = false;
    
    // Configuration
    this.EMBEDDING_MODEL = "text-embedding-3-small";
    this.CHAT_MODEL = "gpt-4o-mini";
    this.DEFAULT_MATCH_THRESHOLD = 0.3;
    this.DEFAULT_MATCH_COUNT = 5;
    this.DEFAULT_TEMPERATURE = 0.3;
    this.DEFAULT_FREQUENCY_PENALTY = 0.2;
    
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

      // Initialize Supabase client
      const supabaseUrl = process.env.SUPABASE_URL;
      const supabaseApiKey = process.env.SUPABASE_API_KEY;
      if (!supabaseUrl || !supabaseApiKey) {
        throw new Error('Supabase credentials are missing. Please check your environment variables.');
      }
      this.supabaseClient = createClient(supabaseUrl, supabaseApiKey);

      this.initialized = true;
      console.log('✅ AI Service initialized successfully');
    } catch (error) {
      console.error('❌ Failed to initialize AI Service:', error.message);
      throw error;
    }
  }

  async getQueryEmbedding(query) {
    try {
      if (!this.initialized) await this.initialize();

      const response = await this.openaiClient.embeddings.create({
        input: query.trim(),
        model: this.EMBEDDING_MODEL,
        dimensions: 512
      });

      const embedding = response.data[0].embedding;
      console.log(`✅ Generated embedding for query: "${query.substring(0, 50)}..."`);
      return embedding;
    } catch (error) {
      console.error('❌ Failed to generate embedding:', error.message);
      throw error;
    }
  }

  async searchMovies(queryEmbedding, matchThreshold = this.DEFAULT_MATCH_THRESHOLD, matchCount = this.DEFAULT_MATCH_COUNT) {
    try {
      if (!this.initialized) await this.initialize();

      const { data, error } = await this.supabaseClient.rpc('match_movies_jelly', {
        query_embedding: queryEmbedding,
        match_threshold: matchThreshold,
        match_count: matchCount
      });

      if (error) {
        throw new Error(`Supabase RPC error: ${error.message}`);
      }

      if (data && data.length > 0) {
        console.log(`✅ Found ${data.length} matching movies`);
        return data;
      } else {
        console.log('ℹ️ No matching movies found');
        return [];
      }
    } catch (error) {
      console.error('❌ Error searching movies:', error.message);
      throw error;
    }
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
        matchThreshold = this.DEFAULT_MATCH_THRESHOLD,
        matchCount = this.DEFAULT_MATCH_COUNT,
        includeSources = false
      } = options;

      console.log(`🔍 Searching for: "${query}"`);

      // Get embedding for user query
      const queryEmbedding = await this.getQueryEmbedding(query);

      // Search for similar movies
      const matches = await this.searchMovies(queryEmbedding, matchThreshold, matchCount);

      if (!matches || matches.length === 0) {
        return {
          success: false,
          message: 'No movies found matching your query. Try rephrasing your question or using different keywords.',
          suggestions: null,
          sources: []
        };
      }

      // Extract movie contexts
      const movieContexts = matches.map(match => match.content);

      // Generate AI response
      const aiResponse = await this.generateMovieResponse(movieContexts, query);

      return {
        success: true,
        message: aiResponse,
        suggestions: aiResponse,
        sources: includeSources ? matches : [],
        matchCount: matches.length
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
    return !!(process.env.OPENAI_API_KEY && process.env.SUPABASE_URL && process.env.SUPABASE_API_KEY);
  }
}

module.exports = new AIService(); 