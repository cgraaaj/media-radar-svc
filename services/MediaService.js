const axios = require('axios');
const { normalizeLanguage, cleanFilename, formatFileSize, extractSizeFromFilename, getSafePosterUrl, analyzeGenreFromTitle } = require('../helpers/utils');

// API configurations from environment variables
const TMDB_API_KEY = process.env.TMDB_API_KEY || '1dd48da5671e983380346d36c3e0257c';
const TMDB_ACCESS_TOKEN = process.env.TMDB_ACCESS_TOKEN || 'eyJhbGciOiJIUzI1NiJ9.eyJhdWQiOiIxZGQ0OGRhNTY3MWU5ODMzODAzNDZkMzZjM2UwMjU3YyIsIm5iZiI6MTc1MzEzODE2Mi4xMzY5OTk4LCJzdWIiOiI2ODdlYzNmMjJiOTMwZmI2ZDU1MjkxODUiLCJzY29wZXMiOlsiYXBpX3JlYWQiXSwidmVyc2lvbiI6MX0.tbDjrzggXfRbjkH4N9OimwYDF1TlDqKj5s4Kfq9kCI8';
const TMDB_BASE_URL = process.env.TMDB_BASE_URL || 'https://api.themoviedb.org/3';
const TMDB_IMAGE_BASE_URL = process.env.TMDB_IMAGE_BASE_URL || 'https://image.tmdb.org/t/p/w500';

const OMDB_API_KEY = process.env.OMDB_API_KEY || '5da92aeb';
const OMDB_BASE_URL = process.env.OMDB_BASE_URL || 'http://www.omdbapi.com/';

const DEFAULT_POSTERS = {
  movies: process.env.DEFAULT_MOVIES_POSTER || 'https://via.placeholder.com/300x450/2a2a2a/ffffff?text=🎬',
  tvshows: process.env.DEFAULT_TVSHOWS_POSTER || 'https://via.placeholder.com/300x450/2a2a2a/ffffff?text=📺'
};

// Caches
const mediaCache = new Map();
const torrentMetadataCache = new Map();

class MediaService {
  constructor() {
    this.cache = mediaCache;
  }

  // Generic TMDB API call
  async callTMDBAPI(endpoint, params = {}) {
    try {
      const response = await axios.get(`${TMDB_BASE_URL}${endpoint}`, {
        params: { api_key: TMDB_API_KEY, ...params },
        headers: { 'Authorization': `Bearer ${TMDB_ACCESS_TOKEN}` },
        timeout: 5000
      });
      return response.data;
    } catch (error) {
      console.log(`TMDB API call failed for ${endpoint}:`, error.message);
      return null;
    }
  }

  // Generic OMDb API call
  async callOMDbAPI(params = {}) {
    try {
      const response = await axios.get(OMDB_BASE_URL, {
        params: { apikey: OMDB_API_KEY, ...params },
        timeout: 5000
      });
      return response.data?.Response === 'True' ? response.data : null;
    } catch (error) {
      console.log(`OMDb API call failed:`, error.message);
      return null;
    }
  }

  // Fetch movie details from TMDB
  async fetchTMDBMovieDetails(title, year) {
    console.log(`Searching TMDB for movie: ${title} (${year})`);
    
    const searchData = await this.callTMDBAPI('/search/movie', {
      query: title,
      year: year,
      include_adult: false
    });

    if (searchData?.results?.length > 0) {
      const movie = searchData.results[0];
      const detailsData = await this.callTMDBAPI(`/movie/${movie.id}`, {
        append_to_response: 'credits,videos'
      });

      if (detailsData) {
        return this.formatTMDBMovieData({...detailsData, actual_title: title});
      }
    }
    return null;
  }

  // Fetch TV show details from TMDB
  async fetchTMDBTVShowDetails(title, year) {
    console.log(`Searching TMDB for TV show: ${title} (${year})`);
    
    const searchData = await this.callTMDBAPI('/search/tv', {
      query: title,
      first_air_date_year: year,
      include_adult: false
    });

    if (searchData?.results?.length > 0) {
      const tvShow = searchData.results[0];
      
      const detailsData = await this.callTMDBAPI(`/tv/${tvShow.id}`, {
        append_to_response: 'credits,videos'
      });

      if (detailsData) {
        return this.formatTMDBTVShowData(detailsData);
      }
    }
    return null;
  }

