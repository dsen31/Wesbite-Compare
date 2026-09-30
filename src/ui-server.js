#!/usr/bin/env node
/**
 * Local web UI: a page where you enter two URLs, watch the comparison run, and
 * read the report. Also lists earlier runs from the reports folder.
 *
 *   npm run ui                      (opens http://localhost:3000)
 *   node src/ui-server.js --port 4000 --config my-settings.json --no-open
 *
 * The server listens on 127.0.0.1 only. One comparison runs at a time.
 *
 * HTTP API (used by src/ui/index.html):
 *   GET  /                          the UI page
 *   GET  /api/runs                  { current, runs[] }  current run + past runs on disk
 *   POST /api/runs                  start a run  { urlA, urlB, labelA, labelB, maxPages, render, visual, respectRobots }
 *   GET  /api/runs/:id/events       Server-Sent Events: log / progress / done / failed
 *   POST /api/runs/:id/stop         stop early (a report is still written)
 *   POST /api/demo                  start the bundled demo sites, returns their URLs
 *   GET  /reports/:id/...           report files
 */
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { parseArgs } from 'node:util';
import { buildConfig } from './config.js';
import { runComparison, runFolderName } from './index.js';
import { createScope } from './url-utils.js';
import { startStaticServer } from './demo-server.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TYPES = { '.html': 'text/html; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.css': 'text/css', '.js': 'text/javascript' };
const MAX_LOG_LINES = 3000;

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

async function readJson(req) {
  let size = 0; const chunks = [];
  for await (const c of req) { size += c.length; if (size > 20000) throw new Error('Request too large'); chunks.push(c); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

/** Validate the form input and turn it into config overrides. Throws a readable message. */
function parseRunRequest(body) {
  const url = (v, which) => {
    const s = String(v ?? '').trim();
    if (!s) throw new Error(`Site ${which}: enter a web address`);
    // "example.com" is accepted and treated as https://example.com
    let u;
    try { u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `https://${s}`); } catch { throw new Error(`Site ${which}: "${s}" is not a valid web address`); }
    if (!/^https?:$/.test(u.protocol) || !u.hostname.includes('.') && u.hostname !== 'localhost' && !/^\d+\.\d+\.\d+\.\d+$/.test(u.hostname)) {
      throw new Error(`Site ${which}: "${s}" is not a valid web address`);
    }
    return u.href;
  };
  const urlA = url(body.urlA, 'A'), urlB = url(body.urlB, 'B');
  const maxPages = Number(body.maxPages ?? 100);
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 5000) throw new Error('Pages per site must be a whole number from 1 to 5000');
  const render = body.render ?? 'auto';
  if (!['auto', 'always', 'never'].includes(render)) throw new Error('Rendering must be auto, always or never');
  const label = (v, d) => String(v ?? '').trim().slice(0, 40) || d;
  return {
    urlA, urlB,
    overrides: {
      crawl: { maxPages },
      render: { mode: render },
      visual: { enabled: !!body.visual },
      http: { respectRobotsTxt: body.respectRobots !== false },
      output: { labelA: label(body.labelA, 'Site A'), labelB: label(body.labelB, 'Site B') },
    },
  };
}

async function listRuns(reportsDir) {
  let names = [];
  try { names = await fs.readdir(reportsDir, { withFileTypes: true }); } catch { return []; }
  const runs = [];
  for (const d of names) {
    if (!d.isDirectory()) continue;
    try {
      const r = JSON.parse(await fs.readFile(path.join(reportsDir, d.name, 'report.json'), 'utf8'));
      runs.push({
        id: d.name, generatedAt: r.generatedAt, durationSec: r.durationSec,
        siteA: { label: r.sites.A.label, url: r.sites.A.url }, siteB: { label: r.sites.B.label, url: r.sites.B.url },
        summary: r.summary, stopped: r.notes.some((n) => /stopped early/.test(n)),
      });
    } catch { /* not a report folder */ }
  }
  return runs.sort((a, b) => String(b.generatedAt).localeCompare(String(a.generatedAt))).slice(0, 100);
}

