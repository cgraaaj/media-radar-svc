const axios = require('axios');
const db = require('../config/database');
const { normalizeLanguage, cleanFilename, formatFileSize, extractSizeFromFilename, getSafePosterUrl, analyzeGenreFromTitle } = require('../helpers/utils');

// External-API timeout (TMDB/OMDb). Lower than the old hard-coded 5s so a
// single slow upstream can't dominate page latency.
const API_TIMEOUT_MS = parseInt(process.env.MEDIA_API_TIMEOUT_MS || '4000', 10);

// Enrichment cache tuning. The metadata for a (title, year) is effectively
// immutable, so we cache aggressively. Negative (not-found) results are
// cached for a shorter window so newly-added titles get a retry sooner.
const ENRICH_CACHE_TTL_MS = parseInt(process.env.ENRICH_CACHE_TTL_MS || String(7 * 24 * 60 * 60 * 1000), 10);
const ENRICH_NEG_TTL_MS = parseInt(process.env.ENRICH_NEG_TTL_MS || String(6 * 60 * 60 * 1000), 10);
const ENRICH_MEM_MAX = parseInt(process.env.ENRICH_MEM_MAX || '5000', 10);
const ENRICH_REDIS_PREFIX = process.env.ENRICH_REDIS_PREFIX || 'media_radar_enrich:';
const ENRICH_REDIS_ENABLED = (process.env.ENRICH_REDIS_CACHE || '1') !== '0';
// How many entries to enrich in parallel per page. Bounded so we stay well
// under TMDB's rate limit while collapsing the old 5-wide + 100ms-sleep batch
// loop (which serialised a page into ~20s on a cold cache).
const ENRICH_CONCURRENCY = parseInt(process.env.ENRICH_CONCURRENCY || '10', 10);

// API configurations from environment variables
const TMDB_API_KEY = process.env.TMDB_API_KEY ;
const TMDB_ACCESS_TOKEN = process.env.TMDB_ACCESS_TOKEN ;
const TMDB_BASE_URL = process.env.TMDB_BASE_URL ;
const TMDB_IMAGE_BASE_URL = process.env.TMDB_IMAGE_BASE_URL ;

