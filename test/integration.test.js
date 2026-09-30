// End-to-end tests: crawl the two bundled demo sites (and some broken servers)
// and check that every planted difference is reported and the noise is not.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { buildConfig } from '../src/config.js';
import { runComparison } from '../src/index.js';
import { startStaticServer } from '../src/demo-server.js';

const demo = (s) => path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'demo', s);
let siteA, siteB, outRoot;
const quiet = () => {};

function config(extra = {}) {
  return buildConfig({ http: { delayMs: 0 }, output: { dir: outRoot, subfolderPerRun: true } }, extra);
}
const page = (r, pathA) => r.pages.find((p) => p.keyA === pathA || (!p.keyA && p.keyB === pathA));
const has = (p, pred) => p.diffs.some(pred);

before(async () => {
  siteA = await startStaticServer(demo('site-a'));
  siteB = await startStaticServer(demo('site-b'));
  outRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sitediff-test-'));
});
after(async () => {
  await siteA.close(); await siteB.close();
  await fs.rm(outRoot, { recursive: true, force: true });
});

test('demo sites: every planted difference is reported, noise is not', async () => {
  const { result: r, reportPath } = await runComparison({ urlA: siteA.url, urlB: siteB.url, cfg: config({ render: { mode: 'never' } }), log: quiet });

  // Page inventory
  assert.equal(page(r, '/careers').kind, 'only-a');
  assert.equal(page(r, '/blog/new-post').kind, 'only-b');
  const about = page(r, '/about-us');
  assert.equal(about.keyB, '/about');                  // renamed, matched by content
  assert.ok(has(about, (d) => d.category === 'page' && /moved/.test(d.title) && /404/.test(d.note)));
  assert.equal(page(r, '/team.html').keyB, '/team');   // URL variant
  const pricing = page(r, '/pricing');
  assert.equal(pricing.keyB, '/plans');                // via 301 redirect
  assert.ok(has(pricing, (d) => d.category === 'page' && /301/.test(d.b)));
  assert.ok(has(pricing, (d) => d.category === 'text' && d.sig === 'changed' && /\$9/.test(d.a) && /\$12/.test(d.b)));

  // Noise-only page
  const faq = page(r, '/faq');
  assert.equal(faq.diffs.length, 0, 'FAQ differs only in noise: ' + JSON.stringify(faq.diffs));

  // Home page details
  const home = page(r, '/');
  assert.ok(has(home, (d) => d.category === 'metadata' && d.sig === 'cosmetic'));                   // title case only
  assert.ok(has(home, (d) => d.category === 'headings' && d.sig === 'structural' && /H2 → H3/.test(d.title)));
  assert.ok(has(home, (d) => d.category === 'headings' && d.sig === 'changed' && /Latest news/.test(d.a)));
  assert.ok(has(home, (d) => d.category === 'text' && d.sig === 'missing' && /Phone support/.test(d.a)));
  assert.ok(has(home, (d) => d.category === 'text' && d.sig === 'added' && /track your delivery/.test(d.b)));
  assert.ok(has(home, (d) => d.category === 'images' && d.sig === 'missing' && /award-2024/.test(d.a)));
  assert.ok(has(home, (d) => d.category === 'images' && d.sig === 'changed'));                     // alt text
  assert.ok(has(home, (d) => d.category === 'cta' && /Request a quote/.test(d.b)));
  assert.ok(!has(home, (d) => d.category === 'images' && /logo/.test(d.a || d.b)), 'hashed logo name is not a difference');

  // Products: price change, removed table, accidental noindex
  const products = page(r, '/products');
  assert.ok(has(products, (d) => d.sig === 'changed' && /\$49\.99/.test(d.a) && /\$59\.99/.test(d.b)));
  assert.ok(has(products, (d) => d.category === 'structure' && /tables/.test(d.title)));
  assert.ok(has(products, (d) => d.category === 'metadata' && /noindex/.test(d.b)));
  assert.ok(!has(products, (d) => d.category === 'links'), 'utm-only link change is ignored');

  // Contact form
  const contact = page(r, '/contact');
  assert.ok(has(contact, (d) => d.category === 'forms' && d.sig === 'missing' && /phone/.test(d.a)));
  assert.ok(has(contact, (d) => d.category === 'forms' && d.sig === 'added' && /company/.test(d.b)));
  assert.ok(has(contact, (d) => d.category === 'forms' && /email.*required/.test(d.title)));
  assert.ok(!has(contact, (d) => d.category === 'text'), 'form labels are not double-reported as text');

  // Date-only change is cosmetic
  assert.ok(has(page(r, '/blog/first-post'), (d) => d.sig === 'cosmetic' && /March 3/.test(d.a)));

  // Nav changes are reported once, site-wide
  const sw = r.siteWide;
  assert.ok(sw.some((d) => d.sig === 'error' && /downloads/.test(d.b)), 'broken nav link');
  assert.ok(sw.some((d) => d.sig === 'missing' && /Careers/.test(d.a)));
  assert.ok(sw.some((d) => /Blog/.test(d.a) && /News/.test(d.b)));
  assert.ok(!r.pages.some((p) => p.diffs.some((d) => d.category === 'links' && /about/.test(d.a || ''))), 'renamed pages do not produce link noise');

  // robots.txt respected
  assert.ok(!r.pages.some((p) => p.keyA === '/private' || p.keyB === '/private'));
  assert.ok(r.notes.some((n) => /robots\.txt/.test(n)));

  // Summary and report file
  assert.equal(r.summary.onlyA, 1);
  assert.equal(r.summary.onlyB, 1);
  assert.equal(r.summary.pagesCompared, 10);
  const html = await fs.readFile(reportPath, 'utf8');
  assert.match(html, /Pages compared/);
  assert.match(html, /Site-wide differences/);
});

