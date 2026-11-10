import { execFileSync } from 'node:child_process';
import { release } from 'node:os';
import { pathToFileURL } from 'node:url';

// Only fixed metadata commands: never collect env, Compose config, inspect, or service logs.
export function collectPreflight({ run = execFileSync, kernel = release() } = {}) {
  const probe = (command, args, pattern) => {
    try {
      const value = run(command, args, {
        encoding: 'utf8',
        timeout: 5000,
        maxBuffer: 4096,
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim();
      return pattern.test(value) ? value : null;
    } catch {
      // Child errors can contain credentials or host paths. Never serialize them.
      return null;
    }
  };
  const version = /^v?\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/;
  return {
    schemaVersion: 1,
    commit: probe('git', ['rev-parse', 'HEAD'], /^[a-f0-9]{40}$/),
    trackedTreeClean: probe('git', ['diff', 'HEAD', '--quiet'], /^$/) === '',
    wsl2KernelDetected: /microsoft.*wsl2/i.test(kernel),
    dockerClient: probe('docker', ['version', '--format', '{{.Client.Version}}'], version),
    dockerServer: probe('docker', ['version', '--format', '{{.Server.Version}}'], version),
    compose: probe('docker', ['compose', 'version', '--short'], version),
    verdict: 'BLOCKED',
    blockers: [
      'ADR-0012 ingress discriminator and independent design approval are unresolved.',
      'Current Compose is hybrid; version inventory does not verify runtime isolation.',
    ],
    targetHostVerification: 'NOT TESTED',
    independentReview: 'NOT TESTED',
    ownerApproval: 'BLOCKED',
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.stdout.write(`${JSON.stringify(collectPreflight(), null, 2)}\n`);
  process.exitCode = 2;
}
