const express = require('express');
const router = express.Router();
const { redisClient, isConnected } = require('../config/database');
const { normalizeLanguage } = require('../helpers/utils');

// Analyze Redis data structure
router.get('/redis-structure', async (req, res) => {
  try {
    if (!isConnected()) {
      return res.status(503).json({ error: 'Redis is not connected' });
    }
    
    const rawData = await redisClient.get('onetamilmv_movies_cache');
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
      
      let totalFiles = 0;
      
      movieEntries.slice(0, 10).forEach(([movieKey, qualityData], index) => {
        const movieAnalysis = {
          title: movieKey,
          qualities: Object.keys(qualityData),
          fileCount: 0,
          hasDownloads: false
        };
        
        Object.entries(qualityData).forEach(([quality, files]) => {
          if (Array.isArray(files)) {
            analysis.supportedQualities.add(quality);
            movieAnalysis.fileCount += files.length;
            totalFiles += files.length;
            
            if (files.length > 0) {
              movieAnalysis.hasDownloads = true;
              analysis.moviesWithDownloads++;
              
              analysis.qualityDistribution[quality] = (analysis.qualityDistribution[quality] || 0) + 1;
              
              files.forEach(file => {
                Object.keys(file).forEach(field => analysis.detectedFields.add(field));
                
                if (file.filename) {
                  const ext = file.filename.split('.').pop().toLowerCase();
                  analysis.fileFormatSupport[ext] = (analysis.fileFormatSupport[ext] || 0) + 1;
                }
                
                if (file.filename && file.filename.includes('www.')) {
                  analysis.hasDomainPrefixes = true;
                }
                
                if (file.size) {
                  analysis.hasRedisSize = true;
                }
              });
            }
          }
        });
        
        if (index < 5) {
          analysis.sampleMovies.push(movieAnalysis);
        }
        
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
    if (!isConnected()) {
      return res.status(503).json({ error: 'Redis is not connected' });
    }
    
    const cachedMovies = await redisClient.get('onetamilmv_movies_cache');
    if (!cachedMovies) {
      return res.status(404).json({ error: 'No movies found in cache' });
    }
    
    const rawData = JSON.parse(cachedMovies);
    let moviesObj = Array.isArray(rawData) ? rawData[0] : rawData;
    
    const languageCount = {};
    const qualityCount = {};
    let totalFilesWithMetadata = 0;
    
    Object.entries(moviesObj).forEach(([movieKey, qualityData]) => {
      Object.entries(qualityData).forEach(([quality, files]) => {
        if (Array.isArray(files)) {
          qualityCount[quality] = (qualityCount[quality] || 0) + files.length;
          
          files.forEach(file => {
            const normalizedLanguage = normalizeLanguage(file.language);
            if (normalizedLanguage) {
              languageCount[normalizedLanguage] = (languageCount[normalizedLanguage] || 0) + 1;
              totalFilesWithMetadata++;
            }
          });
        }
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
    if (!isConnected()) {
      return res.status(503).json({ error: 'Redis is not connected' });
    }
    
    const rawData = await redisClient.get('onetamilmv_movies_cache');
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