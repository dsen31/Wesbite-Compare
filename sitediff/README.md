# SiteDiff

Compares two websites that are meant to match (for example a live site and its redesign or migration) and writes an HTML report of every difference.

- **Crawls both sites** from their start URL. The crawl stays on each site's own host and path, is rate-limited, and obeys robots.txt. It also reads `sitemap.xml`.
- **Pairs pages by path.** Pages that were renamed, moved, or redirected are still matched: by redirect, by a near-identical URL (`/team.html` vs `/team`), or by content similarity. Pages that exist on only one site are **confirmed by a direct request** before they are reported as missing.
- **Compares what a visitor sees:**
  - visible text
  - headings (text and level)
  - page structure
  - links (including broken ones)
  - images and alt text
  - title, description, canonical, robots and social tags
  - forms and fields
  - calls to action
  - optionally, **screenshots** (pixel diff)
- **Uses a headless browser automatically** for pages that need JavaScript.
- **Ignores noise:** whitespace, timestamps, relative times, UUIDs and hashes, tracking scripts and parameters, element IDs, CSRF tokens, and hashed or resized image names. Differences that repeat on every page (nav or footer changes) are reported **once**, as site-wide differences.

## Install

Requires Node.js 18.17 or newer.

```bash
cd sitediff
npm install
npx playwright install chromium
```

The second command downloads the headless browser, which JavaScript rendering and `--visual` need. Without it, SiteDiff still works on plain HTML and says in the report that rendering was unavailable.

## Try it first

```bash
npm test
```

This runs unit tests plus end-to-end runs against two bundled demo sites and some deliberately broken servers (timeouts, HTTP 500, an unreachable host).

```bash
npm run demo
```

This compares the demo sites in `demo/site-a` (Live) and `demo/site-b` (Redesign) and writes `reports/demo/report.html`. The demo plants one or more of each kind of difference:
- a price change, a removed table, and an accidental `noindex`
- a renamed page, a page moved behind a 301, a `.html` URL change, a missing page, and a new page
- form field changes, heading level changes, a changed CTA, a broken nav link, and a date-only (cosmetic) change
- a page rendered by JavaScript

The FAQ page differs only by noise and correctly shows no page-specific differences.

## Compare two sites

```bash
node src/cli.js https://www.example.com https://staging.example.com --label-a Live --label-b Staging --open
```

A is the baseline and B the candidate: "Missing" means on A but not on B. Each run writes `report.html` and `report.json` into `reports/<hostA>-vs-<hostB>-<timestamp>/`.

| Option | Default | |
|---|---|---|
| `--max-pages <n>` | 100 | pages crawled per site |
| `--out <dir>` | `reports` | output folder |
| `--render auto\|always\|never` | auto | headless browser when a page needs JavaScript |
| `--visual` | off | screenshot comparison (first 50 page pairs) |
| `--label-a`, `--label-b` | Site A / Site B | names used in the report |
| `--delay <ms>` | 500 | minimum gap between requests to one host |
| `--timeout <ms>` | 20000 | per request |
| `--ignore-robots` | off | do not obey robots.txt |
| `--config <file.json>` | | settings merged over `src/config.js` |
| `--open` | | open the report when done |
| `--fail-on-diff` | | exit code 3 if anything differs (for CI) |

## Configuration

All settings live in **`src/config.js`**, with comments. They cover:
- the page limit, rate limit, timeouts, and robots.txt
- rendering and visual thresholds
- ignore rules and output settings

The ignore rules are:

- `ignore.selectors` / `extraSelectors`: elements removed before comparing (cookie banners, chat widgets, anything with `data-sitediff-ignore`).
- `ignore.textPatterns` / `extraTextPatterns`: regexes masked in text. Mode `ignore` hides a difference entirely. Mode `cosmetic` still reports it, but as cosmetic. Plain dates and `hh:mm` times are cosmetic by default, since an event date or opening-hours change can be real content.
- `ignore.trackingParams`, `ignore.urlPatterns`, `ignore.imageNamePatterns`, `ignore.skipCategories`.

To keep your changes outside the code, copy `sitediff.config.example.json` and pass it with `--config`.

## Reading the report

1. **Summary tiles:** pages compared, identical, same content apart from site-wide differences, with page differences, only on A, only on B, failed to load.
2. **Filters:** by significance, category, and path, plus expand/collapse.
3. **Pages at a glance:** one row per page, most serious first.
4. **Site-wide differences:** nav, header and footer changes, each shown once with the pages it affects.
5. **Per-page details:** grouped by category, with A and B side by side and word-level highlighting.

Significance levels:

| Level | Meaning |
|---|---|
| **Error** | a page or link fails to load (4xx/5xx, timeout, broken link) |
| **Missing** | on A, not on B |
| **Changed** | on both, with different content |
| **Added** | on B, not on A |
| **Structural** | same content, different structure, order or URL |
| **Cosmetic** | case, punctuation, dates, or small visual shifts |

## Code layout

```
src/config.js     every setting and ignore rule (start here)
src/cli.js        command line
src/index.js      orchestration: render decision -> crawl -> pair -> compare -> report
src/fetcher.js    HTTP (rate limit, robots.txt, retries, redirects) and Playwright rendering/screenshots
src/crawler.js    bounded breadth-first crawl + direct "probe" requests
src/extract.js    HTML -> snapshot (text blocks, headings, links, images, forms, CTAs, metadata)
src/normalize.js  whitespace/typography normalisation and ignore-pattern masking
src/pairing.js    matching pages between sites (path, redirect, URL variant, content similarity)
src/compare.js    per-category comparison, significance, site-wide consolidation
src/visual.js     screenshot pixel diff
src/report.js     HTML + JSON report
demo/             two small sites with planted differences (used by the demo and tests)
test/             node:test unit and integration tests
```

## Notes and limits

- Pages behind a login, and content that only appears after interaction (tabs, "load more"), are not compared.
- In `auto` mode, if either home page looks JavaScript-rendered, both sites are rendered for consistency. Individual JavaScript pages are detected too.
- Visual comparison covers the top 6000 px at 1280 px wide. It is a supplement to the content comparison, not a substitute, and animated or personalised content can add noise. Use `visual.hideSelectors` to hide it.
- If B hard-codes links to A's domain, they are reported as "Link now points to the other site's domain".
