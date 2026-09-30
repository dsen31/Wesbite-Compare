/**
 * Network layer: polite HTTP fetching (rate limit, robots.txt, retries,
 * timeouts, redirect tracking) plus optional headless-browser rendering and
 * screenshots through Playwright.
 *
 * Nothing in here throws for an ordinary network problem; failures come back
 * as `{ error: '...' }` so the crawl carries on and the report can show them.
 */
import robotsParser from 'robots-parser';
import { isInScope } from './url-utils.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RETRY_STATUSES = new Set([429, 500, 502, 503, 504]);
const ROBOTS_AGENT = 'SiteDiff';

/** Turn low-level fetch errors into a short, readable message. */
export function describeError(err, timeoutMs) {
  if (!err) return 'Unknown error';
  if (err.name === 'TimeoutError' || err.name === 'AbortError') return `Timed out after ${Math.round(timeoutMs / 1000)}s`;
  const code = err.cause?.code || err.code;
  const map = {
    ECONNREFUSED: 'Connection refused', ENOTFOUND: 'Host not found (DNS)', EAI_AGAIN: 'DNS lookup failed',
    ECONNRESET: 'Connection reset', ETIMEDOUT: 'Connection timed out', EHOSTUNREACH: 'Host unreachable',
    UND_ERR_CONNECT_TIMEOUT: 'Connection timed out', UND_ERR_HEADERS_TIMEOUT: 'Server did not respond in time',
    CERT_HAS_EXPIRED: 'TLS certificate expired', DEPTH_ZERO_SELF_SIGNED_CERT: 'Self-signed TLS certificate',
    ERR_TLS_CERT_ALTNAME_INVALID: 'TLS certificate does not match host', UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'TLS certificate could not be verified',
  };
  if (code && map[code]) return `${map[code]} (${code})`;
  return (err.cause?.message || err.message || String(err)).slice(0, 200);
}

export class Fetcher {
  constructor(cfg, log = () => {}) {
    this.cfg = cfg;
    this.log = log;
    this.lastRequest = new Map();   // host -> timestamp of last request
    this.queues = new Map();        // host -> promise chain (serialises requests per host)
    this.hostDelay = new Map();     // host -> delay in ms (robots Crawl-delay may raise it)
    this.robots = new Map();        // origin -> Promise<robots | null>
    this.browserPromise = null;
    this.browserError = null;
    this.stats = { requests: 0, rendered: 0, screenshots: 0 };
  }

  /** Wait until we may send another request to `host`. */
  throttle(host) {
    const prev = this.queues.get(host) || Promise.resolve();
    const next = prev.then(async () => {
      const delay = Math.max(this.cfg.http.delayMs, this.hostDelay.get(host) || 0);
      const wait = (this.lastRequest.get(host) || 0) + delay - Date.now();
      if (wait > 0) await sleep(wait);
      this.lastRequest.set(host, Date.now());
    });
    this.queues.set(host, next.catch(() => {}));
    return next;
  }

  // ------------------------------------------------------------ robots.txt --
  async getRobots(origin) {
    if (!this.robots.has(origin)) {
      this.robots.set(origin, (async () => {
        const url = origin + '/robots.txt';
        try {
          await this.throttle(new URL(origin).host);
          this.stats.requests++;
          const res = await fetch(url, {
            headers: { 'user-agent': this.cfg.http.userAgent },
            signal: AbortSignal.timeout(this.cfg.http.timeoutMs),
          });
          if (!res.ok) return null; // no robots.txt -> everything allowed
          const robots = robotsParser(url, await res.text());
          const cd = robots.getCrawlDelay(ROBOTS_AGENT);
          if (cd) {
            const ms = Math.min(cd, 30) * 1000;
            this.hostDelay.set(new URL(origin).host, ms);
            this.log(`robots.txt on ${origin} asks for a ${cd}s crawl delay${cd > 30 ? ' (capped at 30s)' : ''}`);
          }
          return robots;
        } catch {
          return null; // unreachable robots.txt: treat as no rules; the page fetch will report the real problem
        }
      })());
    }
    return this.robots.get(origin);
  }

  async isAllowedByRobots(url) {
    if (!this.cfg.http.respectRobotsTxt) return true;
    const robots = await this.getRobots(new URL(url).origin);
    return !robots || robots.isAllowed(url, ROBOTS_AGENT) !== false;
  }

