const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const HOST = '127.0.0.1';
const PORT = 8080;

const MIME_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
};

// One stat instead of up to four. The handler called existsSync + statSync
// twice over, so every request did four synchronous filesystem round-trips on
// the event loop — and the loop is the whole server. Under parallel workers
// that serialised every asset fetch behind every other one.
function statOrNull(filePath) {
  try {
    return fs.statSync(filePath);
  } catch {
    return null;
  }
}

module.exports = async function startStaticTestServer() {
  const root = path.resolve(__dirname, '..');
  const server = http.createServer((request, response) => {
    try {
      const requestUrl = new URL(request.url || '/', `http://${HOST}:${PORT}`);
      const decodedPath = decodeURIComponent(requestUrl.pathname);
      let filePath = path.resolve(root, `.${decodedPath}`);

      if (!filePath.startsWith(`${root}${path.sep}`) && filePath !== root) {
        response.writeHead(403).end();
        return;
      }
      let stats = statOrNull(filePath);
      if (stats && stats.isDirectory()) {
        filePath = path.join(filePath, 'index.html');
        stats = statOrNull(filePath);
      }
      if (!stats || !stats.isFile()) {
        response.writeHead(404).end();
        return;
      }

      const contentType =
        MIME_TYPES[path.extname(filePath).toLowerCase()] ||
        'application/octet-stream';
      response.writeHead(200, {
        'Content-Type': contentType,
        'Cache-Control': 'no-store',
      });
      if (request.method === 'HEAD') {
        response.end();
      } else {
        fs.createReadStream(filePath).pipe(response);
      }
    } catch {
      response.writeHead(400).end();
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(PORT, HOST, resolve);
  });

  return async () => {
    await new Promise((resolve, reject) => {
      server.close(error => (error ? reject(error) : resolve()));
    });
  };
};
