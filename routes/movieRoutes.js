const express = require('express');
const router = express.Router();
const MovieController = require('../controllers/MovieController');

// Get movies with pagination
router.get('/', MovieController.getMovies.bind(MovieController));

// Search movies with pagination
router.get('/search', MovieController.searchMovies.bind(MovieController));

// Get specific movie details
router.get('/:id', MovieController.getMovieById.bind(MovieController));

// Get movies by quality
router.get('/by-quality/:quality', MovieController.getMoviesByQuality.bind(MovieController));

// Get movies by language
router.get('/by-language/:language', MovieController.getMoviesByLanguage.bind(MovieController));

module.exports = router; 