const express = require('express');
const cors = require('cors');
require('dotenv').config();

// Import modules
const { isConnected, redisClient } = require('./config/database');
const movieRoutes = require('./routes/movieRoutes');
const tvShowRoutes = require('./routes/tvShowRoutes');
const analysisRoutes = require('./routes/analysisRoutes');

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
const allowedOrigins = process.env.ALLOWED_ORIGINS 
  ? process.env.ALLOWED_ORIGINS.split(',') 
  : ['http://localhost:3000', 'http://127.0.0.1:3000', 'http://192.168.1.72:3000'];

app.use(cors({
  origin: allowedOrigins,
  credentials: true
}));
app.use(express.json());

console.log('🚀 Server modules loaded successfully');

// Routes
app.use('/api/movies', movieRoutes);
app.use('/api/tvshows', tvShowRoutes);
app.use('/api/analyze', analysisRoutes);

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    message: 'Optimized Movie API is running',
    redis: isConnected() ? 'Connected' : 'Disconnected',
    architecture: 'Modular',
    modules: ['config/database', 'services/movieService', 'helpers/utils', 'routes/*']
  });
});

// Redis status endpoint
app.get('/api/redis-status', async (req, res) => {
  try {
    if (isConnected()) {
      const { redisClient } = require('./config/database');
      const keys = await redisClient.keys('*');
      res.json({
        connected: true,
        keys: keys,
        targetKey: 'onetamilmv_movies_cache',
        hasTargetKey: keys.includes('onetamilmv_movies_cache')
      });
    } else {
      res.json({
        connected: false,
        message: 'Redis is not connected'
      });
    }
  } catch (error) {
    res.status(500).json({
      connected: false,
      error: error.message
    });
  }
});

// Root endpoint
app.get('/', (req, res) => {
  res.json({
    message: 'Optimized Movie API Server',
    version: '2.0',
    architecture: 'Modular',
    endpoints: {
      movies: '/api/movies',
      analysis: '/api/analyze',
      health: '/api/health'
    }
  });
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({
    error: 'Internal server error',
    message: err.message
  });
});

// 404 handler
app.use('*', (req, res) => {
  res.status(404).json({
    error: 'Endpoint not found',
    available: ['/api/movies', '/api/analyze', '/api/health']
  });
});

const HOST = process.env.HOST || '0.0.0.0';

app.listen(PORT, HOST, () => {
  console.log(`🎬 Optimized Movie API Server running on http://${HOST}:${PORT}`);
  console.log(`🌍 Environment: ${process.env.NODE_ENV || 'development'}`);
  // Print initial status and keep it accurate with client events
  console.log(`📊 Redis status: ${isConnected() ? '✅ Connected' : '⌛ Connecting...'}`);
  if (redisClient) {
    redisClient.on('ready', () => console.log('📊 Redis status: ✅ Connected'));
    redisClient.on('end', () => console.log('📊 Redis status: ❌ Disconnected'));
  }
  console.log(`🔗 CORS Origins: ${allowedOrigins.join(', ')}`);
  console.log(`🧩 Architecture: Modular (vs. previous monolithic)`);
  console.log(`📁 Modules: Config, Services, Helpers, Routes`);
}); 