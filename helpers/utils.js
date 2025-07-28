const crypto = require('crypto');

// Helper function to extract file size from filename
function extractSizeFromFilename(filename) {
  if (!filename) return 'Unknown';
  
  // Improved regex to match file sizes while avoiding audio bitrates
  // Look for patterns like: 3.2GB, 1.5MB, 700MB, 4GB, etc.
  // But exclude audio bitrates like: 192Kbps, 320Kbps, etc.
  const sizeMatches = filename.match(/(\d+(?:\.\d+)?\s*(?:GB|MB|TB)(?!ps))/gi);
  
  // Also look for larger KB sizes (likely file sizes, not bitrates)
  // Only include KB if it's a large number (>10000KB = >10MB)
  const kbMatches = filename.match(/(\d+(?:\.\d+)?\s*KB)(?!ps)/gi);
  const largeKbMatches = kbMatches ? kbMatches.filter(match => {
    const value = parseFloat(match);
    return value > 10000; // Only include KB values larger than 10MB equivalent
  }) : [];
  
  const allMatches = [...(sizeMatches || []), ...largeKbMatches];
  
  if (!allMatches || allMatches.length === 0) {
    console.log(`⚠️ No file size found in filename: "${filename}"`);
    return 'Unknown';
  }
  
  // If multiple matches, prefer the larger sizes (GB > MB > large KB)
  const prioritizedSizes = allMatches.sort((a, b) => {
    const aVal = parseFloat(a);
    const bVal = parseFloat(b);
    const aUnit = a.toUpperCase();
    const bUnit = b.toUpperCase();
    
    // Prioritize by unit first (GB > MB > KB)
    if (aUnit.includes('GB') && !bUnit.includes('GB')) return -1;
    if (!aUnit.includes('GB') && bUnit.includes('GB')) return 1;
    if (aUnit.includes('MB') && bUnit.includes('KB')) return -1;
    if (bUnit.includes('MB') && aUnit.includes('KB')) return 1;
    
    // If same unit, prefer larger value
    return bVal - aVal;
  });
  
  const selectedSize = prioritizedSizes[0];
  console.log(`📏 Extracted size "${selectedSize}" from filename: "${filename.substring(0, 100)}..." (avoided audio bitrates)`);
  
  return selectedSize;
}

// Helper function to clean filename by removing domain prefix
function cleanFilename(filename) {
  if (!filename) return filename;
  
  const domainPrefixes = [
    /^www\.1TamilMV\.tube\s*-\s*/i,
    /^www\.1TamilMV\.com\s*-\s*/i,
    /^www\.TamilMV\.com\s*-\s*/i,
    /^1TamilMV\.tube\s*-\s*/i,
    /^1TamilMV\.com\s*-\s*/i,
    /^TamilMV\.com\s*-\s*/i,
    /^www\.\w+\.\w+\s*-\s*/i
  ];
  
  let cleanedFilename = filename;
  for (const prefix of domainPrefixes) {
    cleanedFilename = cleanedFilename.replace(prefix, '');
  }
  
  return cleanedFilename.replace(/\.torrent$/i, '').trim();
}

// Helper function to format file size from bytes or string
function formatFileSize(sizeData) {
  if (!sizeData) return 'Unknown';
  
  // If it's already a formatted string, clean it up and return
  if (typeof sizeData === 'string') {
    if (sizeData === 'Unknown') return sizeData;
    
    // Clean up the string (remove extra spaces, normalize case)
    const cleanedSize = sizeData.trim().replace(/\s+/g, ' ');
    
    // If it looks like a valid size format, return it
    if (/^\d+(?:\.\d+)?\s*(?:B|KB|MB|GB|TB)$/i.test(cleanedSize)) {
      // Normalize the format (e.g., "3.2gb" -> "3.2GB")
      return cleanedSize.replace(/([a-z]+)$/i, (match) => match.toUpperCase());
    }
    
    console.log(`⚠️ Invalid size format: "${sizeData}" - returning as-is`);
    return cleanedSize;
  }
  
  // Convert bytes to human readable format
  if (typeof sizeData === 'number') {
    const bytes = sizeData;
    if (bytes === 0) return '0 B';
    
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }
  
  console.log(`⚠️ Unknown size data type: ${typeof sizeData}, value: ${sizeData}`);
  return 'Unknown';
}

// Helper function to safely normalize language data
function normalizeLanguage(languageData) {
  if (!languageData) return null;
  
  if (typeof languageData === 'string') {
    const trimmed = languageData.trim();
    return trimmed || null;
  }
  
  if (Array.isArray(languageData) && languageData.length > 0) {
    return normalizeLanguage(languageData[0]);
  }
  
  if (typeof languageData === 'object') {
    if (languageData.name) return normalizeLanguage(languageData.name);
    if (languageData.value) return normalizeLanguage(languageData.value);
    if (languageData.label) return normalizeLanguage(languageData.label);
    if (Object.keys(languageData).length === 0) return null;
  }
  
  if (typeof languageData === 'number') {
    return normalizeLanguage(languageData.toString());
  }
  
  if (typeof languageData === 'boolean') {
    return null;
  }
  
  console.warn(`⚠️ Unexpected language data type: ${typeof languageData}, value:`, languageData);
  return null;
}

// Helper function to generate a poster URL
function generatePosterUrl(title, index) {
  const encodedTitle = encodeURIComponent(title.substring(0, 20));
  return `https://via.placeholder.com/300x450/2a2a2a/ffffff?text=${encodedTitle}%0A🎬%0AMovie+${index + 1}`;
}

// Helper function to get a safe poster URL with fallback
function getSafePosterUrl(movieData, title, index) {
  if (movieData?.Poster && movieData.Poster !== 'N/A') {
    return movieData.Poster;
  }
  return generatePosterUrl(title, index);
}

// Helper function to analyze genre from title (fallback)
function analyzeGenreFromTitle(title) {
  const lowerTitle = title.toLowerCase();
  if (lowerTitle.includes('comali') || lowerTitle.includes('comedy')) {
    return 'Comedy';
  } else if (lowerTitle.includes('bombay') || lowerTitle.includes('drama')) {
    return 'Drama';
  } else if (lowerTitle.includes('flask') || lowerTitle.includes('thriller')) {
    return 'Thriller';
  } else if (lowerTitle.includes('stitch') || lowerTitle.includes('animation')) {
    return 'Animation, Family';
  } else if (lowerTitle.includes('peacemaker') || lowerTitle.includes('action')) {
    return 'Action, Adventure';
  }
  return 'Unknown';
}

// Helper function to format bytes to human readable
function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

module.exports = {
  extractSizeFromFilename,
  cleanFilename,
  formatFileSize,
  normalizeLanguage,
  generatePosterUrl,
  getSafePosterUrl,
  analyzeGenreFromTitle,
  formatBytes
}; 