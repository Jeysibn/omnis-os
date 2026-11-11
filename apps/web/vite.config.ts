import { realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const forbiddenRoot = path.resolve(repositoryRoot, 'scripts/mission9d/stage2a-simulated');

function stage2aProductionExclusion(): Plugin {
  return {
    name: 'omnis-stage2a-production-exclusion',
    apply: 'build',
    generateBundle() {
      const offenders = [...this.getModuleIds()].filter((id) => {
        const file = id.split('?')[0];
        if (!file || !path.isAbsolute(file)) return false;
        let resolved = path.resolve(file);
        try {
          resolved = realpathSync.native(resolved);
        } catch {
          return false;
        }
        return resolved === forbiddenRoot || resolved.startsWith(`${forbiddenRoot}${path.sep}`);
      });
      if (offenders.length) {
        this.error(
          `Stage 2A synthetic modules entered the production bundle: ${offenders.join(', ')}`,
        );
      }
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), stage2aProductionExclusion()],
  server: {
    proxy: { '/api': 'http://127.0.0.1:4100' },
  },
});
