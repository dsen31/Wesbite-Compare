/**
 * Turn a page's HTML into a "snapshot": the parts a visitor would notice,
 * already normalised so the comparison only sees meaningful differences.
 *
 * Snapshot fields:
 *   meta       title, description, canonical, robots, lang, og:*
 *   headings   [{ level, text }]
 *   structure  counts of landmarks (header/nav/main/footer/aside) and tables, lists, embeds
 *   blocks     visible text, one entry per block element (paragraph, list item, cell, ...)
 *   links      [{ key, text, href }]    key = page key for internal links, normalised URL otherwise
 *   images     [{ key, alt, src }]      key = file name without hashes/size suffixes
 *   forms      [{ action, method, fields[{ name, type, required, label }], submit }]
 *   ctas       buttons and button-styled links outside forms: [{ text, target }]
 *   crawlLinks absolute in-scope URLs, used by the crawler
 */
import * as cheerio from 'cheerio';
import { value, collapseWs } from './normalize.js';
import { isInScope, toKey, normalizeExternalUrl, stripTrackingParams } from './url-utils.js';

const BLOCK = new Set(['address', 'article', 'aside', 'blockquote', 'details', 'dialog', 'dd', 'div', 'dl', 'dt',
  'fieldset', 'figcaption', 'figure', 'footer', 'form', 'header', 'hgroup', 'hr', 'li', 'main', 'nav', 'ol', 'p',
  'pre', 'section', 'table', 'tbody', 'thead', 'tfoot', 'tr', 'td', 'th', 'ul', 'caption', 'summary', 'legend']);
const HEADINGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']);
// Not part of "text": form controls and their labels (compared under forms), media.
const NO_TEXT = new Set(['select', 'option', 'textarea', 'input', 'label', 'img', 'video', 'audio', 'canvas', 'iframe', 'object', 'embed', 'map']);
const CTA_CLASS = /(^|[\s_-])(btn|button|cta)([\s_-]|$)/i;
const STANDALONE_LINK_MAX = 100; // chars; see collectBlocks

function loadClean(html, cfg) {
  const $ = cheerio.load(html || '');
  $(cfg.ignore.allSelectors.join(',')).remove();
  $('[hidden], [style*="display:none"], [style*="display: none"], [style*="visibility:hidden"], [style*="visibility: hidden"]').remove();
  return $;
}

/** Heuristic: does this static HTML need JavaScript to show its content? */
export function looksJsRendered(html, cfg) {
  if (!html) return false;
  const raw = cheerio.load(html);
  const hasScripts = raw('script').length > 0;
  const noscript = raw('noscript').text();
  const emptyMount = raw('#root, #app, #__next, #__nuxt, #___gatsby, [data-reactroot], app-root')
    .toArray().some((el) => raw(el).children().length === 0 && !collapseWs(raw(el).text()));
  const $ = loadClean(html, { ignore: { allSelectors: ['script', 'style', 'noscript', 'template', 'svg'] } });
  const textLen = collapseWs($('body').text()).length;
  return (hasScripts && (textLen < cfg.render.minStaticTextChars || emptyMount))
    || (/enable javascript|javascript (is )?required/i.test(noscript) && textLen < 1000);
}

/** Resolve a URL attribute to an absolute URL, or null. */
function resolve(href, base) {
  if (!href) return null;
  href = href.trim();
  if (!href || href.startsWith('#') || /^(javascript|data|blob|about):/i.test(href)) return null;
  try { return new URL(href, base); } catch { return null; }
}

/** Comparable key for a link target. Internal pages use their page key. */
export function linkKey(abs, scope, cfg) {
  if (/^(mailto|tel|sms):/i.test(abs.protocol)) return abs.protocol + decodeURIComponent(abs.pathname).toLowerCase();
  if (isInScope(abs, scope, cfg)) return toKey(stripTrackingParams(new URL(abs.href), cfg), scope, cfg);
  return normalizeExternalUrl(abs.href, cfg);
}