const OMDB_API_KEY = process.env.OMDB_API_KEY ;
const OMDB_BASE_URL = process.env.OMDB_BASE_URL ;

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
        timeout: API_TIMEOUT_MS
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
        timeout: API_TIMEOUT_MS
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

  // -------------------------------------------------------------------------
  // Source-aware file normalizer
  // -------------------------------------------------------------------------
  //
  // The unified crawler writes each quality as `{direct:[…], torrent:[…], magnet:[…]}`
  // where the shape differs per kind. The UI only cares about a flat, uniform
  // list of "downloadable files" with a common set of fields. This function
  // turns the raw bucket into that flat list.
  //
  // Output shape (per file):
  //   {
  //     source: "hdhub4u" | "1tamilmv",
  //     kind:   "direct" | "torrent" | "magnet",
  //     filename, originalFilename, size, sizeSource,
  //     href,                 // best action URL: finalUrl | torrentUrl | magnet | originalUrl
  //     magnetLink,           // always present for magnet/ paired torrent-magnet
  //     torrentUrl,           // .torrent URL if any
  //     status,               // direct: resolved | cpm_gated | stream | null
  //     host, label,          // for direct links
  //     postUrl, postTitle,   // origin post on the source site
  //     language, releaseYear,
  //     posterUrl, addedAt,
  //     sourceLabel,          // "HDHub4u" / "1TamilMV" for display
  //     season, episode, episodeRange (for TV shows)
  //   }
  // -------------------------------------------------------------------------
  normalizeFile(rawFile, mediaType, aggregates) {
    if (!rawFile || typeof rawFile !== 'object') return null;

    const kind = rawFile.kind ||
      (rawFile.magnet ? 'magnet' : (rawFile.torrentUrl ? 'torrent' : 'direct'));

    const source = rawFile.source ||
      (rawFile.torrentUrl && /1tamilmv/i.test(rawFile.torrentUrl) ? '1tamilmv' :
       rawFile.magnet && /1tamilmv/i.test(rawFile.magnet) ? '1tamilmv' :
       'hdhub4u');

    const filename = rawFile.filename || rawFile.name || null;
    const rawSize = rawFile.size;

    const processed = {
      source,
      kind,
      sourceLabel: source === '1tamilmv' ? '1TamilMV' : (source === 'hdhub4u' ? 'HDHub4u' : source),
      filename: filename ? cleanFilename(filename) : (rawFile.label || rawFile.pageTitle || 'Unknown'),
      originalFilename: filename,
      size: formatFileSize(rawSize) || (filename ? extractSizeFromFilename(filename) : 'Unknown'),
      sizeSource: rawSize ? 'redis_metadata' : 'filename_extraction',
      postUrl: rawFile.postUrl || rawFile.sourceUrl || null,
      postTitle: rawFile.postTitle || rawFile.pageTitle || null,
      posterUrl: rawFile.posterUrl || null,
      addedAt: rawFile.addedAt || rawFile.shareDate || null,
      status: rawFile.status || null,
      host: rawFile.host || null,
      label: rawFile.label || null,
      originalUrl: rawFile.originalUrl || null,
      // Stable redirector URL the frontend should hand to /api/links/resolve
      // when it needs to convert an ad-gated entry into a final URL on click.
      // Cold-radar emits both fields with the same value; we surface them both
      // for forward compatibility (originalUrl predates intermediateUrl).
      intermediateUrl: rawFile.intermediateUrl || rawFile.originalUrl || null,
      finalUrl: rawFile.finalUrl || null,
      magnetLink: null,
      torrentUrl: null,
      href: '#',
    };

    // Kind-specific best-action URL.
    if (kind === 'magnet') {
      processed.magnetLink = rawFile.magnet || rawFile.magnetLink || null;
      processed.href = processed.magnetLink || '#';
    } else if (kind === 'torrent') {
      processed.torrentUrl = rawFile.torrentUrl || null;
      processed.href = processed.torrentUrl || '#';
    } else {
      // direct
      processed.href = rawFile.finalUrl || rawFile.originalUrl || rawFile.href || rawFile.url || '#';
    }

    // Language normalization + collect the aggregated list.
    if (rawFile.language) {
      const normalizedLang = normalizeLanguage(rawFile.language);
      if (normalizedLang) {
        processed.language = normalizedLang;
        if (aggregates && !aggregates.languages.includes(normalizedLang)) {
          aggregates.languages.push(normalizedLang);
        }
      }
    }

    // Release year from filename.
    if (filename) {
      const yearMatch = filename.match(/\b(19|20)\d{2}\b/);
      if (yearMatch) processed.releaseYear = parseInt(yearMatch[0], 10);
    }

    // TV show season/episode metadata.
    if (mediaType === 'tvshow' && filename) {
      const seasonMatch = filename.match(/[Ss](\d+)/);
      const episodeMatch = filename.match(/[Ee](\d+)/);
      if (seasonMatch) processed.season = parseInt(seasonMatch[1], 10);
      if (episodeMatch) processed.episode = parseInt(episodeMatch[1], 10);
      const rangeMatch = filename.match(/[Ee](\d+)-[Ee](\d+)/);
      if (rangeMatch) {
        processed.episodeRange = {
          start: parseInt(rangeMatch[1], 10),
          end: parseInt(rangeMatch[2], 10),
        };
      }
    }

    if (processed.posterUrl && aggregates && !aggregates.moviePosterUrl) {
      aggregates.moviePosterUrl = processed.posterUrl;
    }
    if (aggregates) {
      aggregates.sources.add(source);
      aggregates.kinds.add(kind);
    }

    return processed;
  }

  /**
   * Transforms the Redis quality data into the UI-friendly shape:
   *   {
   *     downloadOptions:  { "4k": [file,…], "1080p": [...] ... },
   *     downloadLanguages:{ available: [] },
   *     totalFiles, moviePosterUrl,
   *     availableSources: ["hdhub4u","1tamilmv"],
   *     availableKinds:   ["direct","torrent","magnet"]
   *   }
   *
   * Tolerant of BOTH schemas:
   *   - NEW: qualities = { "1080p": { direct, torrent, magnet } }
   *   - OLD: qualityData = { "1080p": [files] }
   */
  processDownloadData(qualityData, mediaType = 'movie') {
    const downloadOptions = {};
    const aggregates = {
      languages: [],
      moviePosterUrl: null,
      sources: new Set(),
      kinds: new Set(),
    };

    if (!qualityData || typeof qualityData !== 'object') {
      return {
        downloadOptions,
        downloadLanguages: { available: [] },
        totalFiles: 0,
        moviePosterUrl: null,
        availableSources: [],
        availableKinds: [],
      };
    }

    for (const [quality, bucket] of Object.entries(qualityData)) {
      const files = [];
      if (Array.isArray(bucket)) {
        for (const raw of bucket) {
          const f = this.normalizeFile(raw, mediaType, aggregates);
          if (f) files.push(f);
        }
      } else if (bucket && typeof bucket === 'object') {
        for (const kind of ['direct', 'torrent', 'magnet']) {
          const arr = bucket[kind];
          if (!Array.isArray(arr)) continue;
          for (const raw of arr) {
            const f = this.normalizeFile(
              { ...raw, kind: raw.kind || kind },
              mediaType,
              aggregates,
            );
            if (f) files.push(f);
          }
        }
      }

      if (files.length > 0) {
        // Pair torrent/magnet siblings from the same source so the UI can show
        // both buttons on a single row. Matching is done by info_hash.
        const paired = this.pairTorrentMagnet(files);
        downloadOptions[quality] = paired;
      }
    }

    const totalFiles = Object.values(downloadOptions).reduce((n, arr) => n + arr.length, 0);

    return {
      downloadOptions,
      downloadLanguages: { available: aggregates.languages },
      totalFiles,
      moviePosterUrl: aggregates.moviePosterUrl,
      availableSources: Array.from(aggregates.sources),
      availableKinds: Array.from(aggregates.kinds),
    };
  }

  // Pair torrent + magnet rows that share the same info_hash. The torrent row
  // is preferred (keeps `.torrent` filename metadata) and the magnet URL is
  // attached to it. The stand-alone magnet is then dropped to avoid duplicates.
  pairTorrentMagnet(files) {
    const magnetByHash = new Map();
    for (const f of files) {
      if (f.kind === 'magnet' && f.magnetLink) {
        const m = f.magnetLink.match(/btih:([a-fA-F0-9]{40})/i);
        if (m) magnetByHash.set(m[1].toLowerCase(), f);
      }
    }

    const merged = [];
    const consumedHashes = new Set();
    for (const f of files) {
      if (f.kind === 'torrent' && f.torrentUrl) {
        // Try to pair with a magnet by filename-derived info_hash (best-effort: match by filename)
        const sameName = Array.from(magnetByHash.entries()).find(([, m]) =>
          m.originalFilename && f.originalFilename &&
          m.originalFilename.replace(/\.torrent$/i, '') === f.originalFilename.replace(/\.torrent$/i, '')
        );
        if (sameName) {
          f.magnetLink = sameName[1].magnetLink;
          consumedHashes.add(sameName[0]);
        }
        merged.push(f);
      } else if (f.kind === 'magnet') {
        // Defer; we'll add unmerged magnets after the loop.
        continue;
      } else {
        merged.push(f);
      }
    }
    // Append magnets that didn't pair with any torrent.
    for (const [hash, m] of magnetByHash.entries()) {
      if (!consumedHashes.has(hash)) merged.push(m);
    }
    return merged;
  }

  // -------------------------------------------------------------------------
  // Enrichment cache helpers (in-process LRU+TTL, shared Redis L2)
  // -------------------------------------------------------------------------

  /** Read from the bounded in-process cache, honouring TTL. */
  _memGet(cacheKey) {
    const entry = this.cache.get(cacheKey);
    if (!entry) return null;
    if (entry.exp <= Date.now()) {
      this.cache.delete(cacheKey);
      return null;
    }
    // LRU touch: re-insert to move to the tail.
    this.cache.delete(cacheKey);
    this.cache.set(cacheKey, entry);
    return entry.data;
  }

  /** Write to the bounded in-process cache, evicting the oldest if needed. */
  _memSet(cacheKey, data, ttlMs) {
    this.cache.set(cacheKey, { data, exp: Date.now() + ttlMs });
    while (this.cache.size > ENRICH_MEM_MAX) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
  }

  /** L2 read: shared, restart-surviving Redis cache. Never throws. */
  async _redisGet(cacheKey) {
    if (!ENRICH_REDIS_ENABLED || !db.isConnected()) return null;
    try {
      const raw = await db.redisClient.get(ENRICH_REDIS_PREFIX + cacheKey);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  /** L2 write (fire-and-forget). Never throws. */
  _redisSet(cacheKey, data, ttlMs) {
    if (!ENRICH_REDIS_ENABLED || !db.isConnected()) return;
    // node-redis v4: PX = expiry in ms. Best-effort; we don't await.
    Promise.resolve(
      db.redisClient.set(ENRICH_REDIS_PREFIX + cacheKey, JSON.stringify(data), { PX: ttlMs })
    ).catch(() => {});
  }

  // Get media details with multi-layer caching (in-process L1 + Redis L2).
  //
  // Previously this used an unbounded in-process Map that never expired and
  // was wiped on every restart — so the very first load of every page hit the
  // external TMDB/OMDb APIs serially, which is what produced the ~20s page
  // loads. The Redis L2 cache is shared across replicas and survives restarts,
  // so a title only ever costs one external lookup, ever.
  async getMediaDetails(title, year, mediaType) {
    const cacheKey = `${mediaType}_${title}_${year}`;

    const cached = this._memGet(cacheKey) || await this._redisGet(cacheKey);
    if (cached) {
      // Re-prime L1 if the hit came from L2.
      const ttl = cached.dataSource === 'local' ? ENRICH_NEG_TTL_MS : ENRICH_CACHE_TTL_MS;
      this._memSet(cacheKey, cached, ttl);
      return cached;
    }

    let mediaDetails = null;
    // Try OMDb first, then TMDB as fallback.
    if (mediaType === 'movie') {
      mediaDetails = await this.fetchOMDbMovieDetails(title, year);
      if (!mediaDetails) mediaDetails = await this.fetchTMDBMovieDetails(title, year);
    } else if (mediaType === 'tvshow') {
      mediaDetails = await this.fetchOMDbTVShowDetails(title, year);
      if (!mediaDetails) mediaDetails = await this.fetchTMDBTVShowDetails(title, year);
    }

    // Final fallback to basic data (negative result — cached for a shorter TTL
    // so a title that is added to TMDB later gets re-enriched).
    const isNegative = !mediaDetails;
    if (isNegative) {
      mediaDetails = {
        title,
        year,
        poster: DEFAULT_POSTERS[mediaType + 's'] || DEFAULT_POSTERS.movies,
        genre: analyzeGenreFromTitle(title),
        plot: 'No plot available.',
        hasRealPoster: false,
        dataSource: 'local',
        type: mediaType,
      };
    }

    const ttl = isNegative ? ENRICH_NEG_TTL_MS : ENRICH_CACHE_TTL_MS;
    this._memSet(cacheKey, mediaDetails, ttl);
    this._redisSet(cacheKey, mediaDetails, ttl);

    return mediaDetails;
  }

  // Transform a single [mediaKey, entry] pair into the UI-friendly object.
  async transformOneEntry([mediaKey, entry], globalIndex, mediaType = 'movie') {
    try {
      // New wrapper has type/year/posterUrl/sources/qualities; old flat
      // entries are plain quality maps.
      const wrapper = (entry && typeof entry === 'object' && entry.qualities) ? entry : null;
      const qualityData = wrapper ? wrapper.qualities : entry;

      // Extract title and year from the key, but prefer wrapper.year when set.
      const titleMatch = mediaKey.match(/^(.+?)\s*\((\d{4})\)$/);
      const title = titleMatch ? titleMatch[1].trim() : mediaKey.trim();
      const year = (wrapper && wrapper.year) || (titleMatch ? parseInt(titleMatch[2], 10) : new Date().getFullYear());

      const mediaDetails = await this.getMediaDetails(title, year, mediaType);

      const {
        downloadOptions,
        downloadLanguages,
        totalFiles,
        moviePosterUrl,
        availableSources,
        availableKinds,
      } = this.processDownloadData(qualityData, mediaType);

      // Poster precedence: wrapper.posterUrl > first file.posterUrl > TMDB/OMDb > default.
      const poster = (wrapper && wrapper.posterUrl) || moviePosterUrl || mediaDetails.poster;

      const sources = wrapper && Array.isArray(wrapper.sources) && wrapper.sources.length
        ? wrapper.sources
        : availableSources;

      return {
        id: globalIndex + 1,
        ...mediaDetails,
        poster,
        downloadOptions,
        downloadLanguages,
        totalFiles,
        originalKey: mediaKey,
        sources,
        availableKinds,
        firstSeenAt: wrapper ? wrapper.firstSeenAt : undefined,
        lastUpdatedAt: wrapper ? wrapper.lastUpdatedAt : undefined,
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
        type: mediaType,
        sources: [],
        availableKinds: [],
      };
    }
  }

  // Transform entries to full media objects.
  //
  // Uses a fixed-size worker pool (ENRICH_CONCURRENCY) instead of the old
  // serial "5-wide batch + 100ms sleep" loop. Combined with the Redis-backed
  // enrichment cache, a warm page now returns in a few ms and a cold page is
  // bounded by ~ceil(N / concurrency) external round-trips rather than the
  // previous ~20s. Output order is preserved (results indexed by position).
  async transformMediaEntries(entries, startIndex = 0, mediaType = 'movie') {
    if (!Array.isArray(entries) || entries.length === 0) return [];

    const results = new Array(entries.length);
    let cursor = 0;

    const worker = async () => {
      while (true) {
        const i = cursor++;
        if (i >= entries.length) return;
        results[i] = await this.transformOneEntry(entries[i], startIndex + i, mediaType);
      }
    };

    const poolSize = Math.min(ENRICH_CONCURRENCY, entries.length);
    await Promise.all(Array.from({ length: poolSize }, () => worker()));

    return results;
  }
}

module.exports = new MediaService(); 