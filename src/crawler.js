/**
 * Breadth-first crawl of one site, bounded to its own host and start path.
 *
 * Result (a "SiteCrawl"):
 *   pages          Map<pageKey, PageRecord>   every page fetched (after redirects)
 *   aliases        Map<requestedKey, finalKey> URLs that redirected to another page
 *   robotsBlocked  Set<pageKey>               pages we were not allowed to fetch
 *   skipped        [{ url, reason }]          links we chose not to follow
 *   limitReached   true if maxPages stopped the crawl with pages still queued
 *
 * PageRecord: { key, url, finalUrl, status, redirects, error, rendered, renderError,
 *               contentType, snapshot, depth, foundBy }
 */
import { extractSnapshot, looksJsRendered } from './extract.js';
import { isInScope, toKey, keyToUrl, hasSkippedExtension, isExcludedPath } from './url-utils.js';

export class SiteCrawler {
  constructor(site, fetcher, cfg, log) {
    this.site = site;       // { id: 'A'|'B', label, scope, renderMode }
    this.fetcher = fetcher;
    this.cfg = cfg;
    this.log = log;
    this.pages = new Map();
    this.aliases = new Map();
    this.redirectCodes = new Map(); // requestedKey -> first redirect status (301, 302, 'script')
    this.robotsBlocked = new Set();
    this.skipped = [];
    this.limitReached = false;
    this.probesUsed = 0;
  }

  /** Fetch one URL (rendering it if needed) and build its PageRecord. */
  async fetchPage(url, depth, foundBy) {
    const { scope, renderMode } = this.site;
    const r = await this.fetcher.fetchPage(url, scope);
    if (r.robotsBlocked) return { robotsBlocked: true, url, finalUrl: r.finalUrl };
    const rec = {
      url, finalUrl: r.finalUrl, status: r.status, redirects: r.redirects, error: r.error,
      contentType: r.contentType, rendered: false, renderError: null, snapshot: null, depth, foundBy,
    };
    let html = r.html;
    const ok = r.status >= 200 && r.status < 300;
    const isHtml = html != null && (!r.contentType || r.contentType.includes('html'));
    if (!isHtml && ok && !r.error) rec.error = `Not an HTML page (${r.contentType || 'unknown type'})`;
    if (ok && isHtml && (renderMode === 'always' || (renderMode === 'auto' && looksJsRendered(html, this.cfg)))) {
      const rr = await this.fetcher.render(r.finalUrl);
      if (rr.error) rec.renderError = rr.error;
      else {
        html = rr.html;
        rec.rendered = true;
        if (rr.finalUrl && rr.finalUrl !== r.finalUrl && isInScope(rr.finalUrl, scope, this.cfg)) {
          rec.redirects = [...rec.redirects, { url: r.finalUrl, status: 'script' }];
          rec.finalUrl = rr.finalUrl;
        }
      }
    }
    // Error pages are parsed too (so a soft 404 page is still visible), but we do
    // not follow their links.
    if (isHtml) rec.snapshot = extractSnapshot(html, rec.finalUrl, scope, this.cfg);
    return rec;
  }

  /** Store a record under its final key; returns the key used (or null if blocked). */
  store(requestedKey, rec) {
    if (rec.robotsBlocked) { this.robotsBlocked.add(requestedKey); return null; }
    const { scope } = this.site;
    const finalKey = isInScope(rec.finalUrl, scope, this.cfg) ? toKey(rec.finalUrl, scope, this.cfg) : requestedKey;
    rec.key = finalKey;
    if (finalKey !== requestedKey) {
      this.aliases.set(requestedKey, finalKey);
      this.redirectCodes.set(requestedKey, rec.redirects[0]?.status ?? 'redirect');
    }
    if (!this.pages.has(finalKey)) this.pages.set(finalKey, rec);
    return finalKey;
  }

  /** Decide whether a discovered URL should be crawled. Returns a reason string if not. */
  rejectReason(url) {
    let u;
    try { u = new URL(url); } catch { return 'invalid URL'; }
    if (!isInScope(u, this.site.scope, this.cfg)) return 'outside site';
    if (hasSkippedExtension(u.pathname, this.cfg)) return 'file download (not a page)';
    if (isExcludedPath(u.pathname, this.cfg)) return 'excluded by ignore.urlPatterns';
    return null;
  }