test('JavaScript-rendered content is compared when Chromium is available', async (t) => {
  const { chromium } = await import('playwright');
  try { await (await chromium.launch()).close(); } catch { t.skip('Chromium not installed (npx playwright install chromium)'); return; }
  const { result: r } = await runComparison({ urlA: siteA.url, urlB: siteB.url, cfg: config({ crawl: { maxPages: 20 } }), log: quiet });
  const app = page(r, '/app');
  assert.ok(app.rendered.A && app.rendered.B);
  assert.ok(has(app, (d) => d.category === 'text' && /3 sizes/.test(d.a) && /4 sizes/.test(d.b)));
});

test('unreachable site, timeouts and server errors are reported, not fatal', async () => {
  // A small site whose /slow page never answers and whose /boom page fails on B only.
  const mk = (failBoom) => http.createServer((req, res) => {
    if (req.url.startsWith('/slow')) return; // never responds
    if (req.url.startsWith('/boom') && failBoom) { res.writeHead(500); return res.end('oops'); }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<html><head><title>${req.url}</title></head><body><h1>Page ${req.url}</h1><p>Some text for ${req.url}.</p>
      <a href="/slow">slow</a> <a href="/boom">boom</a></body></html>`);
  });
  const s1 = mk(false), s2 = mk(true);
  await Promise.all([s1, s2].map((s) => new Promise((ok) => s.listen(0, '127.0.0.1', ok))));
  const u = (s) => `http://127.0.0.1:${s.address().port}/`;
  try {
    const cfg = config({ http: { timeoutMs: 800, retries: 0, respectRobotsTxt: false }, render: { mode: 'never' } });
    const { result: r } = await runComparison({ urlA: u(s1), urlB: u(s2), cfg, log: quiet });
    const boom = page(r, '/boom');
    assert.equal(boom.kind, 'error');
    assert.ok(has(boom, (d) => d.sig === 'error' && /500/.test(d.b)));
    const slow = page(r, '/slow');
    assert.equal(slow.kind, 'error');
    assert.ok(has(slow, (d) => /Timed out/.test(d.a + d.b)));

    const { result: r2 } = await runComparison({ urlA: u(s1), urlB: 'http://127.0.0.1:1/', cfg, log: quiet });
    assert.ok(r2.notes.some((n) => /could not be reached/.test(n)));
    assert.ok(r2.summary.errors >= 1);
  } finally {
    s1.closeAllConnections(); s2.closeAllConnections();
    s1.close(); s2.close();
  }
});
