#!/usr/bin/env node
/**
 * Command line entry point.
 *
 *   node src/cli.js <urlA> <urlB> [options]
 *   node src/cli.js demo [options]        compare the two bundled demo sites
 */
import { parseArgs } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { buildConfig } from './config.js';
import { runComparison } from './index.js';
import { startStaticServer } from './demo-server.js';

const HELP = `SiteDiff: compare two websites and write an HTML report of every difference.

Usage:
  node src/cli.js <urlA> <urlB> [options]
  node src/cli.js demo [options]          run against the bundled demo sites

A is the baseline (e.g. the live site), B the candidate (e.g. the redesign).

Options:
  --max-pages <n>        pages to crawl per site (default 100)
  --out <dir>            output folder (default ./reports, one sub-folder per run)
  --render <mode>        auto | always | never   (default auto: headless browser when a page needs JavaScript)
  --visual               also compare screenshots (needs Chromium: npx playwright install chromium)
  --label-a <text>       name for site A in the report (default "Site A")
  --label-b <text>       name for site B in the report (default "Site B")
  --delay <ms>           minimum gap between requests to one host (default 500)
  --timeout <ms>         per-request timeout (default 20000)
  --ignore-robots        do not obey robots.txt
  --config <file.json>   settings to merge over src/config.js (ignore rules etc.)
  --open                 open the report in your browser when done
  --fail-on-diff         exit with code 3 if any difference is found (for CI)
  --quiet                only print the summary
  -h, --help             show this help

Example:
  node src/cli.js https://www.example.com https://staging.example.com --label-a Live --label-b Staging --open
`;

function openFile(p) {
  const abs = path.resolve(p);
  const [cmd, args] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', `"${abs}"`]]
    : process.platform === 'darwin' ? ['open', [abs]] : ['xdg-open', [abs]];
  spawn(cmd, args, { detached: true, stdio: 'ignore', shell: process.platform === 'win32' }).unref();
}

async function main() {
  let parsed;
  try {
    parsed = parseArgs({
      allowPositionals: true,
      options: {
        'max-pages': { type: 'string' }, out: { type: 'string' }, render: { type: 'string' }, visual: { type: 'boolean' },
        'label-a': { type: 'string' }, 'label-b': { type: 'string' }, delay: { type: 'string' }, timeout: { type: 'string' },
        'ignore-robots': { type: 'boolean' }, config: { type: 'string' }, open: { type: 'boolean' },
        'fail-on-diff': { type: 'boolean' }, quiet: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
      },
    });
  } catch (e) {
    console.error(e.message + '\n\n' + HELP);
    return 2;
  }
  const { values: o, positionals } = parsed;
  const isDemo = positionals[0] === 'demo';
  if (o.help || (!isDemo && positionals.length !== 2)) {
    console.log(HELP);
    return o.help ? 0 : 2;
  }

  // Settings: defaults (config.js) <- --config file <- command-line flags.
  let fileCfg = {};
  if (o.config) {
    try { fileCfg = JSON.parse(await fs.readFile(o.config, 'utf8')); } catch (e) { console.error(`Cannot read --config ${o.config}: ${e.message}`); return 2; }
  }
  const num = (v, name) => {
    if (v === undefined) return undefined;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) throw new Error(`--${name} must be a non-negative number`);
    return n;
  };
  const cli = { crawl: {}, http: {}, render: {}, visual: {}, output: {} };
  try {
    if (o['max-pages']) cli.crawl.maxPages = num(o['max-pages'], 'max-pages');
    if (o.delay) cli.http.delayMs = num(o.delay, 'delay');
    if (o.timeout) cli.http.timeoutMs = num(o.timeout, 'timeout');
  } catch (e) { console.error(e.message); return 2; }
  if (o['ignore-robots']) cli.http.respectRobotsTxt = false;
  if (o.render) {
    if (!['auto', 'always', 'never'].includes(o.render)) { console.error('--render must be auto, always or never'); return 2; }
    cli.render.mode = o.render;
  }
  if (o.visual) cli.visual.enabled = true;
  if (o.out) cli.output.dir = o.out;
  if (o['label-a']) cli.output.labelA = o['label-a'];
  if (o['label-b']) cli.output.labelB = o['label-b'];

  let urlA, urlB, servers = [];
  const demoCfg = {};
  if (isDemo) {
    const demoDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'demo');
    servers = [await startStaticServer(path.join(demoDir, 'site-a')), await startStaticServer(path.join(demoDir, 'site-b'))];
    [urlA, urlB] = servers.map((s) => s.url);
    Object.assign(demoCfg, { http: { delayMs: 20 }, output: { dir: 'reports/demo', subfolderPerRun: false, labelA: 'Live', labelB: 'Redesign' } });
    console.log(`Demo sites running at ${urlA} (A) and ${urlB} (B)`);
  } else {
    [urlA, urlB] = positionals;
    for (const u of [urlA, urlB]) {
      try { if (!/^https?:$/.test(new URL(u).protocol)) throw new Error(); } catch { console.error(`Not a valid http(s) URL: ${u}`); return 2; }
    }
  }
  const cfg = buildConfig(demoCfg, fileCfg, cli);
  const log = o.quiet ? () => {} : (m) => console.log(m);

  try {
    const { result, reportPath, jsonPath } = await runComparison({ urlA, urlB, cfg, log });
    const s = result.summary;
    console.log('\n' + [
      `Pages compared:      ${s.pagesCompared}`,
      `  identical:         ${s.identical}`,
      ...(s.siteWideOnly ? [`  site-wide only:    ${s.siteWideOnly}  (same content; nav/header/footer differences only)`] : []),
      `  with differences:  ${s.withDifferences}`,
      `Site-wide differences: ${s.siteWide}`,
      `Only on A (${cfg.output.labelA}):  ${s.onlyA}`,
      `Only on B (${cfg.output.labelB}):  ${s.onlyB}`,
      `Failed to load:      ${s.errors}`,
      `Differences:         ${s.totalDifferences} (${Object.entries(s.bySignificance).filter(([, n]) => n).map(([k, n]) => `${k} ${n}`).join(', ') || 'none'})`,
      ...result.notes.map((n) => `Note: ${n}`),
      '',
      `Report: ${path.resolve(reportPath)}`,
      jsonPath ? `JSON:   ${path.resolve(jsonPath)}` : '',
    ].filter((l) => l !== null).join('\n'));
    if (o.open) openFile(reportPath);
    if (o['fail-on-diff'] && (s.totalDifferences > 0)) return 3;
    return 0;
  } catch (e) {
    console.error(`\nComparison failed: ${e.stack || e.message}`);
    return 1;
  } finally {
    await Promise.all(servers.map((s) => s.close()));
  }
}

main().then((code) => { process.exitCode = code; });
