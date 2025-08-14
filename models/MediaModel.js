const db = require('../config/database');

class MediaModel {
  constructor() {
    this.cacheKey = process.env.REDIS_CACHE_KEY || 'media_radar_cache';
  }

  async getAllMedia() {
    if (!db.isConnected()) {
      throw new Error('Redis is not connected');
    }

    const cachedData = await db.redisClient.get(this.cacheKey);
    if (!cachedData) {
      throw new Error('No media data found in cache');
    }

    return JSON.parse(cachedData);
  }

  async getMediaByType(type, page = 1, limit = 20) {
    const rawData = await this.getAllMedia();
    const offset = (page - 1) * limit;
    
    // Handle different data structures
    let mediaObj;
    let dataStructure = 'unknown';
    
    if (Array.isArray(rawData)) {
      if (rawData.length > 0 && typeof rawData[0] === 'object') {
        mediaObj = rawData[0];
        dataStructure = 'array_wrapped';
      } else {
        throw new Error('Invalid array structure in Redis data');
      }
    } else if (typeof rawData === 'object' && rawData !== null) {
      // Check for type-specific nested structure
      if (rawData[type] && typeof rawData[type] === 'object') {
        mediaObj = rawData[type];
        dataStructure = 'nested_object';
      } else if (rawData.movies && rawData.tvshows) {
        // Both movies and tvshows in same object
        mediaObj = rawData[type] || {};
        dataStructure = 'split_object';
      } else {
        // Assume all data is mixed and needs filtering
        mediaObj = rawData;
        dataStructure = 'mixed_object';
      }
    } else {
      throw new Error('Invalid data type in Redis cache');
    }

    // Filter by type if needed (for mixed data)
    let filteredEntries;
    if (dataStructure === 'mixed_object') {
      filteredEntries = Object.entries(mediaObj).filter(([key, data]) => {
        // Implement logic to determine if entry is movie or TV show
        return this.determineMediaType(key, data) === type;
      });
    } else {
      filteredEntries = Object.entries(mediaObj);
    }

    // Filter entries that have download options
    const entriesWithDownloads = filteredEntries.filter(([key, qualityData]) => {
      const totalFiles = Object.values(qualityData || {})
        .reduce((total, files) => total + (Array.isArray(files) ? files.length : 0), 0);
      return totalFiles > 0;
    });

    const totalItems = entriesWithDownloads.length;
    const totalPages = Math.ceil(totalItems / limit);
    const paginatedEntries = entriesWithDownloads.slice(offset, offset + limit);

    return {
      entries: paginatedEntries,
      pagination: {
        currentPage: page,
        totalPages,
        totalItems,
        itemsPerPage: limit,
        hasNextPage: page < totalPages,
        hasPrevPage: page > 1
      },
      metadata: {
        dataStructure,
        totalInRedis: Object.keys(mediaObj).length,
        filteredCount: totalItems
      }
    };
  }

  async getMediaById(type, id) {
    const { entries } = await this.getMediaByType(type, 1, 1000); // Get all to find by ID
    
    if (id > 0 && id <= entries.length) {
      return entries[id - 1];
    }
    
    throw new Error(`${type} not found`);
  }

  async getMediaByQuality(type, quality, page = 1, limit = 20) {
    const { entries } = await this.getMediaByType(type, 1, 10000); // Get all for filtering
    const offset = (page - 1) * limit;
    
    const filteredEntries = entries.filter(([key, qualityData]) => {
      return qualityData[quality] && Array.isArray(qualityData[quality]) && qualityData[quality].length > 0;
    });
    
    const totalFiltered = filteredEntries.length;
    const paginatedEntries = filteredEntries.slice(offset, offset + limit);
    
    return {
      entries: paginatedEntries,
      pagination: {
        currentPage: page,
        totalPages: Math.ceil(totalFiltered / limit),
        totalItems: totalFiltered,
        itemsPerPage: limit,
        hasNextPage: page < Math.ceil(totalFiltered / limit),
        hasPrevPage: page > 1
      },
      filter: {
        quality,
        totalFound: totalFiltered
      }
    };
  }

  async getMediaByLanguage(type, language, page = 1, limit = 20) {
    const { entries } = await this.getMediaByType(type, 1, 10000); // Get all for filtering
    const offset = (page - 1) * limit;
    
    const filteredEntries = entries.filter(([key, qualityData]) => {
      return Object.values(qualityData).some(files => 
        Array.isArray(files) && files.some(file => {
          const fileLanguage = file.language || '';
          return fileLanguage.toLowerCase().includes(language.toLowerCase());
        })
      );
    });
    
    const totalFiltered = filteredEntries.length;
    const paginatedEntries = filteredEntries.slice(offset, offset + limit);
    
    return {
      entries: paginatedEntries,
      pagination: {
        currentPage: page,
        totalPages: Math.ceil(totalFiltered / limit),
        totalItems: totalFiltered,
        itemsPerPage: limit,
        hasNextPage: page < Math.ceil(totalFiltered / limit),
        hasPrevPage: page > 1
      },
      filter: {
        language,
        totalFound: totalFiltered
      }
    };
  }

  // Helper method to determine if an entry is a movie or TV show
  determineMediaType(key, data) {
    // Check for TV show indicators in the key or data
    const tvIndicators = [
      /\bS\d+/i,           // Season pattern (S01, S1, etc.)
      /\bSeason\s+\d+/i,   // Season word
      /\bEpisode/i,        // Episode word
      /\bTV\s+Show/i,      // TV Show
      /\bSeries/i,         // Series
      /\bComplete\s+Series/i // Complete Series
    ];

    const keyString = key.toLowerCase();
    const hasSeasonEpisode = tvIndicators.some(pattern => pattern.test(keyString));
    
    // Check file names for season/episode patterns
    const hasSeasonEpisodeInFiles = Object.values(data || {}).some(files =>
      Array.isArray(files) && files.some(file => {
        const filename = (file.filename || '').toLowerCase();
        return tvIndicators.some(pattern => pattern.test(filename));
      })
    );

    return (hasSeasonEpisode || hasSeasonEpisodeInFiles) ? 'tvshows' : 'movies';
  }
}

module.exports = new MediaModel(); 