  // Fetch movie details from OMDb
  async fetchOMDbMovieDetails(title, year) {
    console.log(`Searching OMDb for movie: ${title} (${year})`);
    
    const movieData = await this.callOMDbAPI({
      t: title,
      y: year,
      type: 'movie',
      plot: 'full'
    });

    return movieData ? this.formatOMDbMovieData(movieData) : null;
  }

  // Fetch TV show details from OMDb
  async fetchOMDbTVShowDetails(title, year) {
    console.log(`Searching OMDb for TV show: ${title} (${year})`);
    
    const showData = await this.callOMDbAPI({
      t: title,
      y: year,
      type: 'series',
      plot: 'full'
    });

    return showData ? this.formatOMDbTVShowData(showData) : null;
  }

  // Format TMDB movie data
  formatTMDBMovieData(movieDetails) {
    const credits = movieDetails.credits || {};
    const directors = credits.crew?.filter(person => person.job === 'Director')
      ?.slice(0, 3)?.map(person => person.name)?.join(', ') || 'N/A';
    const actors = credits.cast?.slice(0, 5)?.map(actor => actor.name)?.join(', ') || 'N/A';

    return {
      title: movieDetails.actual_title || movieDetails.title || movieDetails.original_title,
      tagline: movieDetails.tagline || '',
      year: movieDetails.release_date ? new Date(movieDetails.release_date).getFullYear() : null,
      releaseDate: movieDetails.release_date,
      poster: movieDetails.poster_path ? `${TMDB_IMAGE_BASE_URL}${movieDetails.poster_path}` : DEFAULT_POSTERS.movies,
      backdrop: movieDetails.actual_title === movieDetails.title ? movieDetails.backdrop_path ? `${TMDB_IMAGE_BASE_URL}${movieDetails.backdrop_path}` : null : null,
      plot: movieDetails.overview || 'No plot available.',
      genre: movieDetails.genres?.map(g => g.name)?.join(', ') || 'Unknown',
      director: directors,
      actors: actors,
      country: movieDetails.production_countries?.map(c => c.name)?.join(', ') || 'N/A',
      language: movieDetails.original_language || 'N/A',
      runtime: movieDetails.runtime ? `${movieDetails.runtime} min` : null,
      tmdbRating: movieDetails.vote_average ? movieDetails.vote_average.toFixed(1) : null,
      tmdbId: movieDetails.id,
      hasRealPoster: !!movieDetails.poster_path,
      dataSource: 'tmdb',
      type: 'movie'
    };
  }

  // Format TMDB TV show data
  formatTMDBTVShowData(showDetails) {
    const credits = showDetails.credits || {};
    const creators = credits.crew?.filter(person => person.job === 'Executive Producer' || person.job === 'Creator')
      ?.slice(0, 3)?.map(person => person.name)?.join(', ') || 'N/A';
    const actors = credits.cast?.slice(0, 5)?.map(actor => actor.name)?.join(', ') || 'N/A';

    return {
      title: showDetails.name || showDetails.original_name,
      tagline: showDetails.tagline || '',
      year: showDetails.first_air_date ? new Date(showDetails.first_air_date).getFullYear() : null,
      releaseDate: showDetails.first_air_date,
      endDate: showDetails.last_air_date,
      poster: showDetails.poster_path ? `${TMDB_IMAGE_BASE_URL}${showDetails.poster_path}` : DEFAULT_POSTERS.tvshows,
      backdrop: showDetails.backdrop_path ? `${TMDB_IMAGE_BASE_URL}${showDetails.backdrop_path}` : null,
      plot: showDetails.overview || 'No plot available.',
      genre: showDetails.genres?.map(g => g.name)?.join(', ') || 'Unknown',
      director: creators,
      actors: actors,
      country: showDetails.origin_country?.join(', ') || 'N/A',
      language: showDetails.original_language || 'N/A',
      seasons: showDetails.number_of_seasons || 0,
      episodes: showDetails.number_of_episodes || 0,
      status: showDetails.status || 'Unknown',
      networks: showDetails.networks?.map(n => n.name)?.join(', ') || 'N/A',
      tmdbRating: showDetails.vote_average ? showDetails.vote_average.toFixed(1) : null,
      tmdbId: showDetails.id,
      hasRealPoster: !!showDetails.poster_path,
      dataSource: 'tmdb',
      type: 'tvshow'
    };
  }

