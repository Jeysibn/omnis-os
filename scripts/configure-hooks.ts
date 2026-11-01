import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

if (existsSync('.git')) {
  execFileSync('git', ['config', 'core.hooksPath', '.githooks'], { stdio: 'ignore' });
}
