/**
 * ============================================================================
 *  SiteDiff configuration: every tunable setting lives here.
 * ============================================================================
 *
 * You can change the defaults below directly, or leave this file alone and
 * pass `--config my-settings.json` on the command line. That JSON file is
 * deep-merged over these defaults: objects merge key by key, and arrays
 * *replace* the default array. (To add to a list instead, use the
 * `extra...` keys in the `ignore` section.)
 *
 * Regular expressions are written as strings so they work in JSON too.
 */

export const DEFAULTS = {
  // ---------------------------------------------------------------- crawl --
  crawl: {
    maxPages: 100,          // max HTML pages fetched per site (override: --max-pages)
    maxDepth: 10,           // link hops from the start URL
    useSitemap: true,       // also seed the crawl from /sitemap.xml when present
    // Extra requests (outside maxPages) used to look up a path that was found
    // on one site only, so "missing page" reports are confirmed rather than
    // caused by the crawl limit.
    maxProbes: 200,
    // Treat www.example.com and example.com as the same site.
    wwwEquivalent: true,
    // Query-string params kept when building page keys. Anything else is dropped,
    // so ?utm_source=... or ?sort=... do not create duplicate pages.
    keepQueryParams: [],
    // Paths ending in these names pair with their directory (/about/index.html == /about/).
    indexFiles: ['index.html', 'index.htm', 'index.php', 'default.aspx', 'default.htm'],
    // Links to these file types are never fetched as pages.
    skipExtensions: ['pdf', 'zip', 'gz', 'rar', '7z', 'exe', 'dmg', 'msi', 'jpg', 'jpeg', 'png', 'gif',
      'webp', 'avif', 'svg', 'ico', 'bmp', 'tif', 'tiff', 'mp3', 'mp4', 'm4a', 'mov', 'avi', 'webm',
      'ogg', 'wav', 'css', 'js', 'mjs', 'json', 'xml', 'rss', 'atom', 'txt', 'csv', 'xls', 'xlsx',
      'doc', 'docx', 'ppt', 'pptx', 'woff', 'woff2', 'ttf', 'otf', 'eot'],
  },

  // --------------------------------------------------------- politeness --
  http: {
    userAgent: 'SiteDiff/1.0 (website comparison crawler)',
    respectRobotsTxt: true, // override: --ignore-robots
    delayMs: 500,           // minimum gap between requests to the same host (override: --delay)
    timeoutMs: 20000,       // per request (override: --timeout)
    retries: 2,             // retries for network errors, timeouts, 429 and 5xx
    maxRedirects: 10,
    maxBodyBytes: 5 * 1024 * 1024,
  },

  // --------------------------------------------------- JavaScript rendering --
  render: {
    // 'auto'   fetch plain HTML, switch to a headless browser for pages (or whole
    //          sites) that look JavaScript-rendered
    // 'always' render every page in the browser (most accurate, slowest)
    // 'never'  plain HTML only
    mode: 'auto',           // override: --render
    viewport: { width: 1280, height: 900 },
    // In 'auto', a page whose static HTML has less visible text than this, and
    // has scripts, is treated as JavaScript-rendered.
    minStaticTextChars: 200,
    waitForNetworkIdleMs: 8000, // cap on waiting for the page to settle
    extraWaitMs: 300,           // small pause after load for late renders
    // Requests the browser never makes, so tracking/analytics do not run
    // (and we don't pollute the live site's analytics).
    blockRequestPatterns: [
      'google-analytics\\.com', 'googletagmanager\\.com', 'doubleclick\\.net', 'facebook\\.net',
      'connect\\.facebook', 'hotjar\\.com', 'segment\\.(io|com)', 'mixpanel\\.com', 'clarity\\.ms',
      'hs-analytics', 'hubspot\\.com/.*analytics', 'fullstory\\.com', 'newrelic\\.com', 'nr-data\\.net',
      'bat\\.bing\\.com', 'snap\\.licdn\\.com', 'ads\\.linkedin', 'tiktok\\.com/.*(pixel|analytics)',
    ],
  },

  // -------------------------------------------------------- visual diffing --
  visual: {
    enabled: false,         // screenshots + pixel comparison (override: --visual). Needs Chromium.
    maxPages: 50,           // at most this many page pairs are screenshotted
    maxHeight: 6000,        // px of page height compared (from the top)
    pixelThreshold: 0.1,    // per-pixel color tolerance, 0..1 (pixelmatch "threshold")
    ignoreBelowPct: 0.5,    // % of pixels changed below which the pages count as visually identical
    cosmeticBelowPct: 5,    // below this % a visual change is "cosmetic"; at or above it, "structural"
    // Elements hidden before screenshots (carousels, chat widgets, cookie banners ...).
    hideSelectors: ['iframe', '[class*="carousel"]', '[class*="slider"]', '[id*="chat-widget"]'],
  },

  // ------------------------------------------------------------ ignore rules --
  // These decide what counts as "noise". Anything matched here is not reported.
  ignore: {
    // Elements removed from both pages before any comparison.
    selectors: [
      'script', 'style', 'noscript', 'template', 'svg',
      '[data-sitediff-ignore]',
      '#onetrust-consent-sdk', '#CybotCookiebotDialog', '.cookie-banner', '.cookie-consent',
      '#cookie-banner', '#cookie-notice', '.cc-window',
    ],
    extraSelectors: [],     // add your own here without replacing the defaults above

    // Text patterns replaced by a placeholder before comparing text.
    //   mode 'ignore'   -> a difference only in these values is not reported
    //   mode 'cosmetic' -> a difference only in these values is reported as cosmetic
    textPatterns: [
      { name: 'iso-timestamp', mode: 'ignore', pattern: '\\b\\d{4}-\\d{2}-\\d{2}[T ]\\d{1,2}:\\d{2}(:\\d{2}(\\.\\d+)?)?\\s?(Z|[+-]\\d{2}:?\\d{2}|UTC|GMT)?' },
      // hh:mm:ss is almost always a generated timestamp; plain hh:mm may be real
      // content (opening hours), so it is only demoted to cosmetic.
      { name: 'clock-time-seconds', mode: 'ignore', pattern: '\\b\\d{1,2}:\\d{2}:\\d{2}(\\.\\d+)?\\s?([ap]\\.?m\\.?)?(\\s?(UTC|GMT|[A-Z]{2,4}T))?(?![\\w])', flags: 'i' },
      { name: 'clock-time', mode: 'cosmetic', pattern: '\\b\\d{1,2}:\\d{2}\\s?([ap]\\.?m\\.?)?(\\s?(UTC|GMT|[A-Z]{2,4}T))?(?![\\w])', flags: 'i' },
      { name: 'relative-time', mode: 'ignore', pattern: '\\b(\\d+|an?|one)\\s+(second|minute|hour|day|week|month|year)s?\\s+ago\\b|\\bjust now\\b', flags: 'i' },
      { name: 'uuid', mode: 'ignore', pattern: '\\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\b', flags: 'i' },
      { name: 'hex-token', mode: 'ignore', pattern: '\\b(?=[0-9a-f]*\\d)(?=[0-9a-f]*[a-f])[0-9a-f]{16,}\\b', flags: 'i' },
      { name: 'copyright-year', mode: 'ignore', pattern: '(©|&copy;|\\(c\\)|copyright)\\s*\\d{4}(\\s*[-–]\\s*\\d{4})?', flags: 'i' },
      // Plain dates are NOT hidden (an event date changing is real content), but a
      // difference in dates alone is flagged as cosmetic so it is easy to filter.
      { name: 'date', mode: 'cosmetic', pattern: '\\b\\d{4}-\\d{2}-\\d{2}\\b|\\b\\d{1,2}[/.]\\d{1,2}[/.]\\d{2,4}\\b|\\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\\.?\\s+\\d{1,2}(st|nd|rd|th)?,?\\s+\\d{4}\\b|\\b\\d{1,2}(st|nd|rd|th)?\\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\\.?,?\\s+\\d{4}\\b', flags: 'i' },
    ],
    extraTextPatterns: [],

    // Query params removed from every link/image URL before comparing.
    trackingParams: ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'utm_id',
      'gclid', 'dclid', 'fbclid', 'msclkid', 'mc_cid', 'mc_eid', '_ga', '_gl', 'yclid', 'igshid',
      'ref', 'ref_src', 'hsa_*', '_hs*', 'v', 'ver', 'version', 'cb', '_', 'cachebuster', 'ts', 't'],

    // Crawl never visits URLs whose path matches one of these.
    urlPatterns: ['/wp-admin', '/wp-login', '/cdn-cgi/', '/cart', '/checkout', '/login', '/logout',
      '/signin', '/signout', '/account', '/search'],
    extraUrlPatterns: [],

    // Parts of image file names ignored when matching images (hashes, sizes).
    imageNamePatterns: ['[-_.][0-9a-f]{6,}(?=\\.[a-z0-9]+$)', '-\\d{2,4}x\\d{2,4}(?=\\.[a-z0-9]+$)', '@[23]x(?=\\.[a-z0-9]+$)'],

    ignoreHiddenFormFields: true,  // hidden inputs usually carry CSRF tokens / tracking
    caseAndPunctuationIsCosmetic: true, // "Contact us" vs "Contact Us!" -> cosmetic, not changed

    // Whole comparison categories to skip, e.g. ['structure', 'images'].
    // Categories: page, metadata, headings, structure, text, links, images, forms, cta, visual
    skipCategories: [],
  },

  // ------------------------------------------------------------ comparison --
  compare: {
    textSimilarityForChange: 0.45, // two blocks this similar are shown as one "changed" block
    renameSimilarity: 0.6,         // two unmatched pages this similar are treated as renamed
    // A difference seen on at least this many pages AND this fraction of compared
    // pages is shown once under "Site-wide differences" (nav/footer changes).
    siteWide: { minPages: 3, minFraction: 0.3 },
  },

  // ---------------------------------------------------------------- output --
  output: {
    dir: 'reports',          // override: --out. A sub-folder per run is created inside it.
    subfolderPerRun: true,   // false = write straight into `dir`
    labelA: 'Site A',        // override: --label-a  (e.g. "Live")
    labelB: 'Site B',        // override: --label-b  (e.g. "Redesign")
    writeJson: true,         // also write report.json (machine-readable)
    maxDiffsPerCategory: 150, // per page; the rest are summarised as "N more"
  },
};

/** Deep-merge `override` into `base` (arrays replace, objects merge). */
export function mergeConfig(base, override) {
  if (override === undefined || override === null) return structuredClone(base);
  if (Array.isArray(base) || Array.isArray(override) || typeof base !== 'object' || typeof override !== 'object') {
    return structuredClone(override);
  }
  const out = structuredClone(base);
  for (const [k, v] of Object.entries(override)) {
    out[k] = k in base ? mergeConfig(base[k], v) : structuredClone(v);
  }
  return out;
}

/** Build the effective config from defaults + optional overrides (JSON file and/or CLI). */
export function buildConfig(...overrides) {
  let cfg = structuredClone(DEFAULTS);
  for (const o of overrides) cfg = mergeConfig(cfg, o);
  const ig = cfg.ignore;
  ig.allSelectors = [...ig.selectors, ...ig.extraSelectors];
  ig.allTextPatterns = [...ig.textPatterns, ...ig.extraTextPatterns];
  ig.allUrlPatterns = [...ig.urlPatterns, ...ig.extraUrlPatterns];
  return cfg;
}
