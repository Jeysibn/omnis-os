import { createReadStream, statSync } from 'node:fs';
import {
  createServer,
  request as requestUpstream,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type ServerResponse,
} from 'node:http';
import process from 'node:process';
import path from 'node:path';
import { fileURLToPath, URL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'dist');
const apiUrl = new URL(process.env.OMNIS_API_URL ?? 'http://api:4100');
if (apiUrl.protocol !== 'http:' || apiUrl.hostname !== 'api' || apiUrl.port !== '4100') {
  throw new Error('The Omnis web gateway requires the private Compose API service endpoint.');
}
const port = Number(process.env.OMNIS_WEB_PORT ?? 8080);
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error('OMNIS_WEB_PORT must be a valid TCP port.');

const contentTypes = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.ico', 'image/x-icon'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml'],
  ['.webmanifest', 'application/manifest+json'],
  ['.woff2', 'font/woff2'],
]);
const forwardedRequestHeaders = [
  'accept',
  'cache-control',
  'content-length',
  'content-type',
  'cookie',
  'idempotency-key',
  'last-event-id',
  'origin',
  'x-omnis-csrf',
];
const forwardedResponseHeaders = [
  'cache-control',
  'content-type',
  'set-cookie',
  'www-authenticate',
];

const server = createServer((incoming: IncomingMessage, response: ServerResponse) => {
  const requestUrl = new URL(incoming.url ?? '/', 'http://omnis.local');
  if (requestUrl.pathname === '/health') {
    response.writeHead(200, {
      'cache-control': 'no-store',
      'content-type': 'application/json; charset=utf-8',
      'x-content-type-options': 'nosniff',
    });
    response.end(JSON.stringify({ status: 'ok', product: 'Omnis OS' }));
    return;
  }

  if (requestUrl.pathname.startsWith('/api/')) {
    proxyApiRequest(incoming, response, requestUrl);
    return;
  }

  if (incoming.method !== 'GET' && incoming.method !== 'HEAD') {
    response.writeHead(405, { allow: 'GET, HEAD', 'content-length': '0' }).end();
    return;
  }

  serveStatic(requestUrl.pathname, incoming.method === 'HEAD', response);
});

server.requestTimeout = 30_000;
server.headersTimeout = 10_000;
server.keepAliveTimeout = 5_000;
server.listen(port, '0.0.0.0');

function proxyApiRequest(
  incoming: IncomingMessage,
  response: ServerResponse,
  requestUrl: URL,
): void {
  const headers: OutgoingHttpHeaders = {};
  for (const name of forwardedRequestHeaders) {
    const value = incoming.headers[name];
    if (value !== undefined) headers[name] = value;
  }
  const upstream = requestUpstream(
    {
      hostname: apiUrl.hostname,
      port: apiUrl.port,
      method: incoming.method,
      path: `${requestUrl.pathname}${requestUrl.search}`,
      headers,
      timeout: 0,
    },
    (upstreamResponse) => {
      const responseHeaders: OutgoingHttpHeaders = { 'x-content-type-options': 'nosniff' };
      for (const name of forwardedResponseHeaders) {
        const value = upstreamResponse.headers[name];
        if (value !== undefined) responseHeaders[name] = value;
      }
      response.writeHead(upstreamResponse.statusCode ?? 502, responseHeaders);
      upstreamResponse.pipe(response);
    },
  );
  upstream.on('timeout', () => upstream.destroy(new Error('upstream_timeout')));
  upstream.on('error', () => {
    if (response.headersSent) response.destroy();
    else response.writeHead(502, { 'cache-control': 'no-store', 'content-length': '0' }).end();
  });
  incoming.on('aborted', () => upstream.destroy());
  response.on('close', () => {
    if (!response.writableEnded) upstream.destroy();
  });
  incoming.pipe(upstream);
}

function serveStatic(requestPath: string, headOnly: boolean, response: ServerResponse): void {
  let decodedPath;
  try {
    decodedPath = decodeURIComponent(requestPath);
  } catch {
    response.writeHead(400, { 'content-length': '0' }).end();
    return;
  }
  if (decodedPath.split(/[\\/]+/).includes('..')) {
    response.writeHead(404, { 'content-length': '0' }).end();
    return;
  }
  const normalized = path.posix.normalize(`/${decodedPath.replaceAll('\\', '/')}`);
  let target = path.resolve(root, `.${normalized}`);
  if (target === root) target = path.join(root, 'index.html');
  if (!target.startsWith(`${root}${path.sep}`) && target !== path.join(root, 'index.html')) {
    response.writeHead(404, { 'content-length': '0' }).end();
    return;
  }
  try {
    if (!statSync(target).isFile()) throw new Error('not_file');
  } catch {
    target = path.join(root, 'index.html');
  }
  let stat;
  try {
    stat = statSync(target);
  } catch {
    response.writeHead(404, { 'content-length': '0' }).end();
    return;
  }
  const immutable = /[.-][a-f0-9]{8,}[.-]/i.test(path.basename(target));
  response.writeHead(200, {
    'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
    'content-length': stat.size,
    'content-type': contentTypes.get(path.extname(target)) ?? 'application/octet-stream',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer',
  });
  if (headOnly) response.end();
  else createReadStream(target).pipe(response);
}