  // Format OMDb movie data
  formatOMDbMovieData(movie) {
    return {
      title: movie.Title,
      tagline: '',
      year: parseInt(movie.Year) || null,
      releaseDate: movie.Released !== 'N/A' ? movie.Released : null,
      poster: movie.Poster !== 'N/A' ? getSafePosterUrl(movie) : DEFAULT_POSTERS.movies,
      plot: movie.Plot !== 'N/A' ? movie.Plot : 'No plot available.',
      genre: movie.Genre !== 'N/A' ? movie.Genre : 'Unknown',
      director: movie.Director !== 'N/A' ? movie.Director : 'N/A',
      actors: movie.Actors !== 'N/A' ? movie.Actors : 'N/A',
      country: movie.Country !== 'N/A' ? movie.Country : 'N/A',
      language: movie.Language !== 'N/A' ? movie.Language : 'N/A',
      runtime: movie.Runtime !== 'N/A' ? movie.Runtime : null,
      imdbRating: movie.imdbRating !== 'N/A' ? movie.imdbRating : null,
      imdbId: movie.imdbID,
      hasRealPoster: movie.Poster !== 'N/A' && movie.Poster !== DEFAULT_POSTERS.movies,
      dataSource: 'omdb',
      type: 'movie'
    };
  }

  // Format OMDb TV show data
  formatOMDbTVShowData(show) {
    // console.log(`Formatting OMDb TV show data: ${JSON.stringify(show)}`);
    return {
      title: show.Title,
      tagline: '',
      year: parseInt(show.Year) || null,
      releaseDate: show.Released !== 'N/A' ? show.Released : null,
      poster: show.Poster !== 'N/A' ? getSafePosterUrl(show.Poster, show.Title, 0) : DEFAULT_POSTERS.tvshows,
      plot: show.Plot !== 'N/A' ? show.Plot : 'No plot available.',
      genre: show.Genre !== 'N/A' ? show.Genre : 'Unknown',
      director: show.Director !== 'N/A' ? show.Director : 'N/A',
      actors: show.Actors !== 'N/A' ? show.Actors : 'N/A',
      country: show.Country !== 'N/A' ? show.Country : 'N/A',
      language: show.Language !== 'N/A' ? show.Language : 'N/A',
      runtime: show.Runtime !== 'N/A' ? show.Runtime : null,
      imdbRating: show.imdbRating !== 'N/A' ? show.imdbRating : null,
      imdbId: show.imdbID,
      totalSeasons: show.totalSeasons ? parseInt(show.totalSeasons) : 0,
      hasRealPoster: show.Poster !== 'N/A' && show.Poster !== DEFAULT_POSTERS.tvshows,
      dataSource: 'omdb',
      type: 'tvshow'
    };
  }

  // Process download data for any media type
  processDownloadData(qualityData, mediaType = 'movie') {
    const downloadOptions = {};
    const downloadLanguages = { available: [] };
    let moviePosterUrl = null;
    
    Object.entries(qualityData).forEach(([quality, files]) => {
      if (Array.isArray(files) && files.length > 0) {
        downloadOptions[quality] = files.map(file => {
          // Extract posterUrl from file data (use first available posterUrl)
          if (file.posterUrl && !moviePosterUrl) {
            moviePosterUrl = file.posterUrl;
          }

          const processedFile = {
            filename: cleanFilename(file.filename || file.name || 'Unknown'),
            originalFilename: file.filename || file.name,
            href: file.href || file.url || '#',
            size: formatFileSize(file.size) || extractSizeFromFilename(file.filename || ''),
            sizeSource: file.size ? 'redis_metadata' : 'filename_extraction'
          };

          // Add magnetLink support from new backend structure
          if (file.magnetLink) {
            processedFile.magnetLink = file.magnetLink;
          }

          // Extract TV show specific metadata
          if (mediaType === 'tvshow' && file.filename) {
            const seasonMatch = file.filename.match(/[Ss](\d+)/);
            const episodeMatch = file.filename.match(/[Ee](\d+)/);
            
            if (seasonMatch) processedFile.season = parseInt(seasonMatch[1]);
            if (episodeMatch) processedFile.episode = parseInt(episodeMatch[1]);
            
            const episodeRangeMatch = file.filename.match(/[Ee](\d+)-[Ee](\d+)/);
            if (episodeRangeMatch) {
              processedFile.episodeRange = {
                start: parseInt(episodeRangeMatch[1]),
                end: parseInt(episodeRangeMatch[2])
              };
            }
          }

          // Language processing
          if (file.language) {
            const normalizedLang = normalizeLanguage(file.language);
            if (normalizedLang) {
              processedFile.language = normalizedLang;
              if (!downloadLanguages.available.includes(normalizedLang)) {
                downloadLanguages.available.push(normalizedLang);
              }
            }
          }

          // Release year extraction
          if (file.filename) {
            const yearMatch = file.filename.match(/\b(19|20)\d{2}\b/);
            if (yearMatch) {
              processedFile.releaseYear = parseInt(yearMatch[0]);
            }
          }

          return processedFile;
        });
      }
    });

    const totalFiles = Object.values(downloadOptions)
      .reduce((total, files) => total + files.length, 0);

    return { downloadOptions, downloadLanguages, totalFiles, moviePosterUrl };
  }

