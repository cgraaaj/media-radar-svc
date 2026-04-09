/**
 * Torrent Stats API Routes
 * 
 * Provides endpoints for accessing torrent health statistics
 * collected by the Python torrent-stats service.
 */

const express = require('express');
const router = express.Router();
const torrentStatsService = require('../services/TorrentStatsService');
const logger = require('../config/logger');

/**
 * GET /api/torrent-stats
 * Get overview statistics for the UI dashboard
 */
router.get('/', async (req, res) => {
  try {
    const stats = await torrentStatsService.getOverviewStats();
    res.json(stats);
  } catch (error) {
    logger.error('Error fetching torrent stats', { error: error.message });
    res.status(500).json({ 
      error: 'Failed to fetch torrent statistics',
      message: error.message 
    });
  }
});

/**
 * GET /api/torrent-stats/top
 * Get top torrents by seeder count
 */
router.get('/top', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 20;
    const torrents = await torrentStatsService.getTopTorrents(limit);
    
    res.json({
      success: true,
      count: torrents.length,
      torrents: torrents.map(t => ({
        infoHash: t.info_hash,
        name: t.name,
        seeders: t.seeders,
        leechers: t.leechers,
        totalPeers: t.total_peers,
        trackerSeeders: t.tracker_seeders,
        dhtPeers: t.dht_peers,
        source: t.discovery_source,
        lastChecked: t.last_checked
      }))
    });
  } catch (error) {
    logger.error('Error fetching top torrents', { error: error.message });
    res.status(500).json({ error: 'Failed to fetch top torrents' });
  }
});

/**
 * GET /api/torrent-stats/dead
 * Get torrents with no seeders
 */
router.get('/dead', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 100;
    const torrents = await torrentStatsService.getDeadTorrents(limit);
    
    res.json({
      success: true,
      count: torrents.length,
      torrents: torrents.map(t => ({
        infoHash: t.info_hash,
        name: t.name,
        lastChecked: t.last_checked
      }))
    });
  } catch (error) {
    logger.error('Error fetching dead torrents', { error: error.message });
    res.status(500).json({ error: 'Failed to fetch dead torrents' });
  }
});

/**
 * GET /api/torrent-stats/search
 * Search torrents by name
 */
router.get('/search', async (req, res) => {
  try {
    const { q, limit } = req.query;
    
    if (!q || q.length < 2) {
      return res.status(400).json({ error: 'Search query must be at least 2 characters' });
    }
    
    const torrents = await torrentStatsService.searchByName(q, parseInt(limit) || 50);
    
    res.json({
      success: true,
      query: q,
      count: torrents.length,
      torrents: torrents.map(t => ({
        infoHash: t.info_hash,
        name: t.name,
        seeders: t.seeders,
        leechers: t.leechers,
        source: t.discovery_source,
        lastChecked: t.last_checked
      }))
    });
  } catch (error) {
    logger.error('Error searching torrents', { error: error.message });
    res.status(500).json({ error: 'Failed to search torrents' });
  }
});

/**
 * GET /api/torrent-stats/lookup/:infoHash
 * Get stats for a specific torrent
 */
router.get('/lookup/:infoHash', async (req, res) => {
  try {
    const { infoHash } = req.params;
    
    if (!infoHash || infoHash.length < 32) {
      return res.status(400).json({ error: 'Invalid info_hash' });
    }
    
    const stats = await torrentStatsService.getTorrentStats(infoHash);
    
    if (!stats) {
      return res.status(404).json({ 
        error: 'Torrent not found',
        infoHash: infoHash 
      });
    }
    
    res.json({
      success: true,
      ...stats
    });
  } catch (error) {
    logger.error('Error looking up torrent', { error: error.message });
    res.status(500).json({ error: 'Failed to lookup torrent' });
  }
});

/**
 * POST /api/torrent-stats/bulk
 * Get stats for multiple torrents at once
 * Body: { infoHashes: ['hash1', 'hash2', ...] }
 */
router.post('/bulk', async (req, res) => {
  try {
    const { infoHashes } = req.body;
    
    if (!Array.isArray(infoHashes) || infoHashes.length === 0) {
      return res.status(400).json({ error: 'infoHashes must be a non-empty array' });
    }
    
    if (infoHashes.length > 500) {
      return res.status(400).json({ error: 'Maximum 500 hashes per request' });
    }
    
    const stats = await torrentStatsService.getBulkTorrentStats(infoHashes);
    
    res.json({
      success: true,
      requested: infoHashes.length,
      found: Object.keys(stats).length,
      stats: stats
    });
  } catch (error) {
    logger.error('Error bulk lookup', { error: error.message });
    res.status(500).json({ error: 'Failed to bulk lookup torrents' });
  }
});

module.exports = router;
