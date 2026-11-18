import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';
import { fileURLToPath, URL } from 'node:url';

const repository = fileURLToPath(new URL('../../', import.meta.url));

export async function privateArchivePath(path) {
  if (!isAbsolute(path) || !basename(path).endsWith('.dump')) {
    throw new Error('Supply an absolute path to a private .dump archive.');
  }
  const parent = await realpath(dirname(path));
  const location = relative(repository, parent);
  const info = await lstat(parent);
  if (
    (!location.startsWith('../') && location !== '..' && !isAbsolute(location)) ||
    !info.isDirectory() ||
    info.uid !== process.getuid() ||
    (info.mode & 0o077) !== 0
  ) {
    throw new Error('The archive directory must be owner-private and outside the repository.');
  }
  return join(parent, basename(path));
}

export async function readPrivateFile(path, operation) {
  const descriptor = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const info = await descriptor.stat();
    if (!info.isFile() || info.uid !== process.getuid() || (info.mode & 0o077) !== 0) {
      throw new Error('Archive and manifest must be private owner-owned regular files.');
    }
    return await operation(descriptor, info);
  } finally {
    await descriptor.close();
  }
}

export async function sha256(descriptor) {
  const hash = createHash('sha256');
  for await (const chunk of descriptor.createReadStream({ start: 0, autoClose: false })) {
    hash.update(chunk);
  }
  return hash.digest('hex');
}

export async function archiveDigest(descriptor, size) {
  const magic = Buffer.alloc(5);
  await descriptor.read(magic, 0, 5, 0);
  if (magic.toString('ascii') !== 'PGDMP') throw new Error('Expected a PostgreSQL custom archive.');
  return { dumpBytes: size, dumpSha256: await sha256(descriptor) };
}

export function manifestDigest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}
