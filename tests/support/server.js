'use strict';
// Minimal static file server for the sample and test pages.
// Pages must be served over http(s): opened from file:// their blob URLs get an
// opaque origin (blob:null/...), which content-script origin matching cannot map.

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
};

function createServer() {
  return http.createServer((req, res) => {
    const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    const filePath = path.resolve(ROOT, '.' + (urlPath === '/' ? '/index.html' : urlPath));
    if (!filePath.startsWith(ROOT + path.sep) || filePath.includes(`${path.sep}node_modules${path.sep}`)) {
      res.writeHead(403).end('forbidden');
      return;
    }
    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(404).end('not found');
        return;
      }
      res.writeHead(200, {
        'content-type': TYPES[path.extname(filePath)] || 'application/octet-stream',
        'cache-control': 'no-store',
      });
      res.end(data);
    });
  });
}

/** Starts the server on an ephemeral port (or `port`) and resolves to { server, origin }. */
function start(port = 0) {
  return new Promise((resolve) => {
    const server = createServer();
    server.listen(port, '127.0.0.1', () => {
      resolve({ server, origin: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

module.exports = { start, ROOT };

if (require.main === module) {
  const port = Number(process.env.PORT || 8080);
  start(port).then(({ origin }) => {
    console.log(`Serving ${ROOT} at ${origin}`);
    console.log(`  malicious sample: ${origin}/malicious.html`);
    console.log(`  benign sample:    ${origin}/benign.html`);
    console.log(`  all test pages:   ${origin}/test-pages/`);
  });
}
