import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const SHA256 = /^[a-f0-9]{64}$/;
const COMMAND_ID = /^[A-Z][A-Z0-9-]{1,31}$/;

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function timestamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)) {
    throw new TypeError('clock must return an ISO-8601 UTC timestamp with millisecond precision');
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new TypeError('clock returned an invalid timestamp');
  }
  return value;
}

function validateManifest(manifest) {
  if (!manifest || !Array.isArray(manifest.commands) || manifest.commands.length === 0) {
    throw new TypeError('manifest must contain at least one command');
  }
  const seen = new Set();
  for (const command of manifest.commands) {
    if (!command || typeof command !== 'object' || !COMMAND_ID.test(command.id ?? '')) {
      throw new TypeError('manifest contains an invalid command ID');
    }
    if (seen.has(command.id)) throw new TypeError(`duplicate command ID: ${command.id}`);
    seen.add(command.id);
    if (typeof command.command !== 'string' || command.command.length === 0) {
      throw new TypeError(`command ${command.id} has no frozen command text`);
    }
    if (
      !Array.isArray(command.allowedClassifications) ||
      command.allowedClassifications.length === 0 ||
      command.allowedClassifications.some(
        (value) => typeof value !== 'string' || value.length === 0,
      ) ||
      new Set(command.allowedClassifications).size !== command.allowedClassifications.length
    ) {
      throw new TypeError(`command ${command.id} has an invalid classification allowlist`);
    }
  }
  if (
    !SHA256.test(manifest.commandSourceSha256 ?? '') ||
    sha256(JSON.stringify(manifest.commands)) !== manifest.commandSourceSha256
  ) {
    throw new Error('command source hash mismatch');
  }
  if (
    !SHA256.test(manifest.runnerSha256 ?? '') ||
    sha256(readFileSync(SELF)) !== manifest.runnerSha256
  ) {
    throw new Error('runner source hash mismatch');
  }
}

/**
 * Capture a redacted evidence summary using an injected executor.
 * This module never spawns processes, reads host metadata, writes files, or logs output.
 * The executor and classifier are trusted adapters; production wiring needs separate review.
 */
export async function captureCheckpointEvidence(manifest, adapter) {
  validateManifest(manifest);
  if (
    !adapter ||
    typeof adapter.execute !== 'function' ||
    typeof adapter.reportStatus !== 'function' ||
    typeof adapter.classify !== 'function' ||
    typeof adapter.now !== 'function'
  ) {
    throw new TypeError('adapter must provide execute, reportStatus, classify, and now functions');
  }

  const startedAt = timestamp(adapter.now());
  const events = [];
  let previousTime = Date.parse(startedAt);

  for (const command of manifest.commands) {
    const commandStartedAt = timestamp(adapter.now());
    if (Date.parse(commandStartedAt) < previousTime) {
      return partial('clock_regression', startedAt, commandStartedAt, events);
    }

    let execution;
    let statusReport;
    try {
      execution = await adapter.execute(command);
      // Keep this as the immediate next adapter operation after command completion.
      statusReport = await adapter.reportStatus(execution?.exitStatus);
    } catch {
      const stoppedAt = timestamp(adapter.now());
      return partial('execution_or_status_report_error', startedAt, stoppedAt, events);
    }

    const finishedAt = timestamp(adapter.now());
    if (Date.parse(finishedAt) < Date.parse(commandStartedAt)) {
      return partial('clock_regression', startedAt, finishedAt, events);
    }
    const validStatus =
      Number.isInteger(execution?.exitStatus) &&
      execution.exitStatus >= 0 &&
      execution.exitStatus <= 255;
    const validReportedStatus =
      Number.isInteger(statusReport?.exitStatus) &&
      statusReport.exitStatus >= 0 &&
      statusReport.exitStatus <= 255;
    const event = {
      commandId: command.id,
      commandSha256: sha256(command.command),
      startedAt: commandStartedAt,
      finishedAt,
      exitStatus: validStatus ? execution.exitStatus : null,
      statusReport: { exitStatus: validReportedStatus ? statusReport.exitStatus : null },
    };
    events.push(event);
    previousTime = Date.parse(finishedAt);

    if (!validStatus || !validReportedStatus || statusReport.exitStatus !== execution.exitStatus) {
      return partial('status_report_mismatch', startedAt, finishedAt, events);
    }
    if (execution.exitStatus !== 0)
      return partial('command_nonzero', startedAt, finishedAt, events);

    let classification;
    try {
      classification = adapter.classify(command, execution.stdout);
    } catch {
      return partial('classification_error', startedAt, finishedAt, events);
    }
    if (!command.allowedClassifications.includes(classification)) {
      return partial('classification_unapproved', startedAt, finishedAt, events);
    }
    event.classification = classification;
  }

  const completedAt = timestamp(adapter.now());
  if (Date.parse(completedAt) < previousTime) {
    return partial('clock_regression', startedAt, completedAt, events);
  }
  return {
    state: 'complete',
    startedAt,
    completedAt,
    commandSourceSha256: manifest.commandSourceSha256,
    runnerSha256: manifest.runnerSha256,
    events,
  };
}

function partial(stopReason, startedAt, stoppedAt, events) {
  return { state: 'partial', startedAt, stoppedAt, stopReason, events };
}
