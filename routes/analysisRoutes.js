const express = require('express');
const router = express.Router();
const db = require('../config/database');
const { normalizeLanguage } = require('../helpers/utils');
const MediaModel = require('../models/MediaModel');

// Get Redis root keys and special sections data
router.get('/redis-keys', async (req, res) => {
  try {
    if (!db.isConnected()) {
      return res.status(503).json({ error: 'Redis is not connected' });
    }

    const rawData = await db.redisClient.get('media_radar_cache');
    if (!rawData) {
      return res.status(404).json({ error: 'No data found in Redis' });
    }

    const parsedData = JSON.parse(rawData);

    const response = {
      rootKeys: Object.keys(parsedData),
      schemaVersion: parsedData?.metadata?.version || 'legacy',
      sizeBytes: rawData.length,
    };

    // New schema: sections.oneTamilMv (and possibly others)
    if (parsedData.sections && typeof parsedData.sections === 'object') {
      response.sections = {
        keys: Object.keys(parsedData.sections),
        data: parsedData.sections,
      };
    }

    // Legacy top-level sections (kept for backwards compatibility)
    if (parsedData.homepageSections) {
      response.homepageSections = {
        type: typeof parsedData.homepageSections,
        keys: Object.keys(parsedData.homepageSections),
        data: parsedData.homepageSections,
      };
    }

    if (parsedData.metadata) response.metadata = parsedData.metadata;

    if (Array.isArray(parsedData.topReleases)) response.topReleasesData = parsedData.topReleases;
    if (Array.isArray(parsedData.recentlyAdded)) response.recentlyAddedData = parsedData.recentlyAdded.slice(0, 20);

    res.json(response);
  } catch (error) {
    console.error('Error analyzing Redis keys:', error);
    res.status(500).json({ error: 'Failed to analyze Redis structure', details: error.message });
  }
});

// Report per-source counts and aggregated metadata
router.get('/sources', async (req, res) => {
  try {
    if (!db.isConnected()) {
      return res.status(503).json({ error: 'Redis is not connected' });
    }

    const rawData = await db.redisClient.get('media_radar_cache');
    if (!rawData) return res.status(404).json({ error: 'No data found in Redis' });

    const parsed = JSON.parse(rawData);
    const countBy = (obj) => {
      const out = { total: 0, bySource: {}, bySourceWithFiles: {} };
      if (!obj || typeof obj !== 'object') return out;
      for (const [, entry] of Object.entries(obj)) {
        out.total++;
        const sources = Array.isArray(entry?.sources) && entry.sources.length ? entry.sources : ['unknown'];
        const hasFiles = MediaModel.countFiles(entry) > 0;
        for (const s of sources) {
          out.bySource[s] = (out.bySource[s] || 0) + 1;
          if (hasFiles) out.bySourceWithFiles[s] = (out.bySourceWithFiles[s] || 0) + 1;
        }
      }
      return out;
    };

    res.json({
      schemaVersion: parsed?.metadata?.version || 'legacy',
      supportedSources: MediaModel.SUPPORTED_SOURCES,
      movies: countBy(parsed.movies),
      tvshows: countBy(parsed.tvshows),
      sections: parsed.sections ? Object.keys(parsed.sections) : [],
      lastUpdated: parsed?.metadata?.lastUpdated,
      expiresAt: parsed?.metadata?.expiresAt,
      stats: parsed?.metadata?.stats,
    });
  } catch (error) {
    console.error('Error computing sources:', error);
    res.status(500).json({ error: 'Failed to compute sources', details: error.message });
  }
});