  async sitemapUrls() {
    const { scope } = this.site;
    const urls = new Set();
    const toVisit = [scope.origin + scope.basePath + 'sitemap.xml'];
    const robots = await this.fetcher.getRobots(scope.origin).catch(() => null);
    for (const s of robots?.getSitemaps?.() || []) if (!toVisit.includes(s)) toVisit.push(s);
    for (let i = 0; i < toVisit.length && i < 6; i++) {
      const xml = await this.fetcher.fetchText(toVisit[i]);
      if (!xml || !/<(urlset|sitemapindex)/i.test(xml)) continue;
      const locs = [...xml.matchAll(/<loc>\s*(?:<!\[CDATA\[)?\s*([^<\]]+?)\s*(?:\]\]>)?\s*<\/loc>/gi)].map((m) => m[1].replace(/&amp;/g, '&'));
      if (/<sitemapindex/i.test(xml)) locs.forEach((l) => toVisit.includes(l) || toVisit.push(l));
      else locs.forEach((l) => urls.add(l));
    }
    return [...urls].filter((u) => !this.rejectReason(u)).slice(0, this.cfg.crawl.maxPages * 2);
  }

  async crawl() {
    const { scope, id } = this.site;
    const { maxPages, maxDepth, useSitemap } = this.cfg.crawl;
    const queue = [{ url: scope.startUrl, depth: 0, foundBy: 'start URL' }];
    const queued = new Set([toKey(scope.startUrl, scope, this.cfg)]);
    const enqueue = (url, depth, foundBy) => {
      const why = this.rejectReason(url);
      if (why) {
        if (why !== 'outside site' && this.skipped.length < 500 && !this.skipped.some((s) => s.url === url)) this.skipped.push({ url, reason: why });
        return;
      }
      const key = toKey(url, scope, this.cfg);
      if (queued.has(key)) return;
      queued.add(key);
      queue.push({ url, depth, foundBy });
    };

    let fetched = 0;
    let sitemapDone = !useSitemap;
    while (queue.length && fetched < maxPages && !this.site.signal?.aborted) {
      const item = queue.shift();
      const reqKey = toKey(item.url, scope, this.cfg);
      if (this.pages.has(reqKey) || this.aliases.has(reqKey)) continue;
      const rec = await this.fetchPage(item.url, item.depth, item.foundBy);
      fetched++;
      // A start URL that cannot be reached at all (DNS, refused, timeout) means the
      // whole site is down: stop here instead of probing hundreds of URLs.
      if (fetched === 1 && !rec.robotsBlocked && !rec.status && rec.error) {
        this.unreachable = rec.error;
        this.store(reqKey, rec);
        this.log(`[${id}] site unreachable: ${rec.error}`);
        break;
      }
      const key = this.store(reqKey, rec);
      if (!key) {
        this.skipped.push({ url: item.url, reason: 'disallowed by robots.txt' });
        this.log(`[${id}] ${fetched}/${maxPages} ${reqKey}  (robots.txt: skipped)`);
      } else {
        const s = rec.error ? rec.error : rec.status;
        this.log(`[${id}] ${fetched}/${maxPages} ${reqKey}${key !== reqKey ? ' -> ' + key : ''}  (${s}${rec.rendered ? ', rendered' : ''})`);
        if (rec.snapshot && rec.status < 400 && item.depth < maxDepth) {
          for (const link of rec.snapshot.crawlLinks) enqueue(link, item.depth + 1, key);
        }
      }
      // Seed from the sitemap after the home page, so link discovery keeps its natural order.
      if (!sitemapDone) {
        sitemapDone = true;
        for (const u of await this.sitemapUrls()) enqueue(u, 1, 'sitemap.xml');
      }
    }
    this.limitReached = queue.some((q) => !this.pages.has(toKey(q.url, scope, this.cfg)));
    if (this.limitReached) this.log(`[${id}] page limit (${maxPages}) reached; ${queue.length} queued pages not crawled`);
    return this;
  }

  /**
   * Look up one page key directly (used when the other site has a page we did
   * not reach). Returns the final key, 'robots', or null when the budget is used up.
   */
  async probe(key) {
    if (this.pages.has(key)) return key;
    if (this.aliases.has(key)) return this.aliases.get(key);
    if (this.robotsBlocked.has(key)) return 'robots';
    if (this.unreachable || this.site.signal?.aborted) return null;
    if (this.probesUsed >= this.cfg.crawl.maxProbes) return null;
    this.probesUsed++;
    const url = keyToUrl(key, this.site.scope);
    const rec = await this.fetchPage(url, null, 'direct request (not linked)');
    rec.probed = true;
    const finalKey = this.store(key, rec);
    this.log(`[${this.site.id}] probe ${key}${finalKey && finalKey !== key ? ' -> ' + finalKey : ''}  (${rec.robotsBlocked ? 'robots.txt' : rec.error || rec.status})`);
    return finalKey ?? 'robots';
  }
}
