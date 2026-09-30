/**
 * Compare two page snapshots and produce a list of differences.
 *
 * A difference ("diff") looks like:
 *   { category, sig, title, a, b, context?, note? }
 *     category  one of CATEGORIES below
 *     sig       significance, one of SIGNIFICANCE below
 *     title     short description ("Text changed", "Link removed", ...)
 *     a / b     what each site has (string, list of strings, or null if absent)
 *     context   where on the page (e.g. the section heading)
 *     note      extra explanation for the reader
 *
 * Site A is treated as the baseline (e.g. the live site), Site B as the
 * candidate, so "missing" means "on A but not on B" and "added" the reverse.
 */
import { diffArrays } from 'diff';
import { similarity, normText } from './normalize.js';
import { isInScope, toKey } from './url-utils.js';

export const SIGNIFICANCE = {
  error: { rank: 0, label: 'Error', help: 'A page or link fails to load' },
  missing: { rank: 1, label: 'Missing', help: 'On A, not on B' },
  changed: { rank: 2, label: 'Changed', help: 'Present on both, with different content' },
  added: { rank: 3, label: 'Added', help: 'On B, not on A' },
  structural: { rank: 4, label: 'Structural', help: 'Same content, different structure, order or URL' },
  cosmetic: { rank: 5, label: 'Cosmetic', help: 'Case, punctuation, dates, formatting or small visual shifts' },
};

export const CATEGORIES = {
  page: 'Page',
  metadata: 'Metadata',
  headings: 'Headings',
  structure: 'Page structure',
  text: 'Text content',
  links: 'Links',
  images: 'Images',
  forms: 'Forms',
  cta: 'Calls to action',
  visual: 'Visual appearance',
};

export function mkDiff(category, sig, title, a, b, extra = {}) {
  const d = { category, sig, title, a: a ?? null, b: b ?? null, ...extra };
  if (!d.fp) d.fp = [category, sig, title, JSON.stringify(extra.fpA ?? a ?? ''), JSON.stringify(extra.fpB ?? b ?? '')].join('\u0001');
  delete d.fpA; delete d.fpB;
  return d;
}

/** Compare two normalised values; returns a diff or null. */
function cmpValue(category, what, va, vb, extra = {}) {
  if (va.norm === vb.norm) return null;
  const fp = { fpA: va.norm, fpB: vb.norm };
  if (!va.norm) return mkDiff(category, 'added', `${what} added`, null, vb.raw, { ...fp, ...extra });
  if (!vb.norm) return mkDiff(category, 'missing', `${what} missing`, va.raw, null, { ...fp, ...extra });
  if (va.cos === vb.cos) return mkDiff(category, 'cosmetic', `${what}: minor difference`, va.raw, vb.raw, { ...fp, ...extra, wordDiff: true });
  return mkDiff(category, 'changed', `${what} changed`, va.raw, vb.raw, { ...fp, ...extra, wordDiff: true });
}

/**
 * Align two ordered lists. Items with identical keys are matched in order
 * (longest common subsequence); what is left is classified as:
 *   moved   - identical item at a different position
 *   pair    - similar items in the same region (shown as "changed")
 *   missing - only in A;  added - only in B
 */
