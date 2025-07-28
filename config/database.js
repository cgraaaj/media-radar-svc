const redis = require('redis');

// Redis client setup
const redisClient = redis.createClient({
  socket: {
    host: process.env.REDIS_HOST,
    port: process.env.REDIS_PORT,
  },
  password: process.env.REDIS_PASSWORD
});

let redisConnected = false;

redisClient.on('error', (err) => {
  console.log('Redis Client Error:', err.message);
  redisConnected = false;
});

redisClient.on('connect', () => {
  console.log('Connected to Redis successfully');
  redisConnected = true;
});

redisClient.on('disconnect', () => {
  console.log('Disconnected from Redis');
  redisConnected = false;
});

// Connect to Redis
(async () => {
  try {
    await redisClient.connect();
    console.log('Redis connection initiated');
  } catch (error) {
    console.error('Failed to connect to Redis:', error.message);
    redisConnected = false;
  }
})();

module.exports = {
  redisClient,
  isConnected: () => redisConnected
}; 