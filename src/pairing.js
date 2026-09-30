/**
 * Pair the pages of two crawls.
 *
 * Order of matching (each page is used at most once):
 *   1. same path on both sites
 *   2. same path, but one site redirects it to another page     -> "URL changed (redirect)"
 *   3. path differs only cosmetically (/Team.html vs /team)      -> "URL changed"
 *   4. different path, very similar content                      -> "page moved / renamed"
 *   5. whatever is left exists on one site only                  -> "missing" / "added"
 *
 * Before matching, every path seen on one site only is requested directly on
 * the other site ("probed"), so a page that simply was not linked, or that the
 * crawl limit cut off, is not wrongly reported as missing.
 */
import { looseKey } from './url-utils.js';

/** Classify a PageRecord: ok | missing | error. */
export function pageState(rec) {
  if (!rec) return 'none';
  if (rec.status === 404 || rec.status === 410) return 'missing';
  if (rec.error || !rec.status || rec.status >= 400 || !rec.snapshot) return 'error';
  return 'ok';
}

function shingles(text, n = 3) {
  const w = text.toLowerCase().split(/\s+/).filter(Boolean).slice(0, 4000);
  const s = new Set();
  for (let i = 0; i + n <= w.length; i++) s.add(w.slice(i, i + n).join(' '));
  if (!s.size && w.length) s.add(w.join(' '));
  return s;
}
function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}
/** Content similarity of two pages, 0..1 (word shingles; identical titles give a small boost). */
export function pageSimilarity(ra, rb) {
  const sa = ra.snapshot, sb = rb.snapshot;
  let s = jaccard(shingles(sa.fullText), shingles(sb.fullText));
  if (sa.meta.title.norm && sa.meta.title.norm === sb.meta.title.norm) s = Math.min(1, s + 0.15);
  return s;
}