export function align(listA, listB, keyFn, simTextFn, threshold, forcePair = null) {
  // Diff two index lists; returns unmatched items tagged with the region ("hunk") they fall in.
  const hunksOf = (idxA, idxB) => {
    const parts = diffArrays(idxA.map((i) => keyFn(listA[i])), idxB.map((i) => keyFn(listB[i])));
    const removed = [], added = [];
    let pa = 0, pb = 0, hunk = 0, inHunk = false;
    for (const p of parts) {
      const n = p.value.length;
      if (!p.added && !p.removed) { pa += n; pb += n; if (inHunk) { hunk++; inHunk = false; } continue; }
      inHunk = true;
      for (let k = 0; k < n; k++) {
        if (p.removed) { const i = idxA[pa++]; removed.push({ item: listA[i], i, hunk }); }
        else { const i = idxB[pb++]; added.push({ item: listB[i], i, hunk }); }
      }
    }
    return { removed, added };
  };
  const ops = [];
  // Pass 1: identical items at a different position = moved.
  const first = hunksOf(listA.map((_, i) => i), listB.map((_, i) => i));
  const byKey = new Map();
  for (const d of first.added) { const k = keyFn(d.item); if (!byKey.has(k)) byKey.set(k, []); byKey.get(k).push(d); }
  const movedA = new Set(), movedB = new Set();
  for (const r of first.removed) {
    const cand = byKey.get(keyFn(r.item));
    if (cand?.length) {
      const d = cand.shift();
      movedA.add(r.i); movedB.add(d.i);
      ops.push({ type: 'moved', a: r.item, b: d.item, ia: r.i, ib: d.i, hunk: Number.MAX_SAFE_INTEGER });
    }
  }
  // Pass 2: diff again without the moved items, so a move does not split the
  // surrounding changes into separate regions.
  const { removed, added } = movedA.size
    ? hunksOf(listA.map((_, i) => i).filter((i) => !movedA.has(i)), listB.map((_, i) => i).filter((i) => !movedB.has(i)))
    : first;
  // Similar items inside the same region = changed.
  const hunks = new Set([...removed, ...added].map((x) => x.hunk));
  for (const h of hunks) {
    const R = removed.filter((r) => r.hunk === h && !r.used);
    const D = added.filter((d) => d.hunk === h && !d.used);
    const cands = [];
    for (const r of R) for (const d of D) {
      const s = similarity(simTextFn(r.item), simTextFn(d.item));
      if (s >= threshold) cands.push({ r, d, s });
    }
    cands.sort((x, y) => y.s - x.s);
    for (const { r, d, s } of cands) {
      if (r.used || d.used) continue;
      r.used = d.used = true;
      ops.push({ type: 'pair', a: r.item, b: d.item, ia: r.i, ib: d.i, hunk: h, sim: s });
    }
    // Exactly one item replaced by exactly one other in the same spot: optionally treat as a change.
    const r1 = R.filter((r) => !r.used), d1 = D.filter((d) => !d.used);
    if (forcePair && r1.length === 1 && d1.length === 1 && forcePair(r1[0].item, d1[0].item)) {
      r1[0].used = d1[0].used = true;
      ops.push({ type: 'pair', a: r1[0].item, b: d1[0].item, ia: r1[0].i, ib: d1[0].i, hunk: h, sim: 0 });
    }
  }
  // Clearly similar items in neighbouring regions (split apart by a moved block) = changed too.
  const cross = [];
  for (const r of removed) if (!r.used) for (const d of added) {
    if (d.used || Math.abs(r.hunk - d.hunk) !== 1) continue;
    const s = similarity(simTextFn(r.item), simTextFn(d.item));
    if (s >= Math.max(threshold, 0.6)) cross.push({ r, d, s });
  }
  cross.sort((x, y) => y.s - x.s);
  for (const { r, d, s } of cross) {
    if (r.used || d.used) continue;
    r.used = d.used = true;
    ops.push({ type: 'pair', a: r.item, b: d.item, ia: r.i, ib: d.i, hunk: Math.min(r.hunk, d.hunk), sim: s });
  }
  for (const r of removed) if (!r.used) ops.push({ type: 'missing', a: r.item, ia: r.i, hunk: r.hunk });
  for (const d of added) if (!d.used) ops.push({ type: 'added', b: d.item, ib: d.i, hunk: d.hunk });
  const pos = (o) => o.ia ?? listA.length + (o.ib ?? 0);
  ops.sort((x, y) => x.hunk - y.hunk || pos(x) - pos(y));
  return ops;
}

// ------------------------------------------------------------- categories --

