import { createHash } from 'node:crypto';

export * from './connector-authorization-schema.ts';

export function createRenderedRequestDigest(renderedRequest: string): string {
  return `sha256:${createHash('sha256')
    .update('omnis-os/rendered-connector-request/v1\0', 'utf8')
    .update(renderedRequest, 'utf8')
    .digest('hex')}`;
}
