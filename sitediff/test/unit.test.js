// Unit tests for URL keys, ignore rules and the text alignment.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildConfig } from '../src/config.js';
import { createScope, toKey, looseKey, normalizeExternalUrl, isExcludedPath } from '../src/url-utils.js';
import { value } from '../src/normalize.js';
import { align } from '../src/compare.js';
import { extractSnapshot, looksJsRendered } from '../src/extract.js';

const cfg = buildConfig();

test('page keys normalise trailing slashes, index files, queries and base paths', () => {
  const s = createScope('https://www.example.com/', cfg);
  assert.equal(toKey('https://example.com/about/', s, cfg), '/about');
  assert.equal(toKey('https://www.example.com/about/index.html?utm_source=x#top', s, cfg), '/about');
  assert.equal(toKey('https://www.example.com/', s, cfg), '/');
  const staging = createScope('https://staging.example.com/v2/', cfg);
  assert.equal(toKey('https://staging.example.com/v2/about/', staging, cfg), '/about');
  assert.equal(looseKey('/Team.html'), '/team');
});

test('tracking parameters are ignored in external links', () => {
  assert.equal(
    normalizeExternalUrl('https://partner.example.com/buy?utm_source=a&id=7&fbclid=zz', cfg),
    normalizeExternalUrl('http://www.partner.example.com/buy/?id=7&utm_campaign=b', cfg),
  );
});

test('crawl exclusions match whole path segments', () => {
  assert.equal(isExcludedPath('/cart', cfg), true);
  assert.equal(isExcludedPath('/cart/items', cfg), true);
  assert.equal(isExcludedPath('/cartoons', cfg), false);
});

test('ignore rules: timestamps, UUIDs and whitespace do not count; plain dates are cosmetic', () => {
  const same = (x, y) => value(x, cfg).norm === value(y, cfg).norm;
  const cosmetic = (x, y) => !same(x, y) && value(x, cfg).cos === value(y, cfg).cos;
  assert.ok(same('Generated at 2026-09-29 10:31:02', 'Generated  at\n2026-09-30 08:02:44'));
  assert.ok(same('Updated 3 hours ago', 'Updated 5 minutes ago'));
  assert.ok(same('Session 3f2504e0-4f89-11d3-9a0c-0305e82c3301', 'Session 9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d'));
  assert.ok(same('© 2025 Acme', '© 2026 Acme'));
  assert.ok(cosmetic('Posted March 3, 2026', 'Posted March 4, 2026'));
  assert.ok(cosmetic('Contact Us!', 'Contact us'));
  assert.ok(!same('Price: $49.99', 'Price: $59.99') && !cosmetic('Price: $49.99', 'Price: $59.99'));
});

test('align() classifies changed, missing, added and moved blocks', () => {
  const v = (s) => value(s, cfg);
  const A = ['Intro text here', 'Price is $10 per month', 'Old paragraph gone', 'Footer note'].map(v);
  const B = ['Footer note', 'Intro text here', 'Price is $12 per month', 'Brand new paragraph about widgets'].map(v);
  const ops = align(A, B, (x) => x.norm, (x) => x.cos, 0.45);
  const types = ops.map((o) => o.type).sort();
  assert.deepEqual(types, ['added', 'missing', 'moved', 'pair']);
  assert.equal(ops.find((o) => o.type === 'pair').b.raw, 'Price is $12 per month');
});

test('extraction ignores scripts, hidden elements and IDs; finds forms and CTAs', () => {
  const s = createScope('https://a.test/', cfg);
  const html = `<html><head><title>T</title><script>var x=1</script></head><body>
    <div id="x-123"><p>Hello   world</p><p style="display:none">secret</p></div>
    <a class="btn" href="/signup">Sign up</a>
    <form action="/api/f" method="post"><input type="hidden" name="csrf" value="abc">
      <label for="e">Email</label><input id="e" name="email" type="email" required><button>Go</button></form></body></html>`;
  const snap = extractSnapshot(html, 'https://a.test/', s, cfg);
  assert.deepEqual(snap.blocks.map((b) => b.raw), ['Hello world']);
  assert.equal(snap.ctas[0].text.raw, 'Sign up');
  assert.equal(snap.forms[0].fields.length, 1);
  assert.deepEqual(snap.forms[0].fields[0], { name: 'email', type: 'email', required: true, label: 'Email' });
});

test('JavaScript-rendered pages are detected', () => {
  assert.equal(looksJsRendered('<html><body><div id="root"></div><script src="app.js"></script></body></html>', cfg), true);
  assert.equal(looksJsRendered(`<html><body><p>${'Real content. '.repeat(40)}</p><script></script></body></html>`, cfg), false);
});