function compareMeta(A, B, ctx) {
  const out = [];
  const m1 = { ...A.meta, canonical: A.meta.canonical && ctx.mapAtoB(A.meta.canonical) }, m2 = B.meta;
  out.push(cmpValue('metadata', 'Page title', m1.title, m2.title));
  out.push(cmpValue('metadata', 'Meta description', m1.description, m2.description));
  out.push(cmpValue('metadata', 'Social title (og:title)', m1.ogTitle, m2.ogTitle));
  out.push(cmpValue('metadata', 'Social description (og:description)', m1.ogDescription, m2.ogDescription));
  if (m1.ogImage !== m2.ogImage) out.push(mkDiff('metadata', m1.ogImage && m2.ogImage ? 'changed' : m2.ogImage ? 'added' : 'missing', 'Social image (og:image)', m1.ogImage || null, m2.ogImage || null));
  if (m1.canonical !== m2.canonical) {
    const offSite = m2.canonical.startsWith('//');
    out.push(mkDiff('metadata', !m2.canonical ? 'missing' : !m1.canonical ? 'added' : 'changed', 'Canonical URL', m1.canonical || null, m2.canonical || null,
      offSite && !m1.canonical.startsWith('//') ? { note: 'B\'s canonical points to a different domain; search engines will treat that URL as the real page.' } : {}));
  }
  if (m1.robots !== m2.robots) {
    const noindexB = /noindex/.test(m2.robots) && !/noindex/.test(m1.robots);
    const noindexA = /noindex/.test(m1.robots) && !/noindex/.test(m2.robots);
    out.push(mkDiff('metadata', 'changed', 'Robots meta tag', m1.robots || '(none)', m2.robots || '(none)', {
      note: noindexB ? 'B tells search engines NOT to index this page (noindex).' : noindexA ? 'A was noindex; B allows indexing.' : undefined,
    }));
  }
  if (m1.lang !== m2.lang) out.push(mkDiff('metadata', 'changed', 'Page language (html lang)', m1.lang || '(none)', m2.lang || '(none)'));
  return out;
}

function compareHeadings(A, B, cfg) {
  const out = [];
  const show = (h) => `H${h.level} · ${h.text.raw}`;
  // A heading replaced one-for-one at the same level ("Blog" -> "News") is shown as a change.
  const ops = align(A.headings, B.headings, (h) => `${h.level}|${h.text.norm}`, (h) => h.text.cos,
    cfg.compare.textSimilarityForChange, (a, b) => a.level === b.level);
  for (const o of ops) {
    if (o.type === 'moved') out.push(mkDiff('headings', 'structural', 'Heading moved to a different position', show(o.a), show(o.b)));
    else if (o.type === 'missing') out.push(mkDiff('headings', 'missing', 'Heading missing', show(o.a), null, { fpA: `${o.a.level}|${o.a.text.norm}` }));
    else if (o.type === 'added') out.push(mkDiff('headings', 'added', 'Heading added', null, show(o.b), { fpB: `${o.b.level}|${o.b.text.norm}` }));
    else {
      const sameText = o.a.text.norm === o.b.text.norm;
      const levelNote = o.a.level !== o.b.level ? ` (H${o.a.level} → H${o.b.level})` : '';
      if (sameText) out.push(mkDiff('headings', 'structural', `Heading level changed${levelNote}`, show(o.a), show(o.b)));
      else if (o.a.text.cos === o.b.text.cos && !levelNote) out.push(mkDiff('headings', 'cosmetic', 'Heading: minor difference', show(o.a), show(o.b), { wordDiff: true }));
      else out.push(mkDiff('headings', 'changed', `Heading changed${levelNote}`, show(o.a), show(o.b), { wordDiff: true, fpA: o.a.text.norm, fpB: o.b.text.norm }));
    }
  }
  return out;
}

function compareStructure(A, B) {
  const out = [];
  for (const [k, n] of Object.entries(A.structure)) {
    const m = B.structure[k] ?? 0;
    if (n !== m) out.push(mkDiff('structure', 'structural', `Number of ${k} differs`, String(n), String(m)));
  }
  return out;
}

