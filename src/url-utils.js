/**
 * URL helpers: crawl scope, page keys and link normalisation.
 *
 * A *page key* is a page's path relative to the site's start URL, normalised so
 * that the same page on both sites gets the same key:
 *   https://www.example.com/about/            -> /about
 *   https://staging.example.com/v2/about/index.html (start /v2/) -> /about
 */

const ESCAPE_RE = /[.*+?^${}()|[\]\\]/g;
const escapeRe = (s) => s.replace(ESCAPE_RE, '\\$&');

/** Host used for comparing "same site": lower-case, default port dropped, optional www stripped. */
export function normHost(u, wwwEquivalent = true) {
  let h = u.hostname.toLowerCase();
  if (wwwEquivalent) h = h.replace(/^www\./, '');
  const port = u.port && !((u.protocol === 'http:' && u.port === '80') || (u.protocol === 'https:' && u.port === '443')) ? `:${u.port}` : '';
  return h + port;
}

/** Describe a site's crawl scope from its start URL. */
export function createScope(startUrl, cfg) {
  const u = new URL(startUrl);
  if (!/^https?:$/.test(u.protocol)) throw new Error(`Only http(s) URLs are supported: ${startUrl}`);
  let base = u.pathname || '/';
  if (!base.endsWith('/')) {
    const last = base.split('/').pop();
    base = last.includes('.') ? base.slice(0, base.length - last.length) : base + '/';
  }
  return {
    startUrl: u.href,
    origin: u.origin,
    host: normHost(u, cfg.crawl.wwwEquivalent),
    basePath: base,
  };
}

export function isInScope(url, scope, cfg) {
  let u;
  try { u = url instanceof URL ? url : new URL(url); } catch { return false; }
  if (!/^https?:$/.test(u.protocol)) return false;
  if (normHost(u, cfg.crawl.wwwEquivalent) !== scope.host) return false;
  const p = u.pathname;
  return p.startsWith(scope.basePath) || p + '/' === scope.basePath;
}

/** Page key for an in-scope URL. */
export function toKey(url, scope, cfg) {
  const u = url instanceof URL ? new URL(url.href) : new URL(url);
  let path = u.pathname;
  try { path = decodeURI(path); } catch { /* keep raw */ }
  path = path.replace(/\/{2,}/g, '/');
  const base = scope.basePath;
  if (path.startsWith(base)) path = '/' + path.slice(base.length);
  else if (path + '/' === base) path = '/';
  for (const idx of cfg.crawl.indexFiles) {
    if (path.toLowerCase().endsWith('/' + idx.toLowerCase())) { path = path.slice(0, -idx.length); break; }
  }
  if (path.length > 1 && path.endsWith('/')) path = path.replace(/\/+$/, '') || '/';
  const keep = cfg.crawl.keepQueryParams;
  if (keep.length) {
    const params = [...u.searchParams].filter(([k]) => keep.includes(k)).sort(([a], [b]) => a.localeCompare(b));
    if (params.length) path += '?' + new URLSearchParams(params).toString();
  }
  return path;
}

/** Absolute URL for a page key on a site. */
export function keyToUrl(key, scope) {
  return scope.origin + scope.basePath.replace(/\/$/, '') + (key === '/' ? '/' : key);
}

/** A looser key used to pair pages whose URL changed only cosmetically (/About.html vs /about). */
export function looseKey(key) {
  return key.toLowerCase()
    .replace(/\.(html?|php|aspx?|jsp|cfm)(?=$|\?)/, '')
    .replace(/_/g, '-')
    .replace(/\/+$/, '') || '/';
}

function paramMatchers(patterns) {
  return patterns.map((p) => new RegExp('^' + p.split('*').map(escapeRe).join('.*') + '$', 'i'));
}
const matcherCache = new WeakMap();

/** Remove tracking / cache-buster query params (supports * wildcards, e.g. "hsa_*"). */
export function stripTrackingParams(u, cfg) {
  let m = matcherCache.get(cfg);
  if (!m) { m = paramMatchers(cfg.ignore.trackingParams); matcherCache.set(cfg, m); }
  for (const k of [...u.searchParams.keys()]) {
    if (m.some((re) => re.test(k))) u.searchParams.delete(k);
  }
  u.searchParams.sort();
  return u;
}

/** Comparable form of an off-site URL. */
export function normalizeExternalUrl(href, cfg) {
  const u = stripTrackingParams(new URL(href), cfg);
  u.hash = '';
  let path = u.pathname.replace(/\/+$/, '') || '';
  const q = u.searchParams.toString();
  return `${u.protocol === 'http:' || u.protocol === 'https:' ? '' : u.protocol}//${normHost(u, true)}${path}${q ? '?' + q : ''}`;
}

export function hasSkippedExtension(pathname, cfg) {
  const m = /\.([a-z0-9]{1,5})$/i.exec(pathname);
  return !!m && cfg.crawl.skipExtensions.includes(m[1].toLowerCase());
}

/**
 * Crawl exclusions. A plain path such as "/cart" matches that path segment and
 * anything below it ("/cart", "/cart/items", not "/cartoons"). A pattern with
 * regex characters is used as a regular expression against the path.
 */
export function isExcludedPath(pathname, cfg) {
  return cfg.ignore.allUrlPatterns.some((p) => {
    const isPlain = !/[\\^$*+?()[\]{}|]/.test(p);
    const re = isPlain ? new RegExp(escapeRe(p) + '(/|$)', 'i') : new RegExp(p, 'i');
    return re.test(pathname);
  });
}
