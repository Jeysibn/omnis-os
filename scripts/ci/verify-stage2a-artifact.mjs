import { verifyArtifactRoots } from './verify-stage2a-exclusion.mjs';

try {
  const count = verifyArtifactRoots(process.argv.slice(2));
  process.stdout.write(`Stage 2A artifact exclusion passed: ${count} artifact entries\n`);
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.message : 'production artifact verification failed'}\n`,
  );
  process.exitCode = 1;
}
