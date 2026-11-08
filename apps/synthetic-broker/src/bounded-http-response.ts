import type { IncomingMessage } from 'node:http';

export function readBoundedResponse(
  response: IncomingMessage,
  maxBytes: number,
  tooLargeMessage: string,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    response.on('error', reject);
    response.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        response.destroy(new Error(tooLargeMessage));
        return;
      }
      chunks.push(chunk);
    });
    response.on('end', () => resolve(Buffer.concat(chunks)));
  });
}