/** Image identity: file name, lower-cased, minus content hashes and size suffixes. */
export function imageKey(abs, cfg) {
  let name = decodeURIComponent(abs.pathname.split('/').pop() || abs.pathname).toLowerCase();
  for (const p of cfg.ignore.imageNamePatterns) name = name.replace(new RegExp(p, 'i'), '');
  return name || abs.href;
}

function imageSrc($el) {
  const cands = [$el.attr('src'), $el.attr('data-src'), $el.attr('data-lazy-src'), $el.attr('data-original'),
    ($el.attr('srcset') || $el.attr('data-srcset') || '').split(',')[0].trim().split(/\s+/)[0]];
  return cands.find((c) => c && !/^data:/i.test(c.trim())) || null;
}

/**
 * Visible text as a list of blocks. Heading text is left out (compared under
 * "headings"), and so is a block made only of a short link or button, such as a
 * nav item, since that is compared under "links" / "calls to action".
 */
function collectBlocks($, cfg) {
  const blocks = [];
  let buf = [];
  let section = ''; // text of the nearest heading above, shown in the report as context
  const flush = () => {
    const text = collapseWs(buf.map((s) => s.text).join(''));
    if (text) {
      const onlyLinks = buf.every((s) => s.inLink || !s.text.trim());
      if (!(onlyLinks && text.length <= STANDALONE_LINK_MAX)) blocks.push({ ...value(text, cfg), section });
    }
    buf = [];
  };
  const walk = (node, inLink) => {
    for (const ch of node.children || []) {
      if (ch.type === 'text') { buf.push({ text: ch.data, inLink }); continue; }
      if (ch.type !== 'tag') continue;
      const name = ch.name;
      if (NO_TEXT.has(name)) continue;
      if (HEADINGS.has(name) || ch.attribs?.role === 'heading') { flush(); section = collapseWs($(ch).text()); continue; }
      if (name === 'br') { buf.push({ text: ' ', inLink }); continue; }
      const link = inLink || name === 'a' || name === 'button';
      if (BLOCK.has(name)) { flush(); walk(ch, link); flush(); } else walk(ch, link);
    }
  };
  const body = $('body')[0] || $.root()[0];
  walk(body, false);
  flush();
  return blocks.filter((b) => b.norm);
}

function fieldLabel($, $el) {
  const id = $el.attr('id');
  let label = id ? $(`label[for="${id.replace(/"/g, '\\"')}"]`).first().text() : '';
  if (!label) label = $el.closest('label').clone().children('input,select,textarea').remove().end().text();
  return collapseWs(label || $el.attr('aria-label') || $el.attr('placeholder') || $el.attr('title') || '');
}