  // ------------------------------------------------------------ plain HTTP --
  /** One HTTP request with timeout and retries; does not follow redirects. */
  async request(url) {
    const { retries, timeoutMs, userAgent } = this.cfg.http;
    let lastErr;
    for (let attempt = 0; attempt <= retries; attempt++) {
      await this.throttle(new URL(url).host);
      this.stats.requests++;
      try {
        const res = await fetch(url, {
          redirect: 'manual',
          headers: { 'user-agent': userAgent, accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5' },
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (RETRY_STATUSES.has(res.status) && attempt < retries) {
          const ra = Number(res.headers.get('retry-after'));
          await res.body?.cancel().catch(() => {});
          await sleep(Number.isFinite(ra) && ra > 0 ? Math.min(ra, 30) * 1000 : 1000 * 2 ** attempt);
          continue;
        }
        return { res };
      } catch (err) {
        lastErr = err;
        if (attempt < retries) await sleep(1000 * 2 ** attempt);
      }
    }
    return { error: describeError(lastErr, timeoutMs) };
  }

  /**
   * Fetch a page, following redirects within the site's scope.
   * Returns { requestedUrl, finalUrl, status, redirects[], contentType, html, error, robotsBlocked, offSite }.
   */
  async fetchPage(url, scope) {
    const out = { requestedUrl: url, finalUrl: url, status: null, redirects: [], contentType: '', html: null, error: null };
    let current = url;
    for (let hop = 0; hop <= this.cfg.http.maxRedirects; hop++) {
      if (!(await this.isAllowedByRobots(current))) {
        return { ...out, finalUrl: current, robotsBlocked: true, error: 'Disallowed by robots.txt (not fetched)' };
      }
      const { res, error } = await this.request(current);
      if (error) return { ...out, finalUrl: current, error };
      const loc = res.headers.get('location');
      if (res.status >= 300 && res.status < 400 && loc) {
        await res.body?.cancel().catch(() => {});
        out.redirects.push({ url: current, status: res.status });
        const next = new URL(loc, current).href;
        if (!isInScope(next, scope, this.cfg)) {
          return { ...out, finalUrl: next, status: res.status, offSite: true, error: `Redirects outside the site to ${next}` };
        }
        current = next;
        continue;
      }
      out.finalUrl = current;
      out.status = res.status;
      out.contentType = (res.headers.get('content-type') || '').toLowerCase();
      const isHtml = out.contentType.includes('html') || out.contentType === '';
      if (!isHtml) { await res.body?.cancel().catch(() => {}); return out; }
      try {
        const buf = Buffer.from(await res.arrayBuffer());
        out.html = buf.subarray(0, this.cfg.http.maxBodyBytes).toString('utf8');
      } catch (err) {
        out.error = `Could not read response body: ${describeError(err, this.cfg.http.timeoutMs)}`;
      }
      return out;
    }
    return { ...out, finalUrl: current, error: `Too many redirects (more than ${this.cfg.http.maxRedirects})` };
  }

  /** Plain GET of a text resource (sitemaps). Returns text or null. */
  async fetchText(url) {
    if (!(await this.isAllowedByRobots(url))) return null;
    const { res } = await this.request(url);
    if (!res || !res.ok) { await res?.body?.cancel().catch(() => {}); return null; }
    return res.text().catch(() => null);
  }

  // ------------------------------------------------------ headless browser --
  /** Launch Chromium once, lazily. Resolves to null if Playwright/Chromium is unavailable. */
  getBrowser() {
    if (!this.browserPromise) {
      this.browserPromise = (async () => {
        try {
          const { chromium } = await import('playwright');
          return await chromium.launch({ headless: true });
        } catch (err) {
          const msg = String(err.message || err);
          this.browserError = /Executable doesn't exist|browserType\.launch/i.test(msg)
            ? 'Chromium is not installed. Run: npx playwright install chromium'
            : `Headless browser unavailable: ${msg.split('\n')[0]}`;
          this.log(`WARNING: ${this.browserError}. Falling back to plain HTML.`);
          return null;
        }
      })();
    }
    return this.browserPromise;
  }

  async browserAvailable() { return !!(await this.getBrowser()); }

  async withPage(url, { allowImages }, fn) {
    const browser = await this.getBrowser();
    if (!browser) return { error: this.browserError };
    await this.throttle(new URL(url).host);
    this.stats.requests++;
    const { viewport, blockRequestPatterns, waitForNetworkIdleMs, extraWaitMs } = this.cfg.render;
    const blockRe = blockRequestPatterns.length ? new RegExp(blockRequestPatterns.join('|'), 'i') : null;
    const context = await browser.newContext({ userAgent: this.cfg.http.userAgent, viewport, reducedMotion: 'reduce' });
    try {
      await context.route('**/*', (route) => {
        const req = route.request();
        const t = req.resourceType();
        if (blockRe && blockRe.test(req.url())) return route.abort();
        if (!allowImages && (t === 'image' || t === 'media' || t === 'font')) return route.abort();
        return route.continue();
      });
      const page = await context.newPage();
      const response = await page.goto(url, { waitUntil: 'load', timeout: this.cfg.http.timeoutMs });
      await page.waitForLoadState('networkidle', { timeout: waitForNetworkIdleMs }).catch(() => {});
      if (extraWaitMs) await page.waitForTimeout(extraWaitMs);
      return await fn(page, response);
    } catch (err) {
      return { error: `Browser: ${String(err.message || err).split('\n')[0].slice(0, 200)}` };
    } finally {
      await context.close().catch(() => {});
    }
  }

  /** Render a page in the browser; returns { html, finalUrl, status } or { error }. */
  async render(url) {
    this.stats.rendered++;
    return this.withPage(url, { allowImages: false }, async (page, response) => ({
      html: await page.content(),
      finalUrl: page.url(),
      status: response ? response.status() : null,
    }));
  }

  /** Full-page PNG screenshot (height capped) as a Buffer, or { error }. */
  async screenshot(url) {
    this.stats.screenshots++;
    const { hideSelectors, maxHeight } = this.cfg.visual;
    return this.withPage(url, { allowImages: true }, async (page) => {
      if (hideSelectors.length) {
        await page.addStyleTag({ content: `${hideSelectors.join(',')}{visibility:hidden !important}` }).catch(() => {});
      }
      const height = await page.evaluate(() => document.documentElement.scrollHeight).catch(() => 900);
      const width = this.cfg.render.viewport.width;
      const png = await page.screenshot({
        fullPage: true, animations: 'disabled', caret: 'hide',
        clip: { x: 0, y: 0, width, height: Math.max(1, Math.min(height, maxHeight)) },
      });
      return { png, fullHeight: height };
    });
  }

  async close() {
    const b = this.browserPromise && (await this.browserPromise);
    if (b) await b.close().catch(() => {});
  }
}