function compareText(A, B, cfg) {
  const out = [];
  const ops = align(A.blocks, B.blocks, (b) => b.norm, (b) => b.cos, cfg.compare.textSimilarityForChange);
  const ctx = (blk) => (blk?.section ? `Section: “${blk.section}”` : 'Top of page');
  const moved = ops.filter((o) => o.type === 'moved');
  const byHunk = new Map();
  for (const o of ops) if (o.type !== 'moved') { if (!byHunk.has(o.hunk)) byHunk.set(o.hunk, []); byHunk.get(o.hunk).push(o); }
  for (const hunkOps of byHunk.values()) {
    for (const o of hunkOps.filter((x) => x.type === 'pair')) {
      if (o.a.cos === o.b.cos) out.push(mkDiff('text', 'cosmetic', 'Text: minor difference (case, punctuation, dates or times)', o.a.raw, o.b.raw, { wordDiff: true, context: ctx(o.b), fpA: o.a.norm, fpB: o.b.norm }));
      else out.push(mkDiff('text', 'changed', 'Text changed', o.a.raw, o.b.raw, { wordDiff: true, context: ctx(o.b), fpA: o.a.norm, fpB: o.b.norm }));
    }
    // Consecutive blocks that vanished (or appeared) together are shown as one difference.
    const miss = hunkOps.filter((x) => x.type === 'missing');
    if (miss.length) out.push(mkDiff('text', 'missing', miss.length > 1 ? `${miss.length} text blocks missing` : 'Text missing',
      miss.map((o) => o.a.raw), null, { context: ctx(miss[0].a), fpA: miss.map((o) => o.a.norm) }));
    const add = hunkOps.filter((x) => x.type === 'added');
    if (add.length) out.push(mkDiff('text', 'added', add.length > 1 ? `${add.length} text blocks added` : 'Text added',
      null, add.map((o) => o.b.raw), { context: ctx(add[0].b), fpB: add.map((o) => o.b.norm) }));
  }
  if (moved.length) {
    out.push(mkDiff('text', 'structural', moved.length > 1 ? `${moved.length} text blocks appear in a different order` : 'Text block appears in a different position',
      moved.map((o) => `#${o.ia + 1}: ${o.a.raw}`), moved.map((o) => `#${o.ib + 1}: ${o.b.raw}`),
      { note: 'Same text on both sites, at a different position in the page (numbers are block positions).', fpA: moved.map((o) => o.a.norm), fpB: '' }));
  }
  return out;
}

const showTarget = (k) => (k.startsWith('//') ? 'https:' + k : k);
const quote = (t) => (t ? `“${t}”` : '(no text)');

function groupBy(list, keyFn) {
  const m = new Map();
  for (const x of list) { const k = keyFn(x); if (!m.has(k)) m.set(k, []); m.get(k).push(x); }
  return m;
}
const uniqSorted = (arr) => [...new Set(arr)].sort();

function isBroken(st) {
  return st && !st.robots && ((st.status >= 400) || (st.error && !/^Not an HTML page/.test(st.error)));
}
const describeStatus = (st) => (st.error ? st.error : `HTTP ${st.status}`);

function compareLinks(A, B, ctx) {
  const { cfg } = ctx;
  const out = [];
  // A's internal targets are translated through the page pairing (A /about-us == B /about),
  // so a renamed page is reported once as a page move, not as a changed link on every page.
  // Button-styled links are left to the "calls to action" comparison (but still checked for breakage).
  const allA = groupBy(A.links.map((l) => ({ ...l, origKey: l.key, key: ctx.mapAtoB(l.key) })), (l) => l.key);
  const allB = groupBy(B.links, (l) => l.key);
  const plain = (m) => new Map([...m].map(([k, ls]) => [k, ls.filter((l) => !l.cta)]).filter(([, ls]) => ls.length));
  const la = plain(allA), lb = plain(allB);
  const texts = (ls) => uniqSorted(ls.map((l) => l.text.raw).filter(Boolean));
  const fmt = (ls, key) => `${texts(ls).map(quote).join(' / ') || '(no text)'} → ${showTarget(ls[0].origKey ?? key)}`;

  // B linking to A's domain (a common migration mistake: hard-coded absolute links).
  const pairedOnA = new Set();
  for (const [kb, ls] of lb) {
    if (la.has(kb) || !kb.startsWith('//')) continue;
    const u = new URL('https:' + kb);
    if (!isInScope(u, ctx.scopeA, cfg)) continue;
    const ka = ctx.mapAtoB(toKey(u, ctx.scopeA, cfg));
    if (la.has(ka) && !lb.has(ka)) {
      pairedOnA.add(ka); lb.delete(kb);
      out.push(mkDiff('links', 'changed', 'Link now points to the other site\'s domain', fmt(la.get(ka), ka), fmt(ls, kb), {
        note: `B links to ${ctx.labelA}'s domain instead of its own page ${ka}.`, fpA: ka, fpB: kb,
      }));
    }
  }
  for (const [k, ls] of la) {
    if (pairedOnA.has(k)) continue;
    if (!lb.has(k)) { out.push(mkDiff('links', 'missing', 'Link missing', fmt(ls, k), null, { fpA: k })); continue; }
    const ta = uniqSorted(ls.map((l) => l.text.norm)), tb = uniqSorted(lb.get(k).map((l) => l.text.norm));
    if (ta.join('\n') === tb.join('\n')) continue;
    const ca = uniqSorted(ls.map((l) => l.text.cos)).join('\n'), cb = uniqSorted(lb.get(k).map((l) => l.text.cos)).join('\n');
    out.push(mkDiff('links', ca === cb ? 'cosmetic' : 'changed', ca === cb ? 'Link text: minor difference' : 'Link text changed',
      fmt(ls, k), fmt(lb.get(k), k), { wordDiff: true, fpA: ta, fpB: tb }));
  }
  for (const [k, ls] of lb) if (!la.has(k)) out.push(mkDiff('links', 'added', 'Link added', null, fmt(ls, k), { fpB: k }));

  // Internal links whose target is broken on one site only.
  const internal = (m) => [...m.keys()].filter((k) => k.startsWith('/') && !k.startsWith('//'));
  for (const k of internal(allB)) {
    const sb = ctx.statusB(k);
    if (!isBroken(sb)) continue;
    const ka = allA.get(k)?.[0].origKey;
    const sa = ka ? ctx.statusA(ka) : null;
    if (isBroken(sa)) continue; // broken on both: not a difference
    out.push(mkDiff('links', 'error', 'Broken link', ka ? `${ka} → ${sa ? describeStatus(sa) : 'works'}` : '(not linked)', `${k} → ${describeStatus(sb)}`, { fpA: '', fpB: k }));
  }
  for (const k of internal(allA)) {
    const sa = ctx.statusA(allA.get(k)[0].origKey);
    if (!isBroken(sa) || !allB.has(k)) continue;
    const sb = ctx.statusB(k);
    if (sb && !isBroken(sb)) out.push(mkDiff('links', 'cosmetic', 'Link broken on A works on B', `${k} → ${describeStatus(sa)}`, `${k} → HTTP ${sb.status}`, { fpA: k, fpB: '' }));
  }
  return out;
}

function compareImages(A, B) {
  const out = [];
  const ia = groupBy(A.images, (i) => i.key), ib = groupBy(B.images, (i) => i.key);
  const alts = (is) => uniqSorted(is.map((i) => i.alt.raw));
  const fmt = (k, is) => `${k} — alt: ${alts(is).map((a) => (a ? `“${a}”` : '(empty)')).join(' / ')}`;
  for (const [k, is] of ia) {
    if (!ib.has(k)) { out.push(mkDiff('images', 'missing', 'Image missing', fmt(k, is), null, { fpA: k })); continue; }
    const js = ib.get(k);
    const na = uniqSorted(is.map((i) => i.alt.norm)).join('\n'), nb = uniqSorted(js.map((i) => i.alt.norm)).join('\n');
    if (na === nb) continue;
    const ca = uniqSorted(is.map((i) => i.alt.cos)).join('\n'), cb = uniqSorted(js.map((i) => i.alt.cos)).join('\n');
    const lostAlt = na && !nb;
    out.push(mkDiff('images', lostAlt ? 'missing' : ca === cb ? 'cosmetic' : 'changed',
      lostAlt ? 'Image alt text missing' : ca === cb ? 'Image alt text: minor difference' : 'Image alt text changed',
      fmt(k, is), fmt(k, js), { wordDiff: true, note: lostAlt ? 'Screen-reader users and search engines lose this description.' : undefined }));
  }
  for (const [k, js] of ib) if (!ia.has(k)) out.push(mkDiff('images', 'added', 'Image added', null, fmt(k, js), { fpB: k }));
  return out;
}

