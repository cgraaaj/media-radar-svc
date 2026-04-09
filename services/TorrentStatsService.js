/**
 * TorrentStatsService - Reads torrent statistics from SQLite database
 * populated by the Python torrent-stats collector.
 */

const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const logger = require('../config/logger');

class TorrentStatsService {
  constructor() {
    // Path to SQLite database (relative to project root)
    this.dbPath = process.env.TORRENT_STATS_DB || 
      path.join(__dirname, '../../torrent-stats/torrent_stats.db');
    this.db = null;
    this.lastRefresh = null;
    this.cachedStats = null;
    this.cacheMaxAge = 60000; // Cache for 1 minute
  }

  /**
   * Open database connection
   */
  connect() {
    return new Promise((resolve, reject) => {
      if (this.db) {
        resolve(this.db);
        return;
      }

      this.db = new sqlite3.Database(this.dbPath, sqlite3.OPEN_READONLY, (err) => {
        if (err) {
          logger.error('Failed to connect to torrent stats DB', { error: err.message, path: this.dbPath });
          reject(err);
        } else {
          logger.info('Connected to torrent stats DB', { path: this.dbPath });
          resolve(this.db);
        }
      });
    });
  }

  /**
   * Close database connection
   */
  close() {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  /**
   * Execute a query and return all rows
   */
  query(sql, params = []) {
    return new Promise((resolve, reject) => {
      this.db.all(sql, params, (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
      });
    });
  }

  /**
   * Execute a query and return single row
   */
  queryOne(sql, params = []) {
    return new Promise((resolve, reject) => {
      this.db.get(sql, params, (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });
  }

  /**
   * Get stats for a specific torrent by info_hash
   */
  async getTorrentStats(infoHash) {
    await this.connect();
    
    const row = await this.queryOne(
      'SELECT * FROM torrent_stats WHERE info_hash = ?',
      [infoHash.toLowerCase()]
    );
    
    if (!row) return null;
    
    return {
      infoHash: row.info_hash,
      seeders: row.seeders,
      leechers: row.leechers,
      totalPeers: row.total_peers,
      trackerSeeders: row.tracker_seeders,
      trackerLeechers: row.tracker_leechers,
      dhtSeeders: row.dht_seeders,
      dhtPeers: row.dht_peers,
      discoverySource: row.discovery_source,
      lastChecked: row.last_checked,
      name: row.name,
    };
  }

  /**
   * Get stats for multiple torrents by info_hash array
   */
  async getBulkTorrentStats(infoHashes) {
    if (!infoHashes || infoHashes.length === 0) return {};
    
    await this.connect();
    
    const placeholders = infoHashes.map(() => '?').join(',');
    const rows = await this.query(
      `SELECT * FROM torrent_stats WHERE info_hash IN (${placeholders})`,
      infoHashes.map(h => h.toLowerCase())
    );
    
    const result = {};
    rows.forEach(row => {
      result[row.info_hash] = {
        seeders: row.seeders,
        leechers: row.leechers,
        totalPeers: row.total_peers,
        health: this.calculateHealth(row.seeders, row.leechers),
        lastChecked: row.last_checked,
      };
    });
    
    return result;
  }

  /**
   * Calculate health status from seeder/leecher count
   */
  calculateHealth(seeders, leechers) {
    if (seeders === 0) return 'dead';
    if (seeders < 5) return 'poor';
    if (seeders < 20) return 'fair';
    if (seeders < 50) return 'good';
    return 'excellent';
  }

  /**
   * Get aggregated statistics for the overview panel
   */
  async getOverviewStats() {
    // Return cached stats if fresh
    if (this.cachedStats && this.lastRefresh && 
        (Date.now() - this.lastRefresh) < this.cacheMaxAge) {
      return { ...this.cachedStats, fromCache: true };
    }

    try {
      await this.connect();
      
      // Get total counts
      const totals = await this.queryOne(`
        SELECT 
          COUNT(*) as total,
          SUM(CASE WHEN seeders > 0 THEN 1 ELSE 0 END) as with_seeders,
          SUM(CASE WHEN seeders = 0 THEN 1 ELSE 0 END) as dead,
          AVG(seeders) as avg_seeders,
          AVG(leechers) as avg_leechers,
          MAX(last_checked) as last_updated
        FROM torrent_stats
      `);

      // Get health distribution
      const healthDist = await this.query(`
        SELECT 
          CASE 
            WHEN seeders = 0 THEN 'Dead'
            WHEN seeders < 5 THEN 'Poor'
            WHEN seeders < 20 THEN 'Fair'
            WHEN seeders < 50 THEN 'Good'
            ELSE 'Excellent'
          END as health_status,
          COUNT(*) as count
        FROM torrent_stats
        GROUP BY health_status
      `);

      // Convert to percentages
      const healthDistribution = {};
      healthDist.forEach(row => {
        const percentage = ((row.count / totals.total) * 100).toFixed(1) + '%';
        healthDistribution[row.health_status] = percentage;
      });

      // Get stats by quality (extracted from name)
      const qualityStats = await this.query(`
        SELECT 
          CASE 
            WHEN name LIKE '%4k%' OR name LIKE '%2160p%' THEN '4k'
            WHEN name LIKE '%1080p%' THEN '1080p'
            WHEN name LIKE '%720p%' THEN '720p'
            WHEN name LIKE '%480p%' THEN '480p'
            ELSE 'other'
          END as quality,
          COUNT(*) as count,
          ROUND(AVG(seeders), 1) as avg_seeders,
          ROUND(AVG(leechers), 1) as avg_leechers
        FROM torrent_stats
        WHERE seeders > 0 OR leechers > 0
        GROUP BY quality
        ORDER BY 
          CASE quality 
            WHEN '4k' THEN 1 
            WHEN '1080p' THEN 2 
            WHEN '720p' THEN 3 
            WHEN '480p' THEN 4 
            ELSE 5 
          END
      `);

      const averageHealthByQuality = {};
      qualityStats.forEach(row => {
        const ratio = row.avg_leechers > 0 
          ? (row.avg_seeders / row.avg_leechers).toFixed(2)
          : row.avg_seeders > 0 ? '∞' : '0';
        
        averageHealthByQuality[row.quality] = {
          avgSeeders: Math.round(row.avg_seeders),
          avgLeechers: Math.round(row.avg_leechers),
          avgRatio: ratio,
          count: row.count
        };
      });

      // Get last collection run info
      let lastRun = null;
      try {
        lastRun = await this.queryOne(`
          SELECT * FROM collection_runs 
          WHERE status = 'completed' 
          ORDER BY id DESC LIMIT 1
        `);
      } catch (e) {
        // collection_runs table might not exist yet
      }

      const stats = {
        totalTrackedTorrents: totals.total,
        torrentsWithSeeders: totals.with_seeders,
        deadTorrents: totals.dead,
        averageSeeders: Math.round(totals.avg_seeders || 0),
        averageLeechers: Math.round(totals.avg_leechers || 0),
        lastUpdated: totals.last_updated,
        healthDistribution,
        averageHealthByQuality,
        dataSource: 'real',
        cacheHitRate: totals.with_seeders > 0 
          ? ((totals.with_seeders / totals.total) * 100).toFixed(1) + '%'
          : '0%',
        lastCollectionRun: lastRun ? {
          startedAt: lastRun.started_at,
          completedAt: lastRun.completed_at,
          processed: lastRun.torrents_processed,
          succeeded: lastRun.torrents_succeeded,
          failed: lastRun.torrents_failed,
          duration: lastRun.duration_seconds
        } : null
      };

      // Cache the result
      this.cachedStats = stats;
      this.lastRefresh = Date.now();

      return stats;

    } catch (error) {
      logger.error('Failed to get overview stats', { error: error.message });
      
      // Return empty stats on error
      return {
        totalTrackedTorrents: 0,
        torrentsWithSeeders: 0,
        deadTorrents: 0,
        averageSeeders: 0,
        averageLeechers: 0,
        healthDistribution: {},
        averageHealthByQuality: {},
        dataSource: 'unavailable',
        cacheHitRate: '0%',
        error: error.message
      };
    }
  }

  /**
   * Get top torrents by seeders
   */
  async getTopTorrents(limit = 20) {
    await this.connect();
    
    return this.query(`
      SELECT info_hash, name, seeders, leechers, total_peers, 
             tracker_seeders, dht_peers, discovery_source, last_checked
      FROM torrent_stats 
      WHERE seeders > 0
      ORDER BY seeders DESC 
      LIMIT ?
    `, [limit]);
  }

  /**
   * Get dead torrents (no seeders)
   */
  async getDeadTorrents(limit = 100) {
    await this.connect();
    
    return this.query(`
      SELECT info_hash, name, last_checked
      FROM torrent_stats 
      WHERE seeders = 0 AND leechers = 0
      ORDER BY last_checked DESC 
      LIMIT ?
    `, [limit]);
  }

  /**
   * Search torrents by name
   */
  async searchByName(searchTerm, limit = 50) {
    await this.connect();
    
    return this.query(`
      SELECT info_hash, name, seeders, leechers, discovery_source, last_checked
      FROM torrent_stats 
      WHERE name LIKE ?
      ORDER BY seeders DESC 
      LIMIT ?
    `, [`%${searchTerm}%`, limit]);
  }
}

// Export singleton instance
module.exports = new TorrentStatsService();
