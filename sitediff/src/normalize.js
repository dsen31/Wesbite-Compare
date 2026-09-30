/**
 * Text normalisation and "ignore rule" masking.
 *
 * Every compared value keeps its raw form (shown in the report) and gets two
 * normalised forms:
 *   norm     - whitespace collapsed, 'ignore' patterns masked. Used to decide
 *              whether two values differ at all.
 *   cosmetic - additionally masks 'cosmetic' patterns, lower-cases and drops
 *              punctuation. If two values differ in `norm` but match here, the
 *              difference is reported as cosmetic.
 */

const cache = new WeakMap();

function compiled(cfg) {
  let c = cache.get(cfg);
  if (!c) {
    const toRe = (p) => new RegExp(p.pattern, 'g' + (p.flags || '').replace('g', ''));
    const pats = cfg.ignore.allTextPatterns;
    c = {
      ignore: pats.filter((p) => p.mode !== 'cosmetic').map((p) => ({ name: p.name, re: toRe(p) })),
      cosmetic: pats.filter((p) => p.mode === 'cosmetic').map((p) => ({ name: p.name, re: toRe(p) })),
    };
    cache.set(cfg, c);
  }
  return c;
}

/** Collapse all whitespace (incl. non-breaking and zero-width) to single spaces. */
export function collapseWs(s) {
  return String(s ?? '').replace(/[​-‍﻿]/g, '').replace(/[\s ]+/g, ' ').trim();
}

/** Normalise quotes/dashes/ellipsis so typographic swaps do not count as changes. */
function unifyTypography(s) {
  return s.replace(/[‘’‚′]/g, "'").replace(/[“”„″]/g, '"')
    .replace(/[–—−]/g, '-').replace(/…/g, '...');
}

export function normText(s, cfg) {
  let t = unifyTypography(collapseWs(s));
  for (const { name, re } of compiled(cfg).ignore) t = t.replace(re, `{${name}}`);
  return t;
}

export function cosmeticText(s, cfg) {
  let t = normText(s, cfg);
  for (const { name, re } of compiled(cfg).cosmetic) t = t.replace(re, `{${name}}`);
  if (cfg.ignore.caseAndPunctuationIsCosmetic) {
    t = t.toLowerCase().replace(/\{[a-z-]+\}/g, (m) => m.replace(/-/g, '_')).replace(/[^\p{L}\p{N}{}_\s]/gu, '').replace(/\s+/g, ' ').trim();
  }
  return t;
}

/** Build a comparable value: { raw, norm, cos }. */
export function value(raw, cfg) {
  const r = collapseWs(raw);
  return { raw: r, norm: normText(r, cfg), cos: cosmeticText(r, cfg) };
}

/** Word-level similarity (Dice coefficient on word multisets), 0..1. */
export function similarity(a, b) {
  if (a === b) return 1;
  const wa = tokens(a), wb = tokens(b);
  if (!wa.length || !wb.length) return 0;
  const counts = new Map();
  for (const w of wa) counts.set(w, (counts.get(w) || 0) + 1);
  let common = 0;
  for (const w of wb) {
    const n = counts.get(w);
    if (n) { common++; counts.set(w, n - 1); }
  }
  return (2 * common) / (wa.length + wb.length);
}

export function tokens(s) {
  return String(s).toLowerCase().match(/[\p{L}\p{N}$€£%.,]+/gu)?.map((w) => w.replace(/[.,]+$/, '')).filter(Boolean) || [];
}
