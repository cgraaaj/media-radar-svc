const express = require('express');
const cors = require('cors');
require('dotenv').config();

// Import modules
const { isConnected, redisClient } = require('./config/database');
const movieRoutes = require('./routes/movieRoutes');
const tvShowRoutes = require('./routes/tvShowRoutes');
const analysisRoutes = require('./routes/analysisRoutes');
const aiRoutes = require('./routes/aiRoutes');
const logger = require('./config/logger');
const { randomUUID } = require('crypto');

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
const allowedOrigins = process.env.ALLOWED_ORIGINS 
  ? process.env.ALLOWED_ORIGINS.split(',') 
  : ['http://localhost:3000', 'http://127.0.0.1:3000', 'http://192.168.1.72:3000'];

// Request ID + basic access log
app.use((req, res, next) => {
  req.id = req.headers['x-request-id'] || randomUUID();
  res.setHeader('x-request-id', req.id);
  const start = Date.now();
  res.on('finish', () => {
    logger.info('http', { id: req.id, method: req.method, path: req.originalUrl, status: res.statusCode, ms: Date.now() - start });
  });
  next();
});

// Enhanced CORS configuration for development
const corsOptions = {
  origin: function (origin, callback) {
    // Allow requests with no origin (like mobile apps or curl requests)
    if (!origin) return callback(null, true);
    
    // Allow localhost on any port for development
    if (origin.includes('localhost') || origin.includes('127.0.0.1')) {
      return callback(null, true);
    }
    
    // Check against allowed origins
    if (allowedOrigins.indexOf(origin) !== -1) {
      return callback(null, true);
    }
    
    logger.warn('CORS blocked origin:', origin);
    return callback(new Error('Not allowed by CORS'));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-request-id']
};

app.use(cors(corsOptions));
app.use(express.json());

logger.info('Server modules loaded successfully');

// Routes
app.use('/api/movies', movieRoutes);
app.use('/api/tvshows', tvShowRoutes);
app.use('/api/analyze', analysisRoutes);
app.use('/api/ai', aiRoutes);

// Health endpoints
app.get('/healthz', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});
app.get('/readyz', (req, res) => {
  res.json({ status: isConnected() ? 'ready' : 'not-ready', redis: isConnected() });
});

// Root endpoint
app.get('/', (req, res) => {
  res.json({
    message: 'Optimized Movie API Server',
    version: '2.0',
    architecture: 'Modular',
    endpoints: { 
      movies: '/api/movies', 
      tvshows: '/api/tvshows',
      analysis: '/api/analyze', 
      ai: '/api/ai',
      health: '/healthz', 
      ready: '/readyz' 
    }
  });
});

// Error handling middleware
app.use((err, req, res, next) => {
  logger.error('Unhandled error', { id: req.id, error: err.message, stack: err.stack });
  res.status(500).json({ error: 'Internal server error', message: err.message, id: req.id });
});

const HOST = process.env.HOST || '0.0.0.0';
const server = app.listen(PORT, HOST, () => {
  logger.info(`Server running`, { url: `http://${HOST}:${PORT}`, env: process.env.NODE_ENV || 'development' });
  logger.info('Redis status', { connected: isConnected() });
  if (redisClient) {
    redisClient.on('ready', () => logger.info('Redis status', { connected: true }));
    redisClient.on('end', () => logger.info('Redis status', { connected: false }));
  }
  logger.info('CORS Origins', { origins: allowedOrigins });
});

// Graceful shutdown
async function shutdown(signal) {
  try {
    logger.warn('Shutting down', { signal });
    server.close(() => logger.info('HTTP server closed'));
    if (redisClient) {
      try { await redisClient.quit(); } catch { try { await redisClient.disconnect(); } catch {} }
      logger.info('Redis client closed');
    }
  } catch (e) {
    logger.error('Shutdown error', { error: e.message });
  } finally {
    process.exit(0);
  }
}

['SIGINT', 'SIGTERM'].forEach(sig => process.on(sig, () => shutdown(sig))); 