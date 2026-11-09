import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyChangedFiles,
  getGateFailures,
  getValidationMode,
  selectDraftBrowserSpecs,
} from './validation-plan.mjs';

test('Draft PR uses fast validation and keeps the full gate for Ready', () => {
  assert.equal(
    getValidationMode({ eventName: 'pull_request', event: { pull_request: { draft: true } } }),
    'fast',
  );
  assert.equal(
    getValidationMode({ eventName: 'pull_request', event: { pull_request: { draft: false } } }),
    'full',
  );
});

test('Draft and Ready transitions plus Ready-head updates select the expected mode', () => {
  const convertedToDraft = {
    action: 'converted_to_draft',
    pull_request: { draft: true },
  };
  const readyForReview = { action: 'ready_for_review', pull_request: { draft: false } };
  const readyCommitUpdate = { action: 'synchronize', pull_request: { draft: false } };
  const readyBaseOrMetadataUpdate = { action: 'edited', pull_request: { draft: false } };

  assert.equal(getValidationMode({ eventName: 'pull_request', event: convertedToDraft }), 'fast');
  assert.equal(getValidationMode({ eventName: 'pull_request', event: readyForReview }), 'full');
  assert.equal(getValidationMode({ eventName: 'pull_request', event: readyCommitUpdate }), 'full');
  assert.equal(
    getValidationMode({ eventName: 'pull_request', event: readyBaseOrMetadataUpdate }),
    'full',
  );
});

test('Draft manual full-validation requests run the full suite', () => {
  assert.equal(
    getValidationMode({
      eventName: 'workflow_dispatch',
      event: { inputs: { full_validation: 'true' } },
    }),
    'full',
  );
  assert.equal(
    getValidationMode({ eventName: 'workflow_dispatch', event: { inputs: {} } }),
    'fast',
  );
  assert.equal(
    getValidationMode({
      eventName: 'workflow_dispatch',
      event: { inputs: { full_validation: false } },
      ref: 'refs/heads/main',
    }),
    'full',
  );
});

test('main and security branch pushes always run full validation', () => {
  assert.equal(getValidationMode({ eventName: 'push', ref: 'refs/heads/main' }), 'full');
  assert.equal(
    getValidationMode({ eventName: 'push', ref: 'refs/heads/security/post-audit-remediation' }),
    'full',
  );
});

test('unknown event shapes fail closed', () => {
  assert.throws(() => getValidationMode({ eventName: 'pull_request', event: {} }));
  assert.throws(() => getValidationMode({ eventName: 'push', ref: 'refs/heads/topic' }));
  assert.throws(() => getValidationMode({ eventName: 'schedule' }));
});

test('sensitive changes request the matching early integration suites', () => {
  assert.deepEqual(classifyChangedFiles(['infra/compose/docker-compose.app.yml']), {
    securitySensitive: true,
    containerSensitive: true,
    databaseSensitive: false,
    fullStackSensitive: false,
    fullFrontendSensitive: false,
  });
  assert.deepEqual(classifyChangedFiles(['packages/db/src/run-store.ts']), {
    securitySensitive: true,
    containerSensitive: false,
    databaseSensitive: true,
    fullStackSensitive: true,
    fullFrontendSensitive: false,
  });
  assert.deepEqual(classifyChangedFiles(['apps/synthetic-broker/src/server.ts']), {
    securitySensitive: true,
    containerSensitive: true,
    databaseSensitive: false,
    fullStackSensitive: true,
    fullFrontendSensitive: false,
  });
  assert.deepEqual(classifyChangedFiles(['apps/web/src/ui/command-center-order.spec.ts']), {
    securitySensitive: false,
    containerSensitive: false,
    databaseSensitive: false,
    fullStackSensitive: false,
    fullFrontendSensitive: false,
  });
  assert.deepEqual(classifyChangedFiles(['infra/systemd/omnis-authorizer.service']), {
    securitySensitive: true,
    containerSensitive: false,
    databaseSensitive: false,
    fullStackSensitive: false,
    fullFrontendSensitive: false,
  });
  assert.deepEqual(classifyChangedFiles(['apps/web/playwright.config.ts']), {
    securitySensitive: false,
    containerSensitive: false,
    databaseSensitive: false,
    fullStackSensitive: false,
    fullFrontendSensitive: true,
  });
  assert.deepEqual(classifyChangedFiles(['apps/web/playwright.integration.config.ts']), {
    securitySensitive: true,
    containerSensitive: false,
    databaseSensitive: false,
    fullStackSensitive: true,
    fullFrontendSensitive: true,
  });
  assert.deepEqual(classifyChangedFiles(['apps/web/integration/tasks.integration.spec.ts']), {
    securitySensitive: true,
    containerSensitive: false,
    databaseSensitive: false,
    fullStackSensitive: true,
    fullFrontendSensitive: false,
  });
  assert.deepEqual(classifyChangedFiles(['tests/integration/backup-restore-ci.mjs']), {
    securitySensitive: true,
    containerSensitive: true,
    databaseSensitive: true,
    fullStackSensitive: true,
    fullFrontendSensitive: false,
  });
  assert.deepEqual(classifyChangedFiles(['scripts/container-images/verify-built-images.mjs']), {
    securitySensitive: true,
    containerSensitive: true,
    databaseSensitive: false,
    fullStackSensitive: false,
    fullFrontendSensitive: false,
  });
});

test('Draft browser tests follow the affected UI area with a shell fallback', () => {
  assert.deepEqual(selectDraftBrowserSpecs(['apps/web/src/ui/command-center.fixture.ts']), [
    'src/ui/command-center-order.spec.ts',
    'src/ui/command-center.spec.ts',
    'src/ui/shell.spec.ts',
  ]);
  assert.deepEqual(selectDraftBrowserSpecs(['apps/web/src/ui/projects.fixture.ts']), [
    'src/ui/projects.recovery.spec.ts',
    'src/ui/projects.spec.ts',
    'src/ui/shell.spec.ts',
  ]);
  assert.deepEqual(selectDraftBrowserSpecs(['README.md']), ['src/ui/shell.spec.ts']);
  assert.equal(selectDraftBrowserSpecs(['apps/web/src/ui/new-unmapped-widget.tsx']).length, 9);
});

test('fast mode requires Stage A checks but never satisfies the merge gate', () => {
  assert.deepEqual(
    getGateFailures({
      mode: 'fast',
      results: {
        validation_mode: 'success',
        checks_core: 'success',
        frontend_browser: 'success',
        platform_security: 'skipped',
        database_integration: 'skipped',
        full_stack_browser_integration: 'skipped',
        backup_restore: 'skipped',
        container_images: 'skipped',
      },
    }),
    ['full_validation_deferred=fast mode cannot satisfy the required merge gate'],
  );
});

test('full mode fails closed for missing, skipped, cancelled, and failed jobs', () => {
  const failures = getGateFailures({
    mode: 'full',
    results: {
      validation_mode: 'success',
      checks_core: 'success',
      frontend_browser: 'success',
      frontend_browser_full_suite: 'true',
      platform_security: 'success',
      database_integration: 'skipped',
      full_stack_browser_integration: 'cancelled',
      backup_restore: 'failure',
    },
  });
  assert.deepEqual(failures, [
    'database_integration=skipped',
    'full_stack_browser_integration=cancelled',
    'backup_restore=failure',
    'container_images=missing',
  ]);
});

test('full mode passes only when every full acceptance job passes', () => {
  assert.deepEqual(
    getGateFailures({
      mode: 'full',
      results: {
        validation_mode: 'success',
        checks_core: 'success',
        frontend_browser: 'success',
        frontend_browser_full_suite: 'true',
        platform_security: 'success',
        database_integration: 'success',
        full_stack_browser_integration: 'success',
        backup_restore: 'success',
        container_images: 'success',
      },
    }),
    [],
  );
});

test('fast mode requires every suite selected by sensitive changed files', () => {
  assert.deepEqual(
    getGateFailures({
      mode: 'fast',
      sensitive: {
        security_sensitive: true,
        container_sensitive: true,
        database_sensitive: true,
        full_stack_sensitive: true,
      },
      results: {
        validation_mode: 'success',
        checks_core: 'success',
        frontend_browser: 'success',
        platform_security: 'success',
        container_images: 'success',
        database_integration: 'success',
        full_stack_browser_integration: 'success',
        backup_restore: 'success',
      },
    }),
    ['full_validation_deferred=fast mode cannot satisfy the required merge gate'],
  );
  assert.deepEqual(
    getGateFailures({
      mode: 'fast',
      sensitive: { full_frontend_sensitive: true },
      results: {
        validation_mode: 'success',
        checks_core: 'success',
        frontend_browser: 'success',
        frontend_browser_full_suite: 'false',
      },
    }),
    [
      'frontend_browser_full_suite=false',
      'full_validation_deferred=fast mode cannot satisfy the required merge gate',
    ],
  );
  assert.deepEqual(
    getGateFailures({
      mode: 'fast',
      sensitive: { security_sensitive: true },
      results: { validation_mode: 'success', checks_core: 'success', frontend_browser: 'success' },
    }),
    [
      'platform_security=missing',
      'full_validation_deferred=fast mode cannot satisfy the required merge gate',
    ],
  );
});

test('missing validation mode and stable required jobs fail closed', () => {
  assert.deepEqual(getGateFailures({ mode: '', results: {} }), [
    'validation mode is missing or invalid',
    'validation_mode=missing',
    'checks_core=missing',
    'frontend_browser=missing',
  ]);
});