// Analyze Redis data structure
router.get('/redis-structure', async (req, res) => {
  try {
    if (!db.isConnected()) {
      return res.status(503).json({ error: 'Redis is not connected' });
    }
    
    const rawData = await db.redisClient.get('media_radar_cache');
    if (!rawData) {
      return res.status(404).json({ error: 'No data found in Redis' });
    }
    
    const parsedData = JSON.parse(rawData);
    const analysis = {
      dataType: Array.isArray(parsedData) ? 'array' : typeof parsedData,
      structure: 'unknown',
      totalSize: rawData.length,
      movieCount: 0,
      moviesWithDownloads: 0,
      qualityDistribution: {},
      sampleMovies: [],
      fileFormatSupport: {},
      avgFilesPerMovie: 0,
      largestMovieFiles: 0,
      supportedQualities: new Set(),
      detectedFields: new Set(),
      hasDomainPrefixes: false,
      hasRedisSize: false
    };
    
    let moviesObj;
    if (Array.isArray(parsedData)) {
      if (parsedData.length > 0 && typeof parsedData[0] === 'object') {
        moviesObj = parsedData[0];
        analysis.structure = 'array_wrapped';
      }
    } else if (typeof parsedData === 'object' && parsedData !== null) {
      if (parsedData.movies && typeof parsedData.movies === 'object') {
        moviesObj = parsedData.movies;
        analysis.structure = 'nested_object';
        analysis.rootFields = Object.keys(parsedData);
      } else {
        moviesObj = parsedData;
        analysis.structure = 'direct_object';
      }
    }
    
    if (moviesObj) {
      const movieEntries = Object.entries(moviesObj);
      analysis.movieCount = movieEntries.length;
      analysis.kindDistribution = { direct: 0, torrent: 0, magnet: 0 };
      analysis.sourceDistribution = {};

      let totalFiles = 0;

      movieEntries.slice(0, 10).forEach(([movieKey, entry], index) => {
        const qualityData = MediaModel.getQualityMap(entry);
        const movieAnalysis = {
          title: movieKey,
          qualities: Object.keys(qualityData || {}),
          sources: MediaModel.getEntrySources(entry),
          fileCount: 0,
          hasDownloads: false,
        };

        for (const s of movieAnalysis.sources) {
          analysis.sourceDistribution[s] = (analysis.sourceDistribution[s] || 0) + 1;
        }

        Object.entries(qualityData || {}).forEach(([quality, bucket]) => {
          const files = MediaModel.flattenBucket(bucket);
          if (!files.length) return;
          analysis.supportedQualities.add(quality);
          movieAnalysis.fileCount += files.length;
          totalFiles += files.length;
          movieAnalysis.hasDownloads = true;
          analysis.moviesWithDownloads++;
          analysis.qualityDistribution[quality] = (analysis.qualityDistribution[quality] || 0) + 1;

          files.forEach(file => {
            Object.keys(file).forEach(field => analysis.detectedFields.add(field));
            if (file.kind && analysis.kindDistribution[file.kind] !== undefined) {
              analysis.kindDistribution[file.kind]++;
            }
            if (file.filename) {
              const ext = file.filename.split('.').pop().toLowerCase();
              analysis.fileFormatSupport[ext] = (analysis.fileFormatSupport[ext] || 0) + 1;
              if (file.filename.includes('www.')) analysis.hasDomainPrefixes = true;
            }
            if (file.size) analysis.hasRedisSize = true;
          });
        });

        if (index < 5) analysis.sampleMovies.push(movieAnalysis);
        analysis.largestMovieFiles = Math.max(analysis.largestMovieFiles, movieAnalysis.fileCount);
      });

      analysis.avgFilesPerMovie = Number((totalFiles / Math.min(10, movieEntries.length)).toFixed(2));
      analysis.supportedQualities = Array.from(analysis.supportedQualities);
      analysis.detectedFields = Array.from(analysis.detectedFields);
    }
    
    const recommendations = [];
    
    if (analysis.movieCount > 1000) {
      recommendations.push("✅ Large dataset detected - batch processing optimization is beneficial");
    }
    
    if (analysis.detectedFields.includes('fileSize')) {
      recommendations.push("✅ File size metadata detected - can be used for better sorting");
    }
    
    if (analysis.detectedFields.includes('quality')) {
      recommendations.push("✅ Quality metadata detected - can improve quality detection");
    }
    
    if (analysis.detectedFields.includes('language')) {
      recommendations.push("✅ Language metadata detected - can enable language filtering");
    }
    
    if (analysis.detectedFields.includes('year')) {
      recommendations.push("✅ Year metadata detected - improves TMDB matching accuracy");
    }
    
    if (analysis.hasRedisSize) {
      recommendations.push("✅ Redis size metadata detected - avoids confusion with audio bitrates");
    }
    
    if (analysis.hasDomainPrefixes) {
      recommendations.push("✅ Domain prefixes detected - auto-cleaned for better display");
    }
    
    if (analysis.avgFilesPerMovie > 5) {
      recommendations.push("⚠️ High files per movie - consider pagination for download options");
    }
    
    if (analysis.supportedQualities.length > 3) {
      recommendations.push("✅ Multiple quality options - quality-based filtering recommended");
    }
    
    res.json({
      success: true,
      analysis: analysis,
      recommendations: recommendations,
      optimizations: {
        batchProcessing: analysis.movieCount > 100,
        parallelEnrichment: true,
        qualityFiltering: analysis.supportedQualities.length > 2,
        sizeBasedSorting: analysis.detectedFields.includes('fileSize'),
        languageFiltering: analysis.detectedFields.includes('language'),
        filenameCleaning: analysis.hasDomainPrefixes || false,
        redisSizeData: analysis.hasRedisSize || false,
        yearFromMetadata: analysis.detectedFields.includes('year')
      },
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    console.error('Error analyzing Redis structure:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      recommendations: ['Check Redis data format', 'Verify JSON structure']
    });
  }
});

// Get available languages
router.get('/available-languages', async (req, res) => {
  try {
    if (!db.isConnected()) {
      return res.status(503).json({ error: 'Redis is not connected' });
    }
    
    const cachedMovies = await db.redisClient.get('media_radar_cache');
    if (!cachedMovies) {
      return res.status(404).json({ error: 'No movies found in cache' });
    }
    
    const rawData = JSON.parse(cachedMovies);
    // New schema: { movies: {…}, tvshows: {…}, … }. Legacy: flat object.
    const moviesObj = (rawData && typeof rawData === 'object' && rawData.movies && typeof rawData.movies === 'object')
      ? rawData.movies
      : (Array.isArray(rawData) ? rawData[0] : rawData);

    const languageCount = {};
    const qualityCount = {};
    let totalFilesWithMetadata = 0;

    Object.entries(moviesObj || {}).forEach(([, entry]) => {
      const qualityData = MediaModel.getQualityMap(entry);
      Object.entries(qualityData || {}).forEach(([quality, bucket]) => {
        const files = MediaModel.flattenBucket(bucket);
        if (!files.length) return;
        qualityCount[quality] = (qualityCount[quality] || 0) + files.length;
        files.forEach(file => {
          const normalizedLanguage = normalizeLanguage(file.language);
          if (normalizedLanguage) {
            languageCount[normalizedLanguage] = (languageCount[normalizedLanguage] || 0) + 1;
            totalFilesWithMetadata++;
          }
        });
      });
    });
    
    res.json({
      success: true,
      languages: Object.entries(languageCount)
        .sort(([,a], [,b]) => b - a)
        .map(([lang, count]) => ({ language: lang, count })),
      qualities: Object.entries(qualityCount)
        .sort(([,a], [,b]) => b - a)
        .map(([quality, count]) => ({ quality, count })),
      totalFilesWithMetadata,
      mostCommonLanguage: Object.keys(languageCount).length > 0 
        ? Object.entries(languageCount).sort(([,a], [,b]) => b - a)[0][0] 
        : null
    });
    
  } catch (error) {
    console.error('Error fetching available languages:', error);
    res.status(500).json({ error: 'Failed to fetch available languages' });
  }
});

// Debug Redis data
router.get('/debug-redis', async (req, res) => {
  try {
    if (!db.isConnected()) {
      return res.status(503).json({ error: 'Redis is not connected' });
    }
    
    const rawData = await db.redisClient.get('media_radar_cache');
    if (rawData) {
      try {
        const parsedData = JSON.parse(rawData);
        res.json({
          success: true,
          dataType: Array.isArray(parsedData) ? 'array' : typeof parsedData,
          dataLength: Array.isArray(parsedData) ? parsedData.length : 'N/A',
          firstItem: Array.isArray(parsedData) && parsedData[0] ? Object.keys(parsedData[0]).slice(0, 5) : 'N/A',
          rawDataPreview: rawData.substring(0, 500) + '...'
        });
      } catch (parseError) {
        res.json({
          success: false,
          error: 'Failed to parse JSON',
          rawDataPreview: rawData.substring(0, 500) + '...'
        });
      }
    } else {
      res.json({
        success: false,
        message: 'No data found in Redis key'
      });
    }
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Debug specific size extraction issues
router.get('/debug-size-extraction/:filename', async (req, res) => {
  try {
    const { extractSizeFromFilename, formatFileSize } = require('../helpers/utils');
    const filename = decodeURIComponent(req.params.filename);
    
    console.log(`🔍 Debugging size extraction for: "${filename}"`);
    
    // Test the extraction
    const extractedSize = extractSizeFromFilename(filename);
    const formattedSize = formatFileSize(extractedSize);
    
    // Additional regex tests
    const allMatches = filename.match(/\d+(?:\.\d+)?/g) || [];
    const sizeMatches = filename.match(/(\d+(?:\.\d+)?\s*(?:GB|MB|KB|TB))/gi) || [];
    
    res.json({
      success: true,
      filename: filename,
      debug: {
        extractedSize: extractedSize,
        formattedSize: formattedSize,
        allNumberMatches: allMatches,
        allSizeMatches: sizeMatches,
        filenameLength: filename.length,
        containsWww: filename.includes('www.'),
        containsGb: /gb/i.test(filename),
        containsMb: /mb/i.test(filename),
        containsKb: /kb/i.test(filename)
      },
      analysis: {
        likelyFileSize: sizeMatches.length > 0 ? sizeMatches[0] : 'Not found',
        possibleSizeInFilename: filename.match(/\d+(?:\.\d+)?\s*(?:GB|MB|KB)/gi),
        recommendedFix: sizeMatches.length === 0 ? 'Size not found in filename - need Redis metadata' : 'Size found successfully'
      }
    });
    
  } catch (error) {
    console.error('Error in size extraction debug:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

module.exports = router; 