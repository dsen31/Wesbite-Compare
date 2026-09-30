// Tests for the local web UI server (src/ui-server.js): page, run lifecycle, stop, safety checks.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startUiServer } from '../src/ui-server.js';

let ui, reportsDir;
const json = { 'content-type': 'application/json' };

before(async () => {
  reportsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sitediff-ui-'));
  ui = await startUiServer({ port: 0, reportsDir, configOverrides: { http: { delayMs: 0 } } });
});
after(async () => {
  await ui.close();
  await fs.rm(reportsDir, { recursive: true, force: true });
});

/** Read Server-Sent Events until a 'done' or 'failed' event arrives. */
async function waitForFinish(id) {
  const res = await fetch(`${ui.url}api/runs/${id}/events`);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '', logLines = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) throw new Error('event stream ended without a result');
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
      const event = /^event: (.*)$/m.exec(chunk)?.[1];
      const data = JSON.parse(/^data: (.*)$/m.exec(chunk)?.[1] ?? 'null');
      if (event === 'log') logLines++;
      if (event === 'done' || event === 'failed') { reader.cancel(); return { event, data, logLines }; }
    }
  }
}

test('serves the page with the comparison form', async () => {
  const html = await (await fetch(ui.url)).text();
  assert.match(html, /id="urlA"/);
  assert.match(html, /id="urlB"/);
  assert.match(html, />Compare</);
});

test('rejects bad input with a readable message', async () => {
  const res = await fetch(`${ui.url}api/runs`, { method: 'POST', headers: json, body: JSON.stringify({ urlA: '', urlB: 'https://example.com' }) });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /Site A: enter a web address/);
});

test('runs a comparison of the demo sites end to end and lists it afterwards', async () => {
  const demo = await (await fetch(`${ui.url}api/demo`, { method: 'POST', headers: json, body: '{}' })).json();
  const start = await fetch(`${ui.url}api/runs`, { method: 'POST', headers: json, body: JSON.stringify({ ...demo, render: 'never', maxPages: 50 }) });
  assert.equal(start.status, 202);
  const run = await start.json();

  // A second run while one is going is refused.
  const busy = await fetch(`${ui.url}api/runs`, { method: 'POST', headers: json, body: JSON.stringify({ ...demo, render: 'never' }) });
  assert.equal(busy.status, 409);

  const { event, data, logLines } = await waitForFinish(run.id);
  assert.equal(event, 'done');
  assert.equal(data.status, 'done');
  assert.equal(data.summary.onlyA, 1);
  assert.equal(data.summary.onlyB, 1);
  assert.ok(logLines > 5, 'progress was streamed');

  const report = await fetch(`${ui.url}reports/${run.id}/report.html`);
  assert.equal(report.status, 200);
  assert.match(await report.text(), /Website comparison/);

  const list = await (await fetch(`${ui.url}api/runs`)).json();
  assert.equal(list.current, null);
  assert.ok(list.runs.some((r) => r.id === run.id && r.siteA.label === 'Live'));
});

test('Stop ends a run early and still writes a report', async () => {
  const demo = await (await fetch(`${ui.url}api/demo`, { method: 'POST', headers: json, body: '{}' })).json();
  // Stop immediately after starting, before the crawl can finish.
  const run = await (await fetch(`${ui.url}api/runs`, { method: 'POST', headers: json, body: JSON.stringify({ ...demo, render: 'never' }) })).json();
  const stop = await fetch(`${ui.url}api/runs/${run.id}/stop`, { method: 'POST', headers: json, body: '{}' });
  assert.equal(stop.status, 200);
  const { data } = await waitForFinish(run.id);
  assert.equal(data.status, 'stopped');
  const saved = JSON.parse(await fs.readFile(path.join(reportsDir, run.id, 'report.json'), 'utf8'));
  assert.ok(saved.notes.some((n) => /stopped early/.test(n)));
});

test('refuses path traversal, foreign Host headers and non-JSON posts', async () => {
  const trav = await fetch(`${ui.url}reports/..%2F..%2Fpackage.json`);
  assert.ok([403, 404].includes(trav.status));
  const http = await import('node:http');
  const status = await new Promise((ok) => {
    const u = new URL(ui.url);
    http.get({ host: u.hostname, port: u.port, path: '/api/runs', headers: { host: 'evil.example' } }, (r) => { r.resume(); ok(r.statusCode); });
  });
  assert.equal(status, 403);
  const form = await fetch(`${ui.url}api/runs`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' });
  assert.equal(form.status, 415);
});
