/**
 * Writes the human-readable HTML report (single self-contained file, plus an
 * assets/ folder for screenshots when visual comparison is on) and report.json.
 *
 * Layout: summary -> notes -> filters -> page overview table -> site-wide
 * differences -> per-page details (collapsible, grouped by category) -> legend.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { diffWordsWithSpace } from 'diff';
import { SIGNIFICANCE, CATEGORIES } from './compare.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const SIG_KEYS = Object.keys(SIGNIFICANCE);

function badge(sig, count) {
  return `<span class="badge s-${sig}" title="${esc(SIGNIFICANCE[sig].help)}">${esc(SIGNIFICANCE[sig].label)}${count != null ? ` <b>${count}</b>` : ''}</span>`;
}

function sigCounts(diffs) {
  const c = {};
  for (const d of diffs) c[d.sig] = (c[d.sig] || 0) + 1;
  return SIG_KEYS.filter((s) => c[s]).map((s) => badge(s, c[s])).join(' ');
}

/** Render a value; for word diffs, highlight what is different on each side. */
function renderSides(d) {
  if (d.images) {
    const img = (src, label) => `<figure><a href="${esc(src)}" target="_blank"><img src="${esc(src)}" loading="lazy" alt="${esc(label)}"></a><figcaption>${esc(label)}</figcaption></figure>`;
    return `<div class="shots">${img(d.images.a, 'A')}${img(d.images.diff, 'Difference overlay')}${img(d.images.b, 'B')}</div>`;
  }
  let a, b;
  if (d.wordDiff && typeof d.a === 'string' && typeof d.b === 'string') {
    const parts = diffWordsWithSpace(d.a, d.b);
    a = parts.filter((p) => !p.added).map((p) => (p.removed ? `<del>${esc(p.value)}</del>` : esc(p.value))).join('');
    b = parts.filter((p) => !p.removed).map((p) => (p.added ? `<ins>${esc(p.value)}</ins>` : esc(p.value))).join('');
  } else {
    const one = (v) => (v == null ? '<span class="absent">— not present —</span>'
      : Array.isArray(v) ? `<ul>${v.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : esc(v));
    a = one(d.a); b = one(d.b);
  }
  return `<div class="sides"><div class="side"><div class="side-label">A</div><div class="val">${a}</div></div>` +
    `<div class="side"><div class="side-label">B</div><div class="val">${b}</div></div></div>`;
}

function renderDiff(d, extra = '') {
  return `<div class="diff" data-sig="${d.sig}" data-cat="${d.category}">
  <div class="diff-head">${badge(d.sig)}<span class="dtitle">${esc(d.title)}</span>${d.context ? `<span class="ctx">${esc(d.context)}</span>` : ''}${extra}</div>
  ${renderSides(d)}
  ${d.note ? `<div class="note">${esc(d.note)}</div>` : ''}
</div>`;
}

function renderCategoryGroups(diffs, cfg) {
  const byCat = new Map();
  for (const d of diffs) { if (!byCat.has(d.category)) byCat.set(d.category, []); byCat.get(d.category).push(d); }
  const max = cfg.output.maxDiffsPerCategory;
  return [...byCat].map(([cat, ds]) => `<div class="cat" data-cat="${cat}">
  <h4>${esc(CATEGORIES[cat] || cat)} <span class="muted">(${ds.length})</span></h4>
  ${ds.slice(0, max).map((d) => renderDiff(d)).join('\n')}
  ${ds.length > max ? `<p class="muted">… and ${ds.length - max} more in this category (see report.json, or raise output.maxDiffsPerCategory).</p>` : ''}
</div>`).join('\n');
}

const KIND_LABEL = { 'compared': 'Compared', 'only-a': 'Only on A', 'only-b': 'Only on B', 'error': 'Failed to load' };
const pageId = (i) => `p${i}`;

function resultCell(p) {
  if (p.kind === 'compared') {
    if (p.identical) return '<span class="ok">Identical</span>';
    if (!p.diffs.length) return '<span class="ok">Same content</span> <span class="muted">(site-wide only)</span>';
    return `${p.diffs.length} difference${p.diffs.length === 1 ? '' : 's'}`;
  }
  return `<span class="kind-${p.kind}">${KIND_LABEL[p.kind]}</span>`;
}

function pathCell(p) {
  if (p.keyA && p.keyB && p.keyA !== p.keyB) return `${esc(p.keyA)} <span class="muted">→</span> ${esc(p.keyB)}`;
  return esc(p.keyA || p.keyB);
}

const statusText = (s, url) => (url ? (s ?? 'error') : '—');

export function renderHtml(r, cfg) {
  const { summary: s, sites } = r;
  const LA = sites.A.label, LB = sites.B.label;
  const pages = r.pages;
  const differing = pages.filter((p) => p.diffs.length);
  const identical = pages.filter((p) => p.identical);
  const swOnly = pages.filter((p) => !p.identical && !p.diffs.length);
  const allOpen = differing.reduce((n, p) => n + p.diffs.length, 0) <= 40;
  const target = (p, i) => (p.diffs.length ? `#${pageId(i)}` : p.siteWide.length ? '#sitewide' : '');

  const tile = (n, label, cls = '', href = '') => `<a class="tile ${cls}" ${href ? `href="${href}"` : ''}><span class="n">${n}</span><span class="l">${esc(label)}</span></a>`;

  const notes = r.notes.length ? `<section class="notes">${r.notes.map((n) => `<p class="${/^(WARNING|ERROR)/.test(n) ? 'warn' : ''}">${esc(n)}</p>`).join('')}</section>` : '';

  const overviewRows = pages.map((p, i) => `<tr data-kind="${p.kind}" data-identical="${p.identical}" data-sigs="${[...new Set(p.diffs.map((d) => d.sig))].join(' ')}" data-path="${esc((p.keyA || '') + ' ' + (p.keyB || ''))}">
  <td class="path">${target(p, i) ? `<a href="${target(p, i)}">${pathCell(p)}</a>` : pathCell(p)}</td>
  <td>${resultCell(p)}</td>
  <td class="badges">${sigCounts(p.diffs)}${p.siteWide.length ? ` <span class="badge s-site" title="Also affected by site-wide differences">+${p.siteWide.length} site-wide</span>` : ''}</td>
  <td class="num">${esc(statusText(p.statusA, p.urlA))}</td><td class="num">${esc(statusText(p.statusB, p.urlB))}</td>
</tr>`).join('\n');

  const siteWide = r.siteWide.length ? `<section id="sitewide">
  <h2>Site-wide differences <span class="muted">(${r.siteWide.length})</span></h2>
  <p class="lede">These appear on many pages (usually navigation, header or footer). Each is listed once here and left out of the individual pages below.</p>
  ${r.siteWide.map((d, i) => `<div id="sw${i}">${renderDiff(d, `<span class="ctx">#${i + 1} · on ${d.pages.length} of ${s.pagesCompared} compared pages</span>`)}
  <details class="pages-list"><summary>Show affected pages</summary><p>${d.pages.map(esc).join(', ')}</p></details></div>`).join('\n')}
  ${swOnly.length ? `<p class="muted">${swOnly.length} page${swOnly.length > 1 ? 's have' : ' has'} no differences apart from these: ${swOnly.map((p) => esc(p.keyB || p.keyA)).join(', ')}</p>` : ''}
</section>` : '';

  const pageSections = pages.map((p, i) => {
    if (!p.diffs.length) return '';
    const urls = [p.urlA && `<a href="${esc(p.urlA)}" target="_blank" rel="noopener">A: ${esc(p.urlA)}</a>`, p.urlB && `<a href="${esc(p.urlB)}" target="_blank" rel="noopener">B: ${esc(p.urlB)}</a>`].filter(Boolean).join(' &nbsp;·&nbsp; ');
    const sw = p.siteWide.length ? `<p class="muted">Also affected by ${p.siteWide.length} site-wide difference${p.siteWide.length > 1 ? 's' : ''}: ${[...p.siteWide].sort((x, y) => x - y).map((i) => `<a href="#sw${i}">#${i + 1}</a>`).join(', ')}</p>` : '';
    // Small reports open fully; large ones open only short pages with serious differences.
    const worst = Math.min(...p.diffs.map((d) => SIGNIFICANCE[d.sig].rank));
    const open = allOpen || (worst <= SIGNIFICANCE.missing.rank && p.diffs.length <= 12) ? ' open' : '';
    return `<details class="page" id="${pageId(i)}" data-kind="${p.kind}" data-swonly="${!p.diffs.length}" data-path="${esc((p.keyA || '') + ' ' + (p.keyB || ''))}"${open}>
  <summary><span class="ptitle">${pathCell(p)}</span><span class="kindtag kind-${p.kind}">${KIND_LABEL[p.kind]}</span><span class="badges">${sigCounts(p.diffs)}</span></summary>
  <div class="page-body">
    <p class="urls">${urls}</p>
    ${(p.titleA || p.titleB) ? `<p class="muted">Page title: ${p.titleA === p.titleB ? `“${esc(p.titleA)}”` : [p.titleA != null && `A “${esc(p.titleA)}”`, p.titleB != null && `B “${esc(p.titleB)}”`].filter(Boolean).join(' · ')}</p>` : ''}
    ${p.notes.map((n) => `<p class="note">${esc(n)}</p>`).join('')}
    ${sw}
    ${renderCategoryGroups(p.diffs, cfg)}
  </div>
</details>`;
  }).join('\n');

  const identicalList = identical.length ? `<details class="identical"><summary>${identical.length} identical page${identical.length > 1 ? 's' : ''}</summary><p>${identical.map((p) => esc(p.keyA)).join(', ')}</p></details>` : '';

  const skipped = [...sites.A.skipped.map((x) => ({ ...x, site: 'A' })), ...sites.B.skipped.map((x) => ({ ...x, site: 'B' }))];
  const crawlNotes = skipped.length ? `<details class="crawlnotes"><summary>Links not followed (${skipped.length})</summary>
  <table><thead><tr><th>Site</th><th>URL</th><th>Reason</th></tr></thead><tbody>${skipped.slice(0, 500).map((x) => `<tr><td>${x.site}</td><td class="path">${esc(x.url)}</td><td>${esc(x.reason)}</td></tr>`).join('')}</tbody></table></details>` : '';

  const sigFilters = SIG_KEYS.map((k) => `<label class="chip"><input type="checkbox" data-sig="${k}" checked> ${badge(k, s.bySignificance[k])}</label>`).join('');
  const catOptions = Object.entries(CATEGORIES).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>SiteDiff: ${esc(LA)} vs ${esc(LB)}</title>
<style>
:root{--bg:#fff;--fg:#1d2433;--muted:#667085;--line:#e4e7ec;--panel:#f8f9fb;--a:#b42318;--del:#fde2e0;--ins:#d7f5e3;--link:#175cd3;
--s-error:#b42318;--s-missing:#c4320a;--s-changed:#a15c07;--s-added:#067647;--s-structural:#5925dc;--s-cosmetic:#667085;--s-site:#344054}
@media (prefers-color-scheme:dark){:root{--bg:#12151c;--fg:#e6e8ec;--muted:#98a2b3;--line:#2b303b;--panel:#1a1e27;--del:#5a1f1c;--ins:#113d27;--link:#84adff;
--s-error:#f97066;--s-missing:#fb6514;--s-changed:#fdb022;--s-added:#47cd89;--s-structural:#a48afb;--s-cosmetic:#98a2b3;--s-site:#cfd4dc}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:1200px;margin:0 auto;padding:24px 16px 64px}
a{color:var(--link)}
h1{font-size:24px;margin:0 0 4px}h2{font-size:19px;margin:36px 0 8px}h4{margin:18px 0 8px;font-size:14px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted)}
.muted{color:var(--muted)}.lede{color:var(--muted);margin-top:0}
.sites{display:flex;flex-wrap:wrap;gap:8px 24px;margin:8px 0}
.sites div{min-width:0;overflow-wrap:anywhere}.sites b{display:inline-block;min-width:1.4em}
.meta{font-size:13px;color:var(--muted)}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px;margin:20px 0 12px}
.tile{display:flex;flex-direction:column;padding:12px 14px;border:1px solid var(--line);border-radius:10px;background:var(--panel);text-decoration:none;color:inherit}
.tile .n{font-size:28px;font-weight:650;line-height:1.1}.tile .l{font-size:13px;color:var(--muted)}
.tile.bad .n{color:var(--s-error)}.tile.warn .n{color:var(--s-missing)}.tile.good .n{color:var(--s-added)}
.notes p{margin:6px 0;padding:8px 12px;border-left:3px solid var(--line);background:var(--panel);border-radius:4px;font-size:14px}
.notes p.warn{border-left-color:var(--s-error)}
.badge{display:inline-block;padding:1px 8px;border-radius:999px;font-size:12px;font-weight:600;border:1px solid currentColor;white-space:nowrap;line-height:1.6}
${SIG_KEYS.map((k) => `.s-${k}{color:var(--s-${k})}`).join('')}.s-site{color:var(--s-site)}
.toolbar{position:sticky;top:0;z-index:5;background:var(--bg);border-bottom:1px solid var(--line);padding:10px 0;display:flex;flex-wrap:wrap;gap:8px 14px;align-items:center}
.chip{cursor:pointer;display:inline-flex;align-items:center;gap:4px}.chip input{margin:0}
.toolbar input[type=search],.toolbar select{padding:5px 8px;border:1px solid var(--line);border-radius:6px;background:var(--bg);color:var(--fg);font:inherit;font-size:14px}
.toolbar button{padding:5px 10px;border:1px solid var(--line);border-radius:6px;background:var(--panel);color:var(--fg);cursor:pointer;font:inherit;font-size:13px}
.tablewrap{overflow-x:auto}
table{border-collapse:collapse;width:100%;font-size:14px}
th,td{text-align:left;padding:7px 8px;border-bottom:1px solid var(--line);vertical-align:top}
th{font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted)}
td.num{white-space:nowrap}td.path{overflow-wrap:anywhere;min-width:160px}td.badges .badge{margin:1px 0}
.ok{color:var(--s-added);font-weight:600}.kind-only-a{color:var(--s-missing);font-weight:600}.kind-only-b{color:var(--s-added);font-weight:600}.kind-error{color:var(--s-error);font-weight:600}.kind-compared{color:var(--muted)}
details.page{border:1px solid var(--line);border-radius:10px;margin:10px 0;background:var(--bg)}
details.page>summary{cursor:pointer;padding:10px 14px;display:flex;flex-wrap:wrap;gap:6px 10px;align-items:center;list-style:none}
details.page>summary::before{content:"▸";color:var(--muted)}details.page[open]>summary::before{content:"▾"}
details.page[open]>summary{border-bottom:1px solid var(--line);background:var(--panel);border-radius:10px 10px 0 0}
.ptitle{font-weight:650;overflow-wrap:anywhere}.kindtag{font-size:12px}
.page-body{padding:4px 14px 14px}.urls{font-size:13px;overflow-wrap:anywhere}
.diff{border-top:1px solid var(--line);padding:10px 0}
.cat h4+.diff{border-top:0}
.diff-head{display:flex;flex-wrap:wrap;gap:6px 10px;align-items:baseline;margin-bottom:6px}
.dtitle{font-weight:600}.ctx{font-size:13px;color:var(--muted)}
.sides{display:grid;grid-template-columns:1fr 1fr;gap:10px}
@media (max-width:700px){.sides{grid-template-columns:1fr}}
.side{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:8px 10px;min-width:0}
.side-label{font-size:11px;font-weight:700;color:var(--muted);letter-spacing:.06em;margin-bottom:2px}
.val{white-space:pre-wrap;overflow-wrap:anywhere;font-size:14px}.val ul{margin:0;padding-left:18px;white-space:normal}.val li{margin:2px 0;white-space:pre-wrap}
del{background:var(--del);text-decoration:line-through;text-decoration-color:var(--s-error);border-radius:3px}
ins{background:var(--ins);text-decoration:none;border-radius:3px}
.absent{color:var(--muted);font-style:italic}
.note{font-size:13px;color:var(--muted);margin:6px 0 0}
.shots{display:grid;grid-template-columns:repeat(3,1fr);gap:10px}.shots figure{margin:0}.shots img{width:100%;max-height:420px;object-fit:cover;object-position:top;border:1px solid var(--line);border-radius:6px}
.shots figcaption{font-size:12px;color:var(--muted);text-align:center}
@media (max-width:700px){.shots{grid-template-columns:1fr}}
.pages-list{font-size:13px;margin-top:4px}.pages-list summary{cursor:pointer;color:var(--link)}
details.identical,details.crawlnotes{margin:12px 0}details.identical summary,details.crawlnotes summary{cursor:pointer;font-weight:600}
dl.legend{display:grid;grid-template-columns:max-content 1fr;gap:6px 14px;font-size:14px}dl.legend dd{margin:0}
.hidden{display:none!important}
@media print{.toolbar{display:none}details.page{break-inside:avoid}}
</style>
</head>
<body>
<main>
<header>
  <h1>Website comparison</h1>
  <div class="sites"><div><b>A</b> ${esc(LA)}: <a href="${esc(sites.A.url)}">${esc(sites.A.url)}</a></div><div><b>B</b> ${esc(LB)}: <a href="${esc(sites.B.url)}">${esc(sites.B.url)}</a></div></div>
  <div class="meta">Generated ${esc(new Date(r.generatedAt).toLocaleString())} · ${r.durationSec}s · ${sites.A.pagesFetched} + ${sites.B.pagesFetched} pages fetched · rendering: ${esc(r.settings.renderMode)} · robots.txt ${r.settings.respectRobotsTxt ? 'respected' : 'ignored'} · page limit ${r.settings.maxPages}${r.settings.visual ? ' · visual comparison on' : ''}</div>
</header>

<section class="tiles" aria-label="Summary">
  ${tile(s.pagesCompared, 'Pages compared')}
  ${tile(s.identical, 'Identical', 'good')}
  ${s.siteWideOnly ? tile(s.siteWideOnly, 'Same content (site-wide differences only)', '', '#sitewide') : ''}
  ${tile(s.withDifferences, 'With page differences', s.withDifferences ? 'warn' : '', '#pages')}
  ${tile(s.onlyA, `Only on A (${LA})`, s.onlyA ? 'bad' : '')}
  ${tile(s.onlyB, `Only on B (${LB})`)}
  ${s.errors ? tile(s.errors, 'Failed to load', 'bad') : ''}
</section>
<p class="muted">${s.totalDifferences} difference${s.totalDifferences === 1 ? '' : 's'} in total${s.siteWide ? `, including ${s.siteWide} site-wide` : ''}: ${SIG_KEYS.filter((k) => s.bySignificance[k]).map((k) => badge(k, s.bySignificance[k])).join(' ') || 'none'}</p>
${notes}

<div class="toolbar" role="region" aria-label="Filters">
  ${sigFilters}
  <select id="cat"><option value="">All categories</option>${catOptions}</select>
  <input type="search" id="q" placeholder="Filter by path…">
  <button id="expand" type="button">Expand all</button><button id="collapse" type="button">Collapse all</button>
</div>

<h2>Pages at a glance</h2>
<p class="lede">Most serious first. Click a path to jump to its details.</p>
<div class="tablewrap"><table id="overview"><thead><tr><th>Page</th><th>Result</th><th>Differences</th><th>A</th><th>B</th></tr></thead><tbody>
${overviewRows}
</tbody></table></div>
${identicalList}

${siteWide}

<h2>Differences by page <span class="muted">(${differing.length})</span></h2>
<p class="lede">Each page lists what A and B have side by side. <del>Struck red</del> text is only on A; <ins>green</ins> text is only on B.</p>
<div id="pages">
${pageSections || '<p>No page-level differences.</p>'}
</div>

<h2>How to read this report</h2>
<dl class="legend">
${SIG_KEYS.map((k) => `<dt>${badge(k)}</dt><dd>${esc(SIGNIFICANCE[k].help)}</dd>`).join('\n')}
</dl>
<p class="muted">A is the baseline (${esc(LA)}), B the candidate (${esc(LB)}). Whitespace, tracking parameters, tracking scripts, element IDs and generated timestamps are ignored. The rules are in <code>src/config.js</code> under <code>ignore</code>. Pages are matched by path; renamed or moved pages are matched by URL similarity, redirects, or content.</p>
${crawlNotes}
</main>
<script>
(function(){
  const $$=(s,r=document)=>[...r.querySelectorAll(s)];
  const sigBoxes=$$('.toolbar input[data-sig]'), cat=document.getElementById('cat'), q=document.getElementById('q');
  function apply(){
    const sigs=new Set(sigBoxes.filter(b=>b.checked).map(b=>b.dataset.sig));
    const c=cat.value, text=q.value.trim().toLowerCase();
    $$('.diff').forEach(d=>d.classList.toggle('hidden',!sigs.has(d.dataset.sig)||(c&&d.dataset.cat!==c)));
    $$('.cat').forEach(g=>g.classList.toggle('hidden',!$$('.diff:not(.hidden)',g).length));
    $$('details.page').forEach(p=>{
      const match=!text||p.dataset.path.toLowerCase().includes(text);
      p.classList.toggle('hidden',!match||(!$$('.diff:not(.hidden)',p).length&&p.dataset.swonly!=='true'));
    });
    $$('#sitewide > div').forEach(d=>d.classList.toggle('hidden',d.querySelector('.diff').classList.contains('hidden')));
    $$('#overview tbody tr').forEach(tr=>{
      const match=!text||tr.dataset.path.toLowerCase().includes(text);
      const s=tr.dataset.sigs?tr.dataset.sigs.split(' '):[];
      const sigOk=tr.dataset.identical==='true'||!s.length||s.some(x=>sigs.has(x));
      tr.classList.toggle('hidden',!match||!sigOk);
    });
  }
  sigBoxes.forEach(b=>b.addEventListener('change',apply)); cat.addEventListener('change',apply); q.addEventListener('input',apply);
  document.getElementById('expand').onclick=()=>$$('details.page').forEach(d=>d.open=true);
  document.getElementById('collapse').onclick=()=>$$('details.page').forEach(d=>d.open=false);
  $$('#overview a').forEach(a=>a.addEventListener('click',()=>{const t=document.querySelector(a.getAttribute('href'));if(t)t.open=true;}));
})();
</script>
</body>
</html>`;
}

export async function writeReport(result, outDir, cfg) {
  await fs.mkdir(outDir, { recursive: true });
  const reportPath = path.join(outDir, 'report.html');
  await fs.writeFile(reportPath, renderHtml(result, cfg), 'utf8');
  let jsonPath = null;
  if (cfg.output.writeJson) {
    jsonPath = path.join(outDir, 'report.json');
    const clean = JSON.parse(JSON.stringify(result, (k, v) => (k === 'fp' ? undefined : v)));
    await fs.writeFile(jsonPath, JSON.stringify(clean, null, 2), 'utf8');
  }
  return { reportPath, jsonPath };
}