export async function startUiServer({ port = 3000, host = '127.0.0.1', configOverrides = {}, reportsDir, log = () => {} } = {}) {
  const baseCfg = buildConfig(configOverrides);
  reportsDir = path.resolve(reportsDir ?? baseCfg.output.dir);
  const runs = new Map();       // id -> run state (this server session)
  let current = null;           // the run in progress, if any
  let demo = null;              // lazily started demo sites

  const publicRun = (r) => r && { id: r.id, status: r.status, urlA: r.urlA, urlB: r.urlB, labelA: r.labelA, labelB: r.labelB, progress: r.progress, phase: r.phase, summary: r.summary, error: r.error };

  function emit(run, event, data) {
    const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of run.clients) res.write(msg);
  }

  function onLog(run, line) {
    run.lines.push(line);
    if (run.lines.length > MAX_LOG_LINES) run.lines.splice(0, run.lines.length - MAX_LOG_LINES);
    const m = /^\[(A|B)\] (\d+)\/(\d+) /.exec(line);
    if (m) { run.progress[m[1]] = { n: Number(m[2]), max: Number(m[3]) }; run.phase = 'Crawling both sites'; }
    else if (/\] probe /.test(line)) run.phase = 'Checking pages found on one site only';
    else if (/^Visual compare/.test(line)) run.phase = 'Comparing screenshots';
    else if (/^Render mode/.test(line)) run.phase = 'Crawling both sites';
    emit(run, 'log', { line, progress: run.progress, phase: run.phase });
  }

  async function startRun(body) {
    const { urlA, urlB, overrides } = parseRunRequest(body);
    // The bundled demo sites are local, so there is no need to be slow and polite with them.
    if (demo && [demo.a.url, demo.b.url].some((u) => urlA.startsWith(u) || urlB.startsWith(u))) overrides.http.delayMs = 20;
    const probeCfg = buildConfig(configOverrides, overrides);
    let id = runFolderName(createScope(urlA, probeCfg), createScope(urlB, probeCfg));
    for (let i = 2; runs.has(id) || (await fs.stat(path.join(reportsDir, id)).then(() => true, () => false)); i++) id = id.replace(/(-\d+)?$/, `-${i}`);
    const cfg = buildConfig(configOverrides, overrides, { output: { dir: path.join(reportsDir, id), subfolderPerRun: false } });
    const run = {
      id, urlA, urlB, labelA: cfg.output.labelA, labelB: cfg.output.labelB, status: 'running', phase: 'Starting',
      progress: { A: { n: 0, max: cfg.crawl.maxPages }, B: { n: 0, max: cfg.crawl.maxPages } },
      lines: [], clients: new Set(), controller: new AbortController(), summary: null, error: null,
    };
    runs.set(id, run);
    current = run;
    log(`Run ${id}: ${urlA} vs ${urlB}`);
    runComparison({ urlA, urlB, cfg, log: (l) => onLog(run, l), signal: run.controller.signal })
      .then(({ result }) => {
        run.status = run.controller.signal.aborted ? 'stopped' : 'done';
        run.summary = result.summary;
        run.phase = run.status === 'stopped' ? 'Stopped early' : 'Finished';
        emit(run, 'done', publicRun(run));
      })
      .catch((err) => {
        run.status = 'failed';
        run.error = String(err.message || err);
        run.phase = 'Failed';
        onLog(run, `ERROR: ${run.error}`);
        emit(run, 'failed', publicRun(run));
      })
      .finally(() => {
        if (current === run) current = null;
        for (const res of run.clients) res.end();
        run.clients.clear();
        log(`Run ${id}: ${run.status}`);
      });
    return run;
  }

  async function serveReportFile(res, rel) {
    const file = path.resolve(reportsDir, rel);
    if (!file.startsWith(reportsDir + path.sep)) return send(res, 403, { error: 'Forbidden' });
    try {
      const body = await fs.readFile(file);
      send(res, 200, body, TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream');
    } catch { send(res, 404, 'Not found', 'text/plain'); }
  }

  const server = http.createServer(async (req, res) => {
    try {
      // Only answer requests addressed to this machine (blocks DNS-rebinding tricks from web pages).
      const hostHeader = (req.headers.host || '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
      if (!['localhost', '127.0.0.1', '::1'].includes(hostHeader)) return send(res, 403, { error: 'Forbidden host' });
      const url = new URL(req.url, 'http://localhost');
      const p = decodeURIComponent(url.pathname);
      if (req.method === 'POST' && !(req.headers['content-type'] || '').includes('application/json')) {
        return send(res, 415, { error: 'Expected JSON' });
      }

      if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
        return send(res, 200, await fs.readFile(path.join(HERE, 'ui', 'index.html')), TYPES['.html']);
      }
      if (req.method === 'GET' && p === '/api/runs') {
        return send(res, 200, { current: publicRun(current), runs: await listRuns(reportsDir) });
      }
      if (req.method === 'POST' && p === '/api/runs') {
        if (current) return send(res, 409, { error: 'A comparison is already running. Stop it or wait for it to finish.' });
        let body;
        try { body = await readJson(req); } catch { return send(res, 400, { error: 'Invalid request' }); }
        try { return send(res, 202, publicRun(await startRun(body))); } catch (e) { return send(res, 400, { error: e.message }); }
      }
      let m;
      if (req.method === 'GET' && (m = /^\/api\/runs\/([^/]+)\/events$/.exec(p))) {
        const run = runs.get(m[1]);
        if (!run) return send(res, 404, { error: 'Unknown run' });
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
        res.write(`event: state\ndata: ${JSON.stringify({ ...publicRun(run), lines: run.lines.slice(-500) })}\n\n`);
        if (run.status !== 'running') { res.write(`event: ${run.status === 'failed' ? 'failed' : 'done'}\ndata: ${JSON.stringify(publicRun(run))}\n\n`); return res.end(); }
        run.clients.add(res);
        req.on('close', () => run.clients.delete(res));
        return;
      }
      if (req.method === 'POST' && (m = /^\/api\/runs\/([^/]+)\/stop$/.exec(p))) {
        const run = runs.get(m[1]);
        if (!run || run.status !== 'running') return send(res, 404, { error: 'No such running comparison' });
        run.controller.abort();
        run.phase = 'Stopping: finishing the current request, then writing the report';
        emit(run, 'log', { line: 'Stop requested', progress: run.progress, phase: run.phase });
        return send(res, 200, publicRun(run));
      }
      if (req.method === 'POST' && p === '/api/demo') {
        if (!demo) {
          const dir = path.join(HERE, '..', 'demo');
          demo = { a: await startStaticServer(path.join(dir, 'site-a')), b: await startStaticServer(path.join(dir, 'site-b')) };
        }
        return send(res, 200, { urlA: demo.a.url, urlB: demo.b.url, labelA: 'Live', labelB: 'Redesign' });
      }
      if (req.method === 'GET' && p.startsWith('/reports/')) return serveReportFile(res, p.slice('/reports/'.length));
      send(res, 404, { error: 'Not found' });
    } catch (err) {
      if (!res.headersSent) send(res, 500, { error: String(err.message || err) });
      else res.end();
    }
  });

  // Use the requested port, or the next free one.
  let bound = port;
  for (let attempt = 0; ; attempt++) {
    try {
      await new Promise((ok, fail) => { server.once('error', fail); server.listen(bound, host, () => { server.off('error', fail); ok(); }); });
      break;
    } catch (e) {
      if (e.code !== 'EADDRINUSE' || attempt >= 20 || port === 0) throw e;
      bound++;
    }
  }
  const address = `http://localhost:${server.address().port}/`;
  return {
    url: address,
    reportsDir,
    close: async () => {
      for (const r of runs.values()) r.controller.abort();
      if (demo) { await demo.a.close(); await demo.b.close(); }
      server.closeAllConnections?.();
      await new Promise((ok) => server.close(ok));
    },
  };
}

function openBrowser(url) {
  const [cmd, args] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', url]]
    : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref();
}

// Run directly: node src/ui-server.js
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values: o } = parseArgs({ options: { port: { type: 'string' }, config: { type: 'string' }, 'no-open': { type: 'boolean' } } });
  let configOverrides = {};
  if (o.config) configOverrides = JSON.parse(await fs.readFile(o.config, 'utf8'));
  const ui = await startUiServer({ port: o.port ? Number(o.port) : 3000, configOverrides, log: (m) => console.log(m) });
  console.log(`SiteDiff UI running at ${ui.url}  (reports in ${ui.reportsDir})`);
  console.log('Press Ctrl+C to stop.');
  if (!o['no-open']) openBrowser(ui.url);
  process.on('SIGINT', async () => { await ui.close(); process.exit(0); });
}