export async function pairPages(crawlA, crawlB, cfg, log) {
  // Candidate paths: anything either crawl reached that is not a plain 404
  // (404s reached through broken links are reported as broken links instead).
  const keys = new Set();
  for (const c of [crawlA, crawlB]) for (const [k, rec] of c.pages) if (pageState(rec) !== 'missing') keys.add(k);

  // Probe the other site for paths it has not seen.
  let probed = 0;
  for (const k of [...keys].sort()) {
    for (const c of [crawlA, crawlB]) {
      if (!c.pages.has(k) && !c.aliases.has(k) && !c.robotsBlocked.has(k)) { await c.probe(k); probed++; }
    }
  }
  if (probed) log(`Checked ${probed} path(s) directly on the other site`);

  const usedA = new Set(), usedB = new Set();
  const pairs = [];
  const add = (p) => { pairs.push(p); if (p.keyA) usedA.add(p.keyA); if (p.keyB) usedB.add(p.keyB); };
  const direct = (c, k) => c.pages.get(k);
  const sorted = [...keys].sort();

  // 1. Same path.
  for (const k of sorted) {
    const a = direct(crawlA, k), b = direct(crawlB, k);
    if (!a || !b || usedA.has(k) || usedB.has(k)) continue;
    const sa = pageState(a), sb = pageState(b);
    if (sa === 'missing' || sb === 'missing') continue;
    add({ path: k, keyA: k, keyB: k, recA: a, recB: b, match: 'same-path' });
  }

  // 2. Redirects: A's path redirects on B (or vice versa) to an unmatched page.
  for (const k of sorted) {
    if (!usedA.has(k) && pageState(direct(crawlA, k)) === 'ok' && crawlB.aliases.has(k)) {
      const t = crawlB.aliases.get(k);
      if (!usedB.has(t) && pageState(direct(crawlB, t)) === 'ok') {
        const rec = direct(crawlB, t);
        add({ path: k, keyA: k, keyB: t, recA: direct(crawlA, k), recB: rec, match: 'redirect', redirectOn: 'B' });
      }
    }
    if (!usedB.has(k) && pageState(direct(crawlB, k)) === 'ok' && crawlA.aliases.has(k)) {
      const t = crawlA.aliases.get(k);
      if (!usedA.has(t) && pageState(direct(crawlA, t)) === 'ok') {
        add({ path: t, keyA: t, keyB: k, recA: direct(crawlA, t), recB: direct(crawlB, k), match: 'redirect', redirectOn: 'A' });
      }
    }
  }

  const leftovers = (c, used) => [...c.pages.entries()].filter(([k, r]) => !used.has(k) && pageState(r) === 'ok');

  // 3. Cosmetic URL differences.
  const looseB = new Map();
  for (const [k] of leftovers(crawlB, usedB)) { const lk = looseKey(k); if (!looseB.has(lk)) looseB.set(lk, k); }
  for (const [k, r] of leftovers(crawlA, usedA)) {
    const kb = looseB.get(looseKey(k));
    if (kb && !usedB.has(kb)) add({ path: k, keyA: k, keyB: kb, recA: r, recB: direct(crawlB, kb), match: 'url-variant' });
  }

  // 4. Similar content under a different path.
  const onlyA = leftovers(crawlA, usedA), onlyB = leftovers(crawlB, usedB);
  const cands = [];
  for (const [ka, ra] of onlyA) for (const [kb, rb] of onlyB) {
    const s = pageSimilarity(ra, rb);
    if (s >= cfg.compare.renameSimilarity) cands.push({ ka, kb, ra, rb, s });
  }
  cands.sort((x, y) => y.s - x.s);
  for (const c of cands) {
    if (usedA.has(c.ka) || usedB.has(c.kb)) continue;
    add({ path: c.ka, keyA: c.ka, keyB: c.kb, recA: c.ra, recB: c.rb, match: 'moved', similarity: c.s });
  }

  // 5. One site only, or failed to load.
  const describeOther = (c, k) => {
    if (c.robotsBlocked.has(k)) return { state: 'robots', text: 'not checked: disallowed by robots.txt' };
    const alias = c.aliases.get(k);
    const rec = c.pages.get(alias ?? k);
    if (!rec) return { state: 'unknown', text: c.unreachable ? `not checked: site unreachable (${c.unreachable})` : 'not checked (crawl.maxProbes limit reached)' };
    if (alias) return { state: 'redirect', text: `redirects to ${alias}${usedOf(c).has(alias) ? ' (a page matched to a different page on the other site)' : ''}`, rec };
    const st = pageState(rec);
    return { state: st, text: st === 'missing' ? `returns HTTP ${rec.status}` : rec.error || `returns HTTP ${rec.status}`, rec };
  };
  const usedOf = (c) => (c === crawlA ? usedA : usedB);

  for (const k of sorted) {
    const a = direct(crawlA, k), b = direct(crawlB, k);
    const sa = pageState(a), sb = pageState(b);
    const freeA = a && !usedA.has(k), freeB = b && !usedB.has(k);
    if (freeA && (sa === 'ok' || sa === 'error') && !(freeB && (sb === 'ok' || sb === 'error'))) {
      add({ path: k, keyA: k, keyB: null, recA: a, recB: null, match: 'none', other: describeOther(crawlB, k) });
    } else if (freeB && (sb === 'ok' || sb === 'error') && !(freeA && (sa === 'ok' || sa === 'error'))) {
      add({ path: k, keyA: null, keyB: k, recA: null, recB: b, match: 'none', other: describeOther(crawlA, k) });
    }
  }

  for (const p of pairs) {
    const sa = pageState(p.recA), sb = pageState(p.recB);
    p.kind = !p.recA ? 'only-b' : !p.recB ? 'only-a' : sa === 'ok' && sb === 'ok' ? 'compared' : 'error';
    // A page that exists on one side but errors on the other still gets its own status.
    if (p.kind === 'only-a' && sa === 'error') p.kind = 'error';
    if (p.kind === 'only-b' && sb === 'error') p.kind = 'error';
  }
  return pairs;
}
