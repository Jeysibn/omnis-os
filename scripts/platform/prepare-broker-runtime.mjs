import { cpSync, existsSync, lstatSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const [deployArgument, contractsArgument] = process.argv.slice(2);
if (process.argv.length !== 4) {
  throw new Error('Expected the fixed broker deploy and compiled contracts paths.');
}
const deployRoot = path.resolve(deployArgument);
const compiledContracts = path.resolve(contractsArgument);
if (deployRoot !== '/out/broker' || compiledContracts !== '/out/contracts') {
  throw new Error('Broker runtime packaging paths are outside the fixed image build workspace.');
}
for (const name of [
  'connector-authorization.js',
  'connector-broker.js',
  'broker-ipc.js',
  'index.js',
]) {
  if (!existsSync(path.join(compiledContracts, name)))
    throw new Error(`Compiled broker contract module is missing: ${name}`);
}

const contractPackage = path.join(deployRoot, 'node_modules/@omnis/contracts');
if (!lstatSync(contractPackage).isSymbolicLink() && !lstatSync(contractPackage).isDirectory()) {
  throw new Error('Deployed contracts package has an unexpected filesystem type.');
}
rmSync(contractPackage, { recursive: true, force: true });
const dist = path.join(contractPackage, 'dist');
mkdirSync(dist, { recursive: true });
cpSync(compiledContracts, dist, { recursive: true });
writeFileSync(
  path.join(contractPackage, 'package.json'),
  `${JSON.stringify(
    {
      name: '@omnis/contracts',
      private: true,
      type: 'module',
      exports: {
        '.': './dist/index.js',
        './connector-authorization': './dist/connector-authorization.js',
        './connector-broker': './dist/connector-broker.js',
        './broker-ipc': './dist/broker-ipc.js',
      },
    },
    null,
    2,
  )}\n`,
  { mode: 0o644 },
);
