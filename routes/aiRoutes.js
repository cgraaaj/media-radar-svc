const express = require('express');
const router = express.Router();
const AIController = require('../controllers/AIController');

// Get AI-powered movie suggestions
router.post('/suggestions', AIController.getMovieSuggestions.bind(AIController));

// Get AI service status
router.get('/status', AIController.getStatus.bind(AIController));

// Get example queries
router.get('/examples', AIController.getExampleQueries.bind(AIController));

// Get watch link for a movie
router.post('/watch', AIController.getWatchLink.bind(AIController));

module.exports = router; 