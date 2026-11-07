import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import type { IncomingMessage } from 'node:http';
import { describe, it } from 'node:test';
import { readBoundedResponse } from './bounded-http-response.ts';

describe('bounded HTTP response reader', () => {
  it('rejects oversized responses through the normal promise error path', async () => {
    const stream = new PassThrough();
    const response = stream as unknown as IncomingMessage;
    const body = readBoundedResponse(response, 4, 'response exceeds test limit');
    stream.end(Buffer.from('oversized'));
    await assert.rejects(body, /response exceeds test limit/);
  });
});
