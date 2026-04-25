/**
 * Webhook proxy routes.
 *
 * The frontend used to POST directly to the n8n webhook
 * (https://n8n.cgraaaj.in/webhook/submit-torrent) which routinely failed
 * in the browser because n8n does not return permissive CORS headers
 * (preflight `OPTIONS` is rejected → "Network error: Unable to send").
 *
 * Proxying server-side gives us:
 *   - No browser CORS surface (server-to-server call).
 *   - The downstream URL is configurable (N8N_WEBHOOK_URL) and never leaks
 *     to the client.
 *   - A natural seam to add auth, rate-limiting, payload validation and
 *     observability later.
 */

const express = require('express');
const axios = require('axios');
const router = express.Router();
const logger = require('../config/logger');

const DEFAULT_WEBHOOK_URL = 'https://n8n.cgraaaj.in/webhook/submit-torrent';
const REQUEST_TIMEOUT_MS = Number(process.env.WEBHOOK_TIMEOUT_MS || 10000);

/**
 * POST /api/webhooks/request-movie
 *
 * Accepts the same payload the UI was sending to n8n directly and forwards
 * it to the configured webhook URL.
 */
router.post('/request-movie', async (req, res) => {
  const targetUrl = process.env.N8N_WEBHOOK_URL || DEFAULT_WEBHOOK_URL;

  if (!req.body || typeof req.body !== 'object') {
    return res.status(400).json({ error: 'Request body must be a JSON object' });
  }

  try {
    const upstream = await axios.post(targetUrl, req.body, {
      timeout: REQUEST_TIMEOUT_MS,
      headers: {
        'Content-Type': 'application/json',
        'x-forwarded-request-id': req.id || '',
      },
      validateStatus: () => true, // we'll inspect the status ourselves
    });

    if (upstream.status >= 200 && upstream.status < 300) {
      logger.info('Webhook forwarded', {
        id: req.id,
        status: upstream.status,
        title: req.body?.movie?.title,
      });
      return res.json({
        success: true,
        upstreamStatus: upstream.status,
        upstreamBody: upstream.data ?? null,
      });
    }

    logger.warn('Webhook upstream non-2xx', {
      id: req.id,
      status: upstream.status,
      targetUrl,
    });
    return res.status(502).json({
      error: 'Upstream webhook rejected the request',
      upstreamStatus: upstream.status,
      upstreamBody: upstream.data ?? null,
    });
  } catch (error) {
    const timedOut = error.code === 'ECONNABORTED';
    logger.error('Webhook proxy error', {
      id: req.id,
      error: error.message,
      code: error.code,
      targetUrl,
    });
    return res.status(timedOut ? 504 : 502).json({
      error: timedOut ? 'Upstream webhook timed out' : 'Failed to reach upstream webhook',
      message: error.message,
    });
  }
});

module.exports = router;