function compareForms(A, B, cfg) {
  const out = [];
  const fname = (f) => normText(f.name, cfg).toLowerCase();
  const describe = (f) => [`Submits to ${showTarget(f.action)} (${f.method.toUpperCase()})`,
    ...f.fields.map((x) => `${x.label || x.name} [${x.type}${x.required ? ', required' : ''}]`),
    `Button: ${quote(f.submit.raw)}`];
  const used = new Set();
  const pairs = [];
  const unmatchedA = [];
  for (const fa of A.forms) {
    let fb = B.forms.find((f) => !used.has(f) && f.action === fa.action);
    if (!fb) {
      const na = new Set(fa.fields.map(fname));
      let best = 0;
      for (const f of B.forms) {
        if (used.has(f)) continue;
        const nb = new Set(f.fields.map(fname));
        const inter = [...na].filter((x) => nb.has(x)).length;
        const j = inter / (new Set([...na, ...nb]).size || 1);
        if (j > best && j >= 0.5) { best = j; fb = f; }
      }
    }
    if (fb) { used.add(fb); pairs.push([fa, fb]); } else unmatchedA.push(fa);
  }
  for (const fa of unmatchedA) out.push(mkDiff('forms', 'missing', 'Form missing', describe(fa), null));
  for (const fb of B.forms) if (!used.has(fb)) out.push(mkDiff('forms', 'added', 'Form added', null, describe(fb)));
  for (const [fa, fb] of pairs) {
    const where = `Form submitting to ${showTarget(fb.action)}`;
    if (fa.action !== fb.action) out.push(mkDiff('forms', 'changed', 'Form submits to a different URL', showTarget(fa.action), showTarget(fb.action), { context: where }));
    if (fa.method !== fb.method) out.push(mkDiff('forms', 'changed', 'Form method changed', fa.method.toUpperCase(), fb.method.toUpperCase(), { context: where }));
    const ma = new Map(fa.fields.map((f) => [fname(f), f])), mb = new Map(fb.fields.map((f) => [fname(f), f]));
    const showF = (f) => `${f.label || f.name} (name: ${f.name}, ${f.type}${f.required ? ', required' : ''})`;
    for (const [n, f] of ma) {
      const g = mb.get(n);
      if (!g) { out.push(mkDiff('forms', 'missing', 'Form field missing', showF(f), null, { context: where })); continue; }
      if (f.type !== g.type) out.push(mkDiff('forms', 'changed', `Field “${f.name}” type changed`, f.type, g.type, { context: where }));
      if (f.required !== g.required) out.push(mkDiff('forms', 'changed', `Field “${f.name}” is now ${g.required ? 'required' : 'optional'}`, f.required ? 'required' : 'optional', g.required ? 'required' : 'optional', { context: where }));
      if (f.label !== g.label) {
        const d = cmpValue('forms', `Field “${f.name}” label`, { raw: f.label, norm: normText(f.label, cfg), cos: normText(f.label, cfg).toLowerCase().replace(/[^\p{L}\p{N}]/gu, '') },
          { raw: g.label, norm: normText(g.label, cfg), cos: normText(g.label, cfg).toLowerCase().replace(/[^\p{L}\p{N}]/gu, '') }, { context: where });
        if (d) out.push(d);
      }
    }
    for (const [n, g] of mb) if (!ma.has(n)) out.push(mkDiff('forms', 'added', 'Form field added', null, showF(g), { context: where }));
    const d = cmpValue('forms', 'Submit button text', fa.submit, fb.submit, { context: where });
    if (d) out.push(d);
  }
  return out;
}

function compareCtas(A, B, ctx) {
  const out = [];
  const fmt = (c) => `${quote(c.text.raw)} → ${showTarget(c.shown ?? c.target)}`;
  const ua = A.ctas.map((c) => ({ c: { ...c, shown: c.target, target: ctx.mapAtoB(c.target) } })), ub = B.ctas.map((c) => ({ c }));
  // 1) same text: compare targets
  for (const x of ua) {
    const y = ub.find((y) => !y.used && y.c.text.norm === x.c.text.norm);
    if (!y) continue;
    x.used = y.used = true;
    if (x.c.target !== y.c.target) out.push(mkDiff('cta', 'changed', 'Call to action goes somewhere else', fmt(x.c), fmt(y.c), { wordDiff: true }));
  }
  // 2) same (real) target, different text
  for (const x of ua.filter((x) => !x.used && x.c.target !== '(button)')) {
    const y = ub.find((y) => !y.used && y.c.target === x.c.target);
    if (!y) continue;
    x.used = y.used = true;
    const cos = x.c.text.cos === y.c.text.cos;
    out.push(mkDiff('cta', cos ? 'cosmetic' : 'changed', cos ? 'Call to action text: minor difference' : 'Call to action text changed', fmt(x.c), fmt(y.c), { wordDiff: true }));
  }
  for (const x of ua) if (!x.used) out.push(mkDiff('cta', 'missing', 'Call to action missing', fmt(x.c), null));
  for (const y of ub) if (!y.used) out.push(mkDiff('cta', 'added', 'Call to action added', null, fmt(y.c)));
  return out;
}

/**
 * All content differences between two snapshots.
 * ctx: { cfg, scopeA, scopeB, labelA, labelB, statusA(key), statusB(key), mapAtoB(key) }
 */
export function compareSnapshots(A, B, ctx) {
  const { cfg } = ctx;
  const skip = new Set(cfg.ignore.skipCategories);
  const run = (cat, fn) => (skip.has(cat) ? [] : fn());
  return [
    ...run('metadata', () => compareMeta(A, B, ctx)),
    ...run('headings', () => compareHeadings(A, B, cfg)),
    ...run('structure', () => compareStructure(A, B)),
    ...run('text', () => compareText(A, B, cfg)),
    ...run('links', () => compareLinks(A, B, ctx)),
    ...run('images', () => compareImages(A, B)),
    ...run('forms', () => compareForms({ ...A, forms: A.forms.map((f) => ({ ...f, action: ctx.mapAtoB(f.action) })) }, B, cfg)),
    ...run('cta', () => compareCtas(A, B, ctx)),
  ].filter(Boolean);
}

/**
 * Move differences that repeat across many pages (nav, header, footer changes)
 * into one "site-wide" list, so they are reported once instead of on every page.
 */
export function consolidateSiteWide(pairs, cfg) {
  const compared = pairs.filter((p) => p.kind === 'compared');
  const { minPages, minFraction } = cfg.compare.siteWide;
  const counts = new Map();
  for (const p of compared) {
    for (const fp of new Set(p.diffs.filter((d) => !['page', 'visual'].includes(d.category)).map((d) => d.fp))) {
      counts.set(fp, (counts.get(fp) || 0) + 1);
    }
  }
  const threshold = Math.max(minPages, Math.ceil(minFraction * compared.length));
  const siteWide = new Map();
  for (const p of compared) {
    p.siteWide = [];
    p.diffs = p.diffs.filter((d) => {
      if ((counts.get(d.fp) || 0) < threshold || ['page', 'visual'].includes(d.category)) return true;
      if (!siteWide.has(d.fp)) siteWide.set(d.fp, { ...d, pages: [] });
      const sw = siteWide.get(d.fp);
      if (!sw.pages.includes(p.path)) sw.pages.push(p.path);
      if (!p.siteWide.includes(d.fp)) p.siteWide.push(d.fp);
      return false;
    });
  }
  return [...siteWide.values()].sort((x, y) => SIGNIFICANCE[x.sig].rank - SIGNIFICANCE[y.sig].rank || y.pages.length - x.pages.length);
}