export function extractSnapshot(html, pageUrl, scope, cfg) {
  const $ = loadClean(html, cfg);
  const baseHref = $('base[href]').attr('href');
  const base = (baseHref && resolve(baseHref, pageUrl)?.href) || pageUrl;
  const meta = (sel) => collapseWs($(sel).first().attr('content') || '');

  // --- metadata
  const canonicalAbs = resolve($('link[rel="canonical"]').attr('href'), base);
  const ogImageAbs = resolve(meta('meta[property="og:image"]'), base);
  const snap = {
    meta: {
      title: value($('title').first().text(), cfg),
      description: value(meta('meta[name="description" i]'), cfg),
      canonical: canonicalAbs ? linkKey(canonicalAbs, scope, cfg) : '',
      robots: meta('meta[name="robots" i]').toLowerCase().replace(/\s+/g, ''),
      lang: ($('html').attr('lang') || '').toLowerCase(),
      ogTitle: value(meta('meta[property="og:title"]'), cfg),
      ogDescription: value(meta('meta[property="og:description"]'), cfg),
      ogImage: ogImageAbs ? imageKey(ogImageAbs, cfg) : '',
    },
  };

  // --- headings (document order)
  snap.headings = $('h1,h2,h3,h4,h5,h6,[role="heading"]').toArray().map((el) => {
    const level = HEADINGS.has(el.name) ? Number(el.name[1]) : Number($(el).attr('aria-level')) || 2;
    return { level, text: value($(el).text(), cfg) };
  }).filter((h) => h.text.norm);

  // --- structure
  const count = (sel) => $(sel).length;
  snap.structure = {
    'header landmarks': count('header, [role="banner"]'),
    'navigation menus': count('nav, [role="navigation"]'),
    'main content areas': count('main, [role="main"]'),
    'footers': count('footer, [role="contentinfo"]'),
    'sidebars': count('aside, [role="complementary"]'),
    'tables': count('table'),
    'lists': count('ul, ol'),
    'embedded frames': count('iframe'),
    'videos / audio': count('video, audio'),
  };

  // --- text
  snap.blocks = collectBlocks($, cfg);

  // --- links (also feed the crawler)
  snap.links = [];
  snap.crawlLinks = [];
  $('a[href], area[href]').each((_, el) => {
    const abs = resolve($(el).attr('href'), base);
    if (!abs) return;
    const $el = $(el);
    const text = collapseWs($el.text()) || $el.attr('aria-label') || $el.attr('title') || $el.find('img[alt]').attr('alt') || '';
    // Button-styled links are compared as calls to action; `cta` keeps them out of the plain link comparison.
    const cta = ($el.attr('role') === 'button' || CTA_CLASS.test($el.attr('class') || '')) && !$el.closest('form').length;
    snap.links.push({ key: linkKey(abs, scope, cfg), text: value(text, cfg), href: abs.href, cta });
    if (isInScope(abs, scope, cfg)) { abs.hash = ''; snap.crawlLinks.push(abs.href); }
  });

  // --- images
  snap.images = [];
  $('img').each((_, el) => {
    const $el = $(el);
    const abs = resolve(imageSrc($el), base);
    if (!abs) return;
    snap.images.push({ key: imageKey(abs, cfg), alt: value($el.attr('alt') ?? '', cfg), hasAlt: $el.attr('alt') !== undefined, src: abs.href });
  });

  // --- forms
  snap.forms = $('form').toArray().map((form) => {
    const $f = $(form);
    const actionAbs = resolve($f.attr('action'), base) || new URL(pageUrl);
    const fields = [];
    $f.find('input, select, textarea').each((_, el) => {
      const $el = $(el);
      const type = (el.name === 'input' ? ($el.attr('type') || 'text') : el.name).toLowerCase();
      if (['submit', 'button', 'image', 'reset'].includes(type)) return;
      if (type === 'hidden' && cfg.ignore.ignoreHiddenFormFields) return;
      const label = fieldLabel($, $el);
      fields.push({
        name: $el.attr('name') || label || type,
        type,
        required: $el.attr('required') !== undefined || $el.attr('aria-required') === 'true',
        label,
      });
    });
    const $submit = $f.find('button[type="submit"], button:not([type]), input[type="submit"], input[type="image"]').first();
    const submit = collapseWs($submit.is('input') ? ($submit.attr('value') || $submit.attr('alt') || 'Submit') : $submit.text());
    return {
      action: linkKey(actionAbs, scope, cfg),
      method: ($f.attr('method') || 'get').toLowerCase(),
      fields,
      submit: value(submit, cfg),
    };
  });

  // --- calls to action (outside forms)
  snap.ctas = [];
  $('a, button, input[type="button"], input[type="submit"], [role="button"]').each((_, el) => {
    const $el = $(el);
    if ($el.closest('form').length) return;
    const isButtonish = el.name === 'button' || el.name === 'input' || $el.attr('role') === 'button' || CTA_CLASS.test($el.attr('class') || '');
    if (!isButtonish) return;
    const text = collapseWs(el.name === 'input' ? $el.attr('value') : $el.text()) || $el.attr('aria-label') || '';
    if (!text) return;
    const abs = el.name === 'a' ? resolve($el.attr('href'), base) : null;
    snap.ctas.push({ text: value(text, cfg), target: abs ? linkKey(abs, scope, cfg) : '(button)' });
  });

  snap.fullText = [snap.meta.title.norm, ...snap.headings.map((h) => h.text.norm), ...snap.blocks.map((b) => b.norm)].join(' ');
  return snap;
}
