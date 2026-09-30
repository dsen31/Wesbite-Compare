/**
 * Orchestrates a full comparison run:
 *   decide rendering -> crawl both sites -> pair pages -> compare -> write report.
 *
 * Use `runComparison()` from your own scripts, or the CLI (src/cli.js).
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { Fetcher } from './fetcher.js';
import { SiteCrawler } from './crawler.js';
import { pairPages, pageState } from './pairing.js';
import { compareSnapshots, consolidateSiteWide, mkDiff, SIGNIFICANCE, CATEGORIES } from './compare.js';
import { compareVisual } from './visual.js';
import { looksJsRendered } from './extract.js';
import { createScope } from './url-utils.js';
import { writeReport } from './report.js';

const CATEGORY_ORDER = Object.keys(CATEGORIES);

function statusLookup(crawl) {
  return (key) => {
    if (crawl.robotsBlocked.has(key)) return { robots: true };
    const k = crawl.aliases.get(key) ?? key;
    const rec = crawl.pages.get(k);
    return rec ? { status: rec.status, error: rec.error } : undefined;
  };
}

/** Page-level differences: URL changes, missing pages, load failures. */
function pageDiffs(p, crawlA, crawlB, L) {
  const out = [];
  const st = (rec) => (rec.error && !rec.status ? rec.error : `HTTP ${rec.status}${rec.error ? ' — ' + rec.error : ''}`);
  const oldUrlNote = () => {
    const rec = crawlB.pages.get(crawlB.aliases.get(p.keyA) ?? p.keyA);
    if (crawlB.aliases.get(p.keyA) === p.keyB) return `${p.keyA} redirects to ${p.keyB} on ${L.B}.`;
    if (rec && pageState(rec) === 'missing') return `The old URL ${p.keyA} returns ${rec.status} on ${L.B} (no redirect): old links and bookmarks will break.`;
    return undefined;
  };
  if (p.kind === 'only-a') {
    const o = p.other;
    if (o.state === 'robots' || o.state === 'unknown') out.push(mkDiff('page', 'error', `Could not check this page on ${L.B}`, `${p.keyA} → ${st(p.recA)}`, o.text));
    else out.push(mkDiff('page', 'missing', `Page missing on ${L.B}`, `${p.keyA} → ${st(p.recA)}`, `${p.keyA} ${o.text}`));
  } else if (p.kind === 'only-b') {
    const o = p.other;
    if (o.state === 'robots' || o.state === 'unknown') out.push(mkDiff('page', 'error', `Could not check this page on ${L.A}`, o.text, `${p.keyB} → ${st(p.recB)}`));
    else out.push(mkDiff('page', 'added', `Page only on ${L.B}`, `${p.keyB} ${o.text}`, `${p.keyB} → ${st(p.recB)}`));
  } else if (p.kind === 'error') {
    const fa = p.recA && pageState(p.recA) !== 'ok', fb = p.recB && pageState(p.recB) !== 'ok';
    const who = fa && fb ? 'both sites' : fb ? L.B : L.A;
    out.push(mkDiff('page', 'error', `Page failed to load on ${who}`,
      p.recA ? `${p.keyA} → ${st(p.recA)}` : '(not on this site)', p.recB ? `${p.keyB} → ${st(p.recB)}` : '(not on this site)'));
  }
  if (p.match === 'redirect') {
    const code = p.redirectOn === 'B' ? crawlB.redirectCodes.get(p.keyA) : crawlA.redirectCodes.get(p.keyB);
    out.push(mkDiff('page', 'structural', 'URL changed (old URL redirects)', p.keyA, `${p.redirectOn === 'B' ? p.keyA : p.keyB} → ${code} → ${p.redirectOn === 'B' ? p.keyB : p.keyA}`,
      { note: `On ${p.redirectOn === 'B' ? L.B : L.A}, this URL redirects. Content is compared against the page it redirects to.` }));
  } else if (p.match === 'url-variant') {
    out.push(mkDiff('page', 'structural', 'URL changed', p.keyA, p.keyB, { note: oldUrlNote() }));
  } else if (p.match === 'moved') {
    out.push(mkDiff('page', 'structural', `Page appears to have moved (${Math.round(p.similarity * 100)}% similar content)`, p.keyA, p.keyB,
      { note: oldUrlNote() || 'Matched by content similarity, not by URL.' }));
  }
  if (p.kind === 'compared') {
    if (p.recB.probed && !p.recA.probed) out.push(mkDiff('page', 'structural', `Not linked from ${L.B}'s pages`, `Linked (found by crawling)`, 'Found only by requesting the URL directly',
      { note: `No page the crawler reached on ${L.B} links here; visitors may not be able to find it.` }));
    if (p.recA.probed && !p.recB.probed) out.push(mkDiff('page', 'structural', `Not linked from ${L.A}'s pages`, 'Found only by requesting the URL directly', 'Linked (found by crawling)'));
  }
  return out;
}