  // Get media details with caching
  async getMediaDetails(title, year, mediaType) {
    const cacheKey = `${title}_${year}_${mediaType}`;
    let mediaDetails = this.cache.get(cacheKey);
    
    if (!mediaDetails) {
      // Try TMDB first, then OMDb as fallback
      if (mediaType === 'movie') {
        mediaDetails = await this.fetchOMDbMovieDetails(title, year);
          if (!mediaDetails) {
            mediaDetails = await this.fetchTMDBMovieDetails(title, year);
        }
      } else if (mediaType === 'tvshow') {
        mediaDetails = await this.fetchOMDbTVShowDetails(title, year);
          if (!mediaDetails) {
            mediaDetails = await this.fetchTMDBTVShowDetails(title, year);
        }
      }
      
      // Final fallback to basic data
      if (!mediaDetails) {
        mediaDetails = {
          title: title,
          year: year,
          poster: DEFAULT_POSTERS[mediaType + 's'] || DEFAULT_POSTERS.movies,
          genre: analyzeGenreFromTitle(title),
          plot: 'No plot available.',
          hasRealPoster: false,
          dataSource: 'local',
          type: mediaType
        };
      }
      
      // Cache the result
      this.cache.set(cacheKey, mediaDetails);
    }
    
    return mediaDetails;
  }

  // Transform entries to full media objects
  async transformMediaEntries(entries, startIndex = 0, mediaType = 'movie') {
    const transformedMedia = [];
    const batchSize = 5;
    
    for (let i = 0; i < entries.length; i += batchSize) {
      const batch = entries.slice(i, i + batchSize);
      const batchPromises = batch.map(async ([mediaKey, qualityData], batchIndex) => {
        const globalIndex = startIndex + i + batchIndex;
        
        try {
          // Extract title and year from the key
          const titleMatch = mediaKey.match(/^(.+?)\s*\((\d{4})\)$/);
          const title = titleMatch ? titleMatch[1].trim() : mediaKey.trim();
          const year = titleMatch ? parseInt(titleMatch[2]) : new Date().getFullYear();
          
          // Get media details
          const mediaDetails = await this.getMediaDetails(title, year, mediaType);
          
          // Process download data
          const { downloadOptions, downloadLanguages, totalFiles, moviePosterUrl } = this.processDownloadData(qualityData, mediaType);
          
          // Create the final media object
          return {
            id: globalIndex + 1,
            ...mediaDetails,
            // Prioritize posterUrl from backend data, then fallback to TMDB/OMDB
            poster: moviePosterUrl || mediaDetails.poster,
            downloadOptions,
            downloadLanguages,
            totalFiles,
            originalKey: mediaKey
          };
          
        } catch (error) {
          console.error(`Error transforming media ${mediaKey}:`, error);
          return {
            id: globalIndex + 1,
            title: mediaKey,
            year: new Date().getFullYear(),
            poster: DEFAULT_POSTERS[mediaType + 's'] || DEFAULT_POSTERS.movies,
            genre: 'Unknown',
            downloadOptions: {},
            totalFiles: 0,
            hasRealPoster: false,
            dataSource: 'error',
            error: error.message,
            type: mediaType
          };
        }
      });
      
      const batchResults = await Promise.all(batchPromises);
      transformedMedia.push(...batchResults);
      
      // Add a small delay between batches to prevent rate limiting
      if (i + batchSize < entries.length) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
    
    return transformedMedia;
  }
}

module.exports = new MediaService(); 