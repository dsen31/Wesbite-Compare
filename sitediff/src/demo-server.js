/**
 * Tiny static file server for the demo sites and the tests.
 *   - "/x" serves x/index.html (or the file x itself)
 *   - _redirects.json in the site root maps paths to 301 redirects
 *   - missing files return 404 (using 404.html if present)
 */
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';

const TYPES = { '.html': 'text/html; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.xml': 'application/xml',
  '.css': 'text/css', '.js': 'text/javascript', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.pdf': 'application/pdf' };

export async function startStaticServer(root, { port = 0, host = '127.0.0.1' } = {}) {
  root = path.resolve(root);
  let redirects = {};
  try { redirects = JSON.parse(await fs.readFile(path.join(root, '_redirects.json'), 'utf8')); } catch { /* none */ }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    let p = decodeURIComponent(url.pathname);
    const r = redirects[p] ?? redirects[p.replace(/\/$/, '')];
    if (r) { res.writeHead(301, { location: r }); return res.end(); }
    const file = path.join(root, p);
    if (!file.startsWith(root)) { res.writeHead(403); return res.end(); }
    for (const cand of [file, path.join(file, 'index.html')]) {
      try {
        const st = await fs.stat(cand);
        if (!st.isFile()) continue;
        const body = await fs.readFile(cand);
        res.writeHead(200, { 'content-type': TYPES[path.extname(cand)] || 'application/octet-stream' });
        return res.end(body);
      } catch { /* try next */ }
    }
    const nf = await fs.readFile(path.join(root, '404.html')).catch(() => Buffer.from('<h1>Not found</h1>'));
    res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' });
    res.end(nf);
  });
  await new Promise((ok) => server.listen(port, host, ok));
  const url = `http://${host}:${server.address().port}/`;
  return { url, server, close: () => new Promise((ok) => { server.closeAllConnections?.(); server.close(ok); }) };
}
