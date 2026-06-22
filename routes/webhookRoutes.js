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
// Direct-link notifier: resolves an hdhub4u ad-gated URL and pushes the fresh
// short-lived download link to Discord/Telegram (n8n media-radar-direct-notify).
const DEFAULT_NOTIFY_WEBHOOK_URL = 'https://n8n.cgraaaj.in/webhook/resolve-notify';
const REQUEST_TIMEOUT_MS = Number(process.env.WEBHOOK_TIMEOUT_MS || 10000);

/**
 * Forward a JSON body to a downstream n8n webhook, normalizing success/failure
 * into stable shapes for the UI. Shared by all webhook proxy routes so auth /
 * rate-limiting / observability can be added in one place later.
 */
async function proxyToWebhook(targetUrl, req, res, logLabel) {
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
        label: logLabel,
        status: upstream.status,
      });
      return res.json({
        success: true,
        upstreamStatus: upstream.status,
        upstreamBody: upstream.data ?? null,
      });
    }

    logger.warn('Webhook upstream non-2xx', {
      id: req.id,
      label: logLabel,
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
      label: logLabel,
      error: error.message,
      code: error.code,
      targetUrl,
    });
    return res.status(timedOut ? 504 : 502).json({
      error: timedOut ? 'Upstream webhook timed out' : 'Failed to reach upstream webhook',
      message: error.message,
    });
  }
}

/**
 * POST /api/webhooks/request-movie
 *
 * Accepts the same payload the UI was sending to n8n directly and forwards
 * it to the configured webhook URL.
 */
router.post('/request-movie', (req, res) =>
  proxyToWebhook(process.env.N8N_WEBHOOK_URL || DEFAULT_WEBHOOK_URL, req, res, 'request-movie'),
);

/**
 * POST /api/webhooks/notify-direct
 *
 * Forwards an hdhub4u direct (ad-gated) file to the n8n direct-notify flow,
 * which resolves the redirector to a fresh download link and posts it to
 * Discord/Telegram. The resolve happens downstream (in n8n -> cold-radar) so
 * the short-lived token is minted as close to delivery as possible.
 */
router.post('/notify-direct', (req, res) =>
  proxyToWebhook(
    process.env.N8N_NOTIFY_WEBHOOK_URL || DEFAULT_NOTIFY_WEBHOOK_URL,
    req,
    res,
    'notify-direct',
  ),
);

module.exports = router;
