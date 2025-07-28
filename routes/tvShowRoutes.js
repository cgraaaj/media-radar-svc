const express = require('express');
const router = express.Router();
const TVShowController = require('../controllers/TVShowController');

// Get TV shows with pagination
router.get('/', TVShowController.getTVShows.bind(TVShowController));

// Get specific TV show details
router.get('/:id', TVShowController.getTVShowById.bind(TVShowController));

// Get TV shows by quality
router.get('/by-quality/:quality', TVShowController.getTVShowsByQuality.bind(TVShowController));

// Get TV shows by language
router.get('/by-language/:language', TVShowController.getTVShowsByLanguage.bind(TVShowController));

module.exports = router; 