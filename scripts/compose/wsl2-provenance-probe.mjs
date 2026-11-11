import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';

// Credential-free path diagnostic only. No TLS, application proxy, or allow/deny policy.
export function createProvenanceProbe(
  record = (value) => process.stdout.write(`${JSON.stringify(value)}\n`),
) {
  const server = createServer((request, response) => {
    const match = /^\/probe\/([a-z0-9-]{1,48})$/.exec(request.url ?? '');
    if (request.method !== 'GET' || !match) {
      response.writeHead(400, { Connection: 'close' });
      response.end();
      return;
    }
    record({
      synthetic: true,
      caseId: match[1],
      time: new Date().toISOString(),
      family: request.socket.remoteFamily,
      remoteAddress: request.socket.remoteAddress,
      remotePort: request.socket.remotePort,
      localAddress: request.socket.localAddress,
      localPort: request.socket.localPort,
    });
    response.writeHead(200, { 'Content-Type': 'text/plain', Connection: 'close' });
    response.end('Omnis OS synthetic path diagnostic; no security acceptance\n');
  });
  server.maxHeadersCount = 32;
  server.maxRequestsPerSocket = 1;
  server.requestTimeout = 3000;
  server.headersTimeout = 3000;
  server.timeout = 3000;
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = createProvenanceProbe();
  server.listen(18080, '::');
  const stop = () => server.close(() => process.exit(0));
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
}
