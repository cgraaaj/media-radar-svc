/**
 * TV-franchise classifier — single source of truth at
 * `n8n/shared/tv-franchises.json`. The bundled copy at
 * [./tv-franchises.json](./tv-franchises.json) is kept in sync via
 * `scripts/sync-tv-franchises.js` (run by hand or in CI).
 *
 * Why this exists
 * ---------------
 * The upstream scrapers split items into `data.movies` vs `data.tvshows` at
 * scrape time using a regex like /S\d+|Season|Episode/. Reality TV (Bigg
 * Boss, MasterChef) and weekly events (WWE Smackdown) don't carry those
 * markers, so they leak into `movies`. This module backs:
 *   1. `MediaModel._reclassifyMisplacedTvShows()` – moves leaked entries out
 *      of `data.movies` into `data.tvshows` on read, so the UI is correct
 *      even before the next cold crawl refreshes Redis.
 *   2. The fallback heuristic inside `MediaModel.determineMediaType()` for
 *      the "mixed" data structure path.
 *
 * Both consumers should call `isTvTitle(text)` rather than re-implementing
 * the regex.
 */

const path = require('path');
const fs = require('fs');

const FRANCHISE_JSON_PATH = path.join(__dirname, 'tv-franchises.json');

let franchiseData = { patterns: [], tokens: [] };
try {
  franchiseData = JSON.parse(fs.readFileSync(FRANCHISE_JSON_PATH, 'utf8'));
} catch (err) {
  // Module-level catch so a missing/corrupt JSON degrades gracefully — we
  // simply fall back to the standard S\d/Season/Episode regex.
  console.warn('[tvFranchises] failed to load %s: %s', FRANCHISE_JSON_PATH, err.message);
}

const TV_SE_RE = /\b(S\d{1,2}|Season\s*\d+|EP\d+|Episode\s*\d+|Complete|Season)\b/i;

const TV_FRANCHISE_RE = (() => {
  const patterns = Array.isArray(franchiseData.patterns) ? franchiseData.patterns : [];
  if (patterns.length === 0) return null;
  try {
    return new RegExp('\\b(?:' + patterns.join('|') + ')\\b', 'i');
  } catch (err) {
    console.warn('[tvFranchises] invalid pattern in tv-franchises.json: %s', err.message);
    return null;
  }
})();

const TV_TOKEN_SET = new Set(
  (Array.isArray(franchiseData.tokens) ? franchiseData.tokens : []).map((t) =>
    String(t).toLowerCase()
  )
);

/**
 * Returns true when `text` looks like a TV/series/episodic show.
 * Combines the standard S/E pattern, the franchise allow-list regex, and a
 * simple substring fallback against the bundled token list (lowercase).
 *
 * Pure / cheap (precompiled regex). Safe to call per-entry on every read.
 */
function isTvTitle(text) {
  if (!text) return false;
  const s = String(text);
  if (TV_SE_RE.test(s)) return true;
  if (TV_FRANCHISE_RE && TV_FRANCHISE_RE.test(s)) return true;
  if (TV_TOKEN_SET.size > 0) {
    const lower = s.toLowerCase();
    for (const tok of TV_TOKEN_SET) {
      if (lower.includes(tok)) return true;
    }
  }
  return false;
}

module.exports = {
  isTvTitle,
  TV_SE_RE,
  TV_FRANCHISE_RE,
  TV_TOKEN_SET,
  // Exposed so health/diagnostics endpoints can advertise the loaded set.
  franchiseData,
};
