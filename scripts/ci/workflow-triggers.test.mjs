import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import test from 'node:test';

const workflowDirectory = '.github/workflows';
const workflowFiles = readdirSync(workflowDirectory).filter(
  (file) => file.endsWith('.yml') || file.endsWith('.yaml'),
);
const workflowPath = `${workflowDirectory}/ci.yml`;
const workflow = readFileSync(workflowPath, 'utf8');
const ciWorkflowFiles = workflowFiles.filter((file) => {
  const source = readFileSync(`${workflowDirectory}/${file}`, 'utf8');
  return /^name:\s*CI\s*$/m.test(source);
});
const triggerStart = workflow.indexOf('\non:\n') + 1;
const triggerEnd = workflow.indexOf('\npermissions:', triggerStart);
const triggerBlock = workflow.slice(triggerStart, triggerEnd);

test('CI runs from pull-request activity and manual dispatch only', () => {
  assert.deepEqual(ciWorkflowFiles, ['ci.yml'], 'there must not be a second duplicate CI workflow');
  assert.ok(triggerStart > 0 && triggerEnd > triggerStart, 'workflow event block must be present');
  assert.match(triggerBlock, /^on:\n {2}pull_request:\n/m);
  assert.match(triggerBlock, /types:\s*\[opened,\s*reopened,\s*synchronize,\s*ready_for_review\]/);
  assert.match(triggerBlock, /^ {2}workflow_dispatch:\n/m);
  assert.doesNotMatch(triggerBlock, /^ {2}push:/m, 'branch pushes must not trigger routine CI');
  assert.doesNotMatch(workflow, /pull_request_target:/, 'untrusted PR code must use pull_request');
});

test('required branch-protection check job IDs and full manual validation remain', () => {
  assert.match(workflow, /^ {2}checks:\n/m);
  assert.match(workflow, /^ {2}frontend-browser:\n/m);
  assert.match(triggerBlock, /full_validation:/);
  assert.match(workflow, /^permissions:\n {2}contents: read$/m);
});

test('full frontend browser validation is sharded behind the stable required check', () => {
  assert.match(workflow, /^ {2}frontend-browser-shards:\n/m);
  assert.match(workflow, /shard: \[1, 2, 3\]/);
  assert.match(workflow, /playwright test --shard=\$\{\{ matrix\.shard \}\}\/3/);
  assert.match(workflow, /^ {2}frontend-browser-targeted:\n/m);

  const browserGateStart = workflow.indexOf('\n  frontend-browser:\n') + 1;
  const browserGateEnd = workflow.indexOf('\n  checks-core:\n', browserGateStart);
  const browserGate = workflow.slice(browserGateStart, browserGateEnd);
  assert.match(browserGate, /if: always\(\)/);
  assert.match(browserGate, /frontend-browser-shards\.result/);
  assert.match(browserGate, /frontend-browser-targeted\.result/);
  assert.match(browserGate, /full_suite: \$\{\{ needs\.validation_mode\.outputs\.full/);
});

test('restricted database CI receives only its dedicated credential export path', () => {
  const restrictedStepStart = workflow.indexOf(
    '- name: Verify restricted database bootstrap and migrations',
  );
  const restrictedStepEnd = workflow.indexOf('\n      - name:', restrictedStepStart + 1);
  const restrictedStep = workflow.slice(restrictedStepStart, restrictedStepEnd);

  assert.match(workflow, /OMNIS_CI_DATABASE_SUITE: \$\{\{ matrix\.suite \}\}/);
  assert.ok(restrictedStepStart >= 0 && restrictedStepEnd > restrictedStepStart);
  assert.match(
    restrictedStep,
    /source scripts\/ci\/export-restricted-test-database-environment\.sh/,
  );
  assert.doesNotMatch(restrictedStep, /export-test-database-environment\.sh/);
});

test('every PostgreSQL fixture workflow selects its credential suite explicitly', () => {
  assert.match(workflow, /OMNIS_CI_DATABASE_SUITE: platform-security/);
  assert.match(workflow, /OMNIS_CI_DATABASE_SUITE: full-stack-browser-integration/);
  assert.match(workflow, /OMNIS_CI_DATABASE_SUITE: \$\{\{ matrix\.suite \}\}/);
});