function runFolderName(scopeA, scopeB) {
  const ts = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  const clean = (h) => h.replace(/[^a-z0-9.-]+/gi, '_');
  return `${clean(scopeA.host)}-vs-${clean(scopeB.host)}-${ts}`;
}

/**
 * Run a comparison.
 * @param {object} opts { urlA, urlB, cfg, log }
 * @returns {Promise<{ result, reportPath, jsonPath }>}
 */
export async function runComparison({ urlA, urlB, cfg, log = console.log }) {
  const started = new Date();
  const L = { A: cfg.output.labelA, B: cfg.output.labelB };
  const notes = [];
  const fetcher = new Fetcher(cfg, log);
  try {
    const scopeA = createScope(urlA, cfg), scopeB = createScope(urlB, cfg);

    // --- decide how to render
    let renderMode = cfg.render.mode;
    if (renderMode === 'auto') {
      const [ra, rb] = await Promise.all([fetcher.fetchPage(scopeA.startUrl, scopeA), fetcher.fetchPage(scopeB.startUrl, scopeB)]);
      const jsA = looksJsRendered(ra.html, cfg), jsB = looksJsRendered(rb.html, cfg);
      if (jsA || jsB) {
        if (await fetcher.browserAvailable()) {
          renderMode = 'always';
          notes.push(`${jsA && jsB ? 'Both sites appear' : `${jsA ? L.A : L.B} appears`} to rely on JavaScript, so every page on both sites was rendered in a headless browser.`);
        } else {
          renderMode = 'never';
          notes.push(`WARNING: ${[jsA && L.A, jsB && L.B].filter(Boolean).join(' and ')} appears to need JavaScript, but ${fetcher.browserError}. Results may miss JavaScript-rendered content.`);
        }
      }
    } else if (renderMode === 'always' && !(await fetcher.browserAvailable())) {
      renderMode = 'never';
      notes.push(`WARNING: rendering was requested but ${fetcher.browserError}. Compared plain HTML instead.`);
    }
    log(`Render mode: ${renderMode}`);

    // --- crawl both sites in parallel (different hosts, each rate-limited on its own)
    const crawlA = new SiteCrawler({ id: 'A', label: L.A, scope: scopeA, renderMode }, fetcher, cfg, log);
    const crawlB = new SiteCrawler({ id: 'B', label: L.B, scope: scopeB, renderMode }, fetcher, cfg, log);
    await Promise.all([crawlA.crawl(), crawlB.crawl()]);
    for (const c of [crawlA, crawlB]) {
      const lab = L[c.site.id];
      if (c.unreachable) notes.push(`ERROR: ${lab} could not be reached at ${c.site.scope.startUrl}: ${c.unreachable}.`);
      if (c.limitReached) notes.push(`${lab}: the page limit (${cfg.crawl.maxPages}) was reached, so some pages were not crawled. Raise it with --max-pages.`);
      const robots = c.skipped.filter((s) => s.reason.includes('robots')).length;
      if (robots) notes.push(`${lab}: ${robots} URL(s) were not fetched because robots.txt disallows them (use --ignore-robots to include them).`);
    }
    if (fetcher.browserError && renderMode === 'auto' && [...crawlA.pages.values(), ...crawlB.pages.values()].some((r) => r.renderError)) {
      notes.push(`WARNING: some pages looked JavaScript-rendered but ${fetcher.browserError}. They were compared as plain HTML.`);
    }

    // --- pair and compare
    const pairs = await pairPages(crawlA, crawlB, cfg, log);
    if (crawlA.probesUsed >= cfg.crawl.maxProbes || crawlB.probesUsed >= cfg.crawl.maxProbes) {
      notes.push(`The limit on direct page checks (crawl.maxProbes = ${cfg.crawl.maxProbes}) was reached; some "only on one site" results are unconfirmed.`);
    }
    // Pages matched under different paths: links to them are compared by the matched path.
    const renamed = new Map(pairs.filter((p) => p.keyA && p.keyB && p.keyA !== p.keyB).map((p) => [p.keyA, p.keyB]));
    const ctx = {
      cfg, scopeA, scopeB, labelA: L.A, labelB: L.B, statusA: statusLookup(crawlA), statusB: statusLookup(crawlB),
      mapAtoB: (key) => renamed.get(key) ?? key,
    };
    const outDir = cfg.output.subfolderPerRun ? path.join(cfg.output.dir, runFolderName(scopeA, scopeB)) : cfg.output.dir;
    const assetsDir = path.join(outDir, 'assets');
    let visualCount = 0;
    // Screenshots from an earlier run into the same folder would be stale.
    await fs.rm(assetsDir, { recursive: true, force: true });
    const skip = new Set(cfg.ignore.skipCategories);

    for (const p of pairs) {
      p.diffs = skip.has('page') ? [] : pageDiffs(p, crawlA, crawlB, L);
      p.notes = [];
      if (p.kind === 'compared') {
        p.diffs.push(...compareSnapshots(p.recA.snapshot, p.recB.snapshot, ctx));
        if (p.recA.rendered !== p.recB.rendered) p.notes.push(`Rendered in a browser on ${p.recA.rendered ? L.A : L.B} only (it looked JavaScript-dependent there).`);
        for (const [r, lab] of [[p.recA, L.A], [p.recB, L.B]]) if (r.renderError) p.notes.push(`${lab}: browser rendering failed (${r.renderError}); plain HTML was compared.`);
        if (cfg.visual.enabled && !skip.has('visual') && visualCount < cfg.visual.maxPages) {
          visualCount++;
          log(`Visual compare ${p.path}`);
          p.diffs.push(...(await compareVisual(p, fetcher, cfg, assetsDir, visualCount)));
        }
      }
    }
    if (cfg.visual.enabled) {
      if (fetcher.browserError) notes.push(`WARNING: visual comparison was requested but ${fetcher.browserError}.`);
      else if (pairs.filter((p) => p.kind === 'compared').length > cfg.visual.maxPages) notes.push(`Visual comparison covered the first ${cfg.visual.maxPages} page pairs (visual.maxPages).`);
    }

    const siteWide = consolidateSiteWide(pairs, cfg);
    const sortDiffs = (a, b) => CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category) || SIGNIFICANCE[a.sig].rank - SIGNIFICANCE[b.sig].rank;
    for (const p of pairs) {
      p.diffs.sort(sortDiffs);
      p.worst = p.diffs.reduce((m, d) => Math.min(m, SIGNIFICANCE[d.sig].rank), 99);
      p.identical = p.kind === 'compared' && p.diffs.length === 0 && p.siteWide.length === 0;
    }
    // Most serious first; among equals, whole missing/failed pages before pages with content changes.
    const KIND_ORDER = { 'error': 0, 'only-a': 1, 'only-b': 2, 'compared': 3 };
    pairs.sort((x, y) => x.worst - y.worst || KIND_ORDER[x.kind] - KIND_ORDER[y.kind] || y.diffs.length - x.diffs.length || x.path.localeCompare(y.path));

    const bySig = Object.fromEntries(Object.keys(SIGNIFICANCE).map((s) => [s, 0]));
    for (const p of pairs) for (const d of p.diffs) bySig[d.sig]++;
    for (const d of siteWide) bySig[d.sig]++;
    const compared = pairs.filter((p) => p.kind === 'compared');
    const summary = {
      pagesCompared: compared.length,
      identical: compared.filter((p) => p.identical).length,
      // Same page content; differs only in things listed under "site-wide" (nav, footer ...).
      siteWideOnly: compared.filter((p) => !p.identical && p.diffs.length === 0).length,
      withDifferences: compared.filter((p) => p.diffs.length > 0).length,
      onlyA: pairs.filter((p) => p.kind === 'only-a').length,
      onlyB: pairs.filter((p) => p.kind === 'only-b').length,
      errors: pairs.filter((p) => p.kind === 'error').length,
      totalDifferences: Object.values(bySig).reduce((a, b) => a + b, 0),
      bySignificance: bySig,
      siteWide: siteWide.length,
    };

    const swIdx = new Map(siteWide.map((d, i) => [d.fp, i]));
    const result = {
      generatedAt: started.toISOString(),
      durationSec: Math.round((Date.now() - started.getTime()) / 1000),
      sites: {
        A: { label: L.A, url: scopeA.startUrl, pagesFetched: crawlA.pages.size, skipped: crawlA.skipped },
        B: { label: L.B, url: scopeB.startUrl, pagesFetched: crawlB.pages.size, skipped: crawlB.skipped },
      },
      settings: {
        renderMode, maxPages: cfg.crawl.maxPages, respectRobotsTxt: cfg.http.respectRobotsTxt, delayMs: cfg.http.delayMs,
        visual: cfg.visual.enabled, requests: fetcher.stats.requests, rendered: fetcher.stats.rendered,
      },
      notes,
      summary,
      siteWide,
      pages: pairs.map((p) => ({
        path: p.path, keyA: p.keyA, keyB: p.keyB, kind: p.kind, match: p.match, identical: p.identical,
        urlA: p.recA?.finalUrl ?? null, urlB: p.recB?.finalUrl ?? null,
        statusA: p.recA ? p.recA.status : null, statusB: p.recB ? p.recB.status : null,
        titleA: p.recA?.snapshot?.meta.title.raw ?? null, titleB: p.recB?.snapshot?.meta.title.raw ?? null,
        rendered: { A: !!p.recA?.rendered, B: !!p.recB?.rendered },
        diffs: p.diffs, siteWide: (p.siteWide || []).map((fp) => swIdx.get(fp)), notes: p.notes,
      })),
    };
    const { reportPath, jsonPath } = await writeReport(result, outDir, cfg);
    return { result, reportPath, jsonPath };
  } finally {
    await fetcher.close();
  }
}

