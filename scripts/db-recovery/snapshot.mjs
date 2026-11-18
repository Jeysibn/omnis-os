import { once } from 'node:events';

export async function startSnapshotExport(child, guard = '') {
  let stderr = '';
  child.stdin.on('error', () => undefined);
  child.stderr?.on('data', (chunk) => {
    if (stderr.length < 2_000) stderr += chunk.toString('utf8');
  });
  const closed = once(child, 'close');
  child.stdin.write(
    `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;\n${guard}\nSELECT pg_export_snapshot();\n`,
  );
  const snapshot = await new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('Timed out creating a PostgreSQL backup snapshot.'));
    }, 10_000);
    child.stdout.on('data', (chunk) => {
      output += chunk.toString('utf8');
      const candidate = output
        .split(/\r?\n/)
        .find((line) => /^[0-9A-F]+-[0-9A-F]+-[0-9A-F]+$/i.test(line.trim()));
      if (candidate) {
        clearTimeout(timer);
        resolve(candidate.trim());
      }
    });
    function failed(code) {
      clearTimeout(timer);
      reject(
        new Error(
          `PostgreSQL snapshot export failed with exit code ${code ?? 'unknown'} (${stderr.length ? 'details redacted' : 'no details'}).`,
        ),
      );
    }
    closed.then(
      ([code]) => failed(code),
      () => failed(undefined),
    );
  });
  return { child, closed, snapshot };
}

export async function finishSnapshotExport(exporter) {
  if (exporter.child.exitCode === null && exporter.child.signalCode === null) {
    exporter.child.stdin.end('COMMIT;\n\\q\n');
  }
  const [code] = await exporter.closed;
  if (code !== 0) throw new Error('Could not close the PostgreSQL snapshot transaction cleanly.');
}
