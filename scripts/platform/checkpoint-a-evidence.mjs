import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const SHA256 = /^[a-f0-9]{64}$/;
const COMMAND_ID = /^[A-Z][A-Z0-9-]{1,31}$/;
const MAX_OUTPUT_BYTES = 16 * 1024;
const MAX_CHUNK_BYTES = 4 * 1024;
const Controller = globalThis.AbortController;
const GENESIS = '0'.repeat(64);

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

function monotonicTick(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError('monotonic clock must return a nonnegative safe integer');
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
      !Number.isSafeInteger(command.timeoutMs) ||
      command.timeoutMs < 1 ||
      command.timeoutMs > 300_000
    ) {
      throw new TypeError(`command ${command.id} has an invalid timeout`);
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
 * The executor must stream bounded chunks, enforce the supplied timeout/abort signal,
 * and report only after the command has stopped. Production wiring needs separate review.
 */
export async function captureCheckpointEvidence(manifest, adapter) {
  validateManifest(manifest);
  if (
    !adapter ||
    typeof adapter.execute !== 'function' ||
    typeof adapter.reportStatus !== 'function' ||
    typeof adapter.classify !== 'function' ||
    typeof adapter.now !== 'function' ||
    typeof adapter.monotonicNow !== 'function'
  ) {
    throw new TypeError(
      'adapter must provide execute, reportStatus, classify, now, and monotonicNow',
    );
  }

  let startedAt;
  let startedTick;
  try {
    startedAt = timestamp(adapter.now());
    startedTick = monotonicTick(adapter.monotonicNow());
  } catch {
    throw new Error('clock precondition failed before execution');
  }

  const events = [];
  const makePartial = (...args) =>
    partial(manifest, startedAt, startedTick, ...args, safeMonotonicTick(adapter.monotonicNow));
  let previousWallTime = Date.parse(startedAt);
  let previousTick = startedTick;

  for (let index = 0; index < manifest.commands.length; index += 1) {
    const command = manifest.commands[index];
    let commandStartedAt;
    let commandStartedTick;
    try {
      commandStartedAt = timestamp(adapter.now());
      commandStartedTick = monotonicTick(adapter.monotonicNow());
    } catch {
      return makePartial(
        'clock_invalid_before_command',
        null,
        events,
        command.id,
        'before_command',
      );
    }
    if (Date.parse(commandStartedAt) < previousWallTime || commandStartedTick < previousTick) {
      return makePartial(
        'clock_regression',
        commandStartedAt,
        events,
        command.id,
        'before_command',
      );
    }

    const controller = new Controller();
    let execution;
    let statusReport;
    let commandFinishedAt = null;
    let commandFinishedTick = null;
    let commandExitStatus = null;
    let commandTimedOut = false;
    let phase = 'execution';
    try {
      const running = await adapter.execute(command, {
        signal: controller.signal,
        timeoutMs: command.timeoutMs,
        maxOutputBytes: MAX_OUTPUT_BYTES,
        maxChunkBytes: MAX_CHUNK_BYTES,
      });
      phase = 'stdout_capture';
      let stdout;
      let overflow = false;
      let stdoutError = false;
      try {
        stdout = await readBoundedChunks(running?.stdoutChunks, () => controller.abort());
      } catch (error) {
        overflow = error?.message === 'stdout_limit_exceeded';
        stdoutError = !overflow;
        controller.abort();
      }
      phase = 'command_completion';
      // completion must resolve only after the command has exited or its timeout cleanup finished.
      const outcome = await running?.completion;
      const normalizedOutcome = normalizeCompletion(outcome);
      commandExitStatus = normalizedOutcome.valid ? normalizedOutcome.exitStatus : null;
      commandTimedOut = normalizedOutcome.valid && normalizedOutcome.timedOut;
      commandFinishedAt = safeTimestamp(adapter.now);
      commandFinishedTick = safeMonotonicTick(adapter.monotonicNow);
      phase = 'status_report';
      const reported = await adapter.reportStatus(
        normalizedOutcome.valid && !normalizedOutcome.timedOut
          ? normalizedOutcome.exitStatus
          : null,
      );
      const normalizedReport = normalizeStatusReport(reported);
      statusReport = { exitStatus: normalizedReport.exitStatus };
      execution = {
        exitStatus: normalizedOutcome.exitStatus,
        timedOut: normalizedOutcome.timedOut,
        completionValid: normalizedOutcome.valid,
        statusReportValid: normalizedReport.valid,
        stdoutBuffer: overflow || stdoutError ? null : stdout,
        overflow,
        stdoutError,
      };
    } catch {
      controller.abort();
      const stoppedAt = safeTimestamp(adapter.now);
      events.push(
        eventFailure(
          index,
          command,
          commandStartedAt,
          commandFinishedAt,
          commandStartedTick,
          commandFinishedTick,
          commandTimedOut ? null : commandExitStatus,
        ),
      );
      return makePartial('execution_or_status_report_error', stoppedAt, events, command.id, phase);
    }

    let finishedAt;
    let finishedTick;
    try {
      finishedAt = timestamp(adapter.now());
      finishedTick = monotonicTick(adapter.monotonicNow());
    } catch {
      const event = eventFor(
        index,
        command,
        commandStartedAt,
        commandFinishedAt,
        null,
        commandStartedTick,
        commandFinishedTick,
        null,
        execution.timedOut ? null : execution.exitStatus,
        statusReport?.exitStatus ?? null,
      );
      events.push(event);
      return makePartial(
        'clock_invalid_after_status_report',
        null,
        events,
        command.id,
        'timestamp',
      );
    }
    if (
      !commandFinishedAt ||
      commandFinishedTick === null ||
      Date.parse(commandFinishedAt) < Date.parse(commandStartedAt) ||
      commandFinishedTick < commandStartedTick ||
      Date.parse(finishedAt) < Date.parse(commandFinishedAt) ||
      finishedTick < commandFinishedTick
    ) {
      events.push(
        eventFor(
          index,
          command,
          commandStartedAt,
          commandFinishedAt,
          finishedAt,
          commandStartedTick,
          commandFinishedTick,
          finishedTick,
          null,
          null,
        ),
      );
      return makePartial('clock_regression', finishedAt, events, command.id, 'after_command');
    }

    const timeout = execution.timedOut === true;
    const overflow = execution.overflow === true;
    const exitStatus = timeout ? null : execution.exitStatus;
    const reportedStatus = statusReport?.exitStatus;
    const statusPairValid = timeout
      ? reportedStatus === null && execution.statusReportValid
      : Number.isInteger(exitStatus) &&
        exitStatus >= 0 &&
        exitStatus <= 255 &&
        reportedStatus === exitStatus &&
        execution.completionValid &&
        execution.statusReportValid;
    const event = eventFor(
      index,
      command,
      commandStartedAt,
      commandFinishedAt,
      finishedAt,
      commandStartedTick,
      commandFinishedTick,
      finishedTick,
      exitStatus,
      reportedStatus,
    );
    events.push(event);
    previousWallTime = Date.parse(finishedAt);
    previousTick = finishedTick;

    if (!statusPairValid) {
      return makePartial(
        !execution.completionValid
          ? 'command_completion_invalid'
          : !execution.statusReportValid
            ? 'status_report_invalid'
            : 'status_report_mismatch',
        finishedAt,
        events,
        command.id,
        'after_status_report',
      );
    }
    if (timeout)
      return makePartial('command_timeout', finishedAt, events, command.id, 'after_status_report');
    if (overflow)
      return makePartial('stdout_too_large', finishedAt, events, command.id, 'output_capture');
    if (execution.stdoutError)
      return makePartial('stdout_stream_error', finishedAt, events, command.id, 'output_capture');
    if (exitStatus !== 0)
      return makePartial('command_nonzero', finishedAt, events, command.id, 'after_status_report');
    if (!Buffer.isBuffer(execution.stdoutBuffer)) {
      return makePartial('stdout_invalid', finishedAt, events, command.id, 'classification');
    }

    let classification;
    try {
      classification = adapter.classify(command, execution.stdoutBuffer);
    } catch {
      return makePartial('classification_error', finishedAt, events, command.id, 'classification');
    }
    if (!command.allowedClassifications.includes(classification)) {
      return makePartial(
        'classification_unapproved',
        finishedAt,
        events,
        command.id,
        'classification',
      );
    }
    event.classification = classification;
  }

  let completedAt;
  let completedTick;
  try {
    completedAt = timestamp(adapter.now());
    completedTick = monotonicTick(adapter.monotonicNow());
  } catch {
    return makePartial('clock_invalid_after_run', null, events, null, 'final_timestamp');
  }
  if (Date.parse(completedAt) < previousWallTime || completedTick < previousTick) {
    return makePartial('clock_regression', completedAt, events, null, 'final_timestamp');
  }
  return sealRecord({
    state: 'complete',
    startedAt,
    startedTick,
    completedAt,
    completedTick,
    commandSourceSha256: manifest.commandSourceSha256,
    runnerSha256: manifest.runnerSha256,
    events,
  });
}

async function readBoundedChunks(chunks, abort) {
  if (!chunks || typeof chunks[Symbol.asyncIterator] !== 'function')
    throw new Error('stdout_stream_missing');
  const parts = [];
  let byteCount = 0;
  for await (const chunk of chunks) {
    if (!(chunk instanceof Uint8Array)) {
      abort();
      throw new Error('stdout_chunk_invalid');
    }
    if (chunk.byteLength > MAX_CHUNK_BYTES || byteCount + chunk.byteLength > MAX_OUTPUT_BYTES) {
      abort();
      throw new Error('stdout_limit_exceeded');
    }
    const copy = Buffer.from(chunk);
    parts.push(copy);
    byteCount += copy.byteLength;
  }
  return Buffer.concat(parts, byteCount);
}

function exactRecord(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== keys.length || ownKeys.some((key) => !keys.includes(key))) return false;
  return keys.every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && Object.hasOwn(descriptor, 'value');
  });
}

function normalizeCompletion(outcome) {
  if (!exactRecord(outcome, ['exitStatus', 'timedOut'])) {
    return { valid: false, exitStatus: null, timedOut: false };
  }
  const { exitStatus, timedOut } = outcome;
  if (typeof timedOut !== 'boolean') return { valid: false, exitStatus: null, timedOut: false };
  if (timedOut) {
    return exitStatus === null
      ? { valid: true, exitStatus: null, timedOut: true }
      : { valid: false, exitStatus: null, timedOut: false };
  }
  return Number.isInteger(exitStatus) && exitStatus >= 0 && exitStatus <= 255
    ? { valid: true, exitStatus, timedOut: false }
    : { valid: false, exitStatus: null, timedOut: false };
}

function normalizeStatusReport(report) {
  if (!exactRecord(report, ['exitStatus'])) return { valid: false, exitStatus: null };
  const { exitStatus } = report;
  return exitStatus === null ||
    (Number.isInteger(exitStatus) && exitStatus >= 0 && exitStatus <= 255)
    ? { valid: true, exitStatus }
    : { valid: false, exitStatus: null };
}

function eventFor(
  index,
  command,
  startedAt,
  commandFinishedAt,
  statusReportedAt,
  startedTick,
  commandFinishedTick,
  statusReportedTick,
  exitStatus,
  reportedStatus,
) {
  return {
    sequence: index + 1,
    commandId: command.id,
    commandSha256: sha256(command.command),
    startedAt,
    commandFinishedAt,
    statusReportedAt,
    startedTick,
    commandFinishedTick,
    statusReportedTick,
    exitStatus,
    statusReport: { exitStatus: reportedStatus },
  };
}

function eventFailure(
  index,
  command,
  startedAt,
  commandFinishedAt,
  startedTick,
  commandFinishedTick,
  exitStatus,
) {
  return eventFor(
    index,
    command,
    startedAt,
    commandFinishedAt,
    null,
    startedTick,
    commandFinishedTick,
    null,
    exitStatus,
    null,
  );
}

function safeTimestamp(now) {
  try {
    return timestamp(now());
  } catch {
    return null;
  }
}

function safeMonotonicTick(monotonicNow) {
  try {
    return monotonicTick(monotonicNow());
  } catch {
    return null;
  }
}

function partial(
  manifest,
  startedAt,
  startedTick,
  stopReason,
  stoppedAt,
  events,
  commandId,
  phase,
  stoppedTick,
) {
  return sealRecord({
    state: 'partial',
    startedAt,
    startedTick,
    stoppedAt,
    stoppedTick,
    commandSourceSha256: manifest.commandSourceSha256,
    runnerSha256: manifest.runnerSha256,
    stopReason,
    commandId,
    phase,
    events,
  });
}

function sealRecord(record) {
  let previousHash = GENESIS;
  const events = record.events.map((event) => {
    const body = { ...event, previousEventSha256: previousHash };
    const eventSha256 = sha256(JSON.stringify(body));
    previousHash = eventSha256;
    return { ...body, eventSha256 };
  });
  const sealed = { ...record, events };
  sealed.recordSha256 = sha256(JSON.stringify(sealed));
  return sealed;
}

export function verifyCheckpointEvidence(record) {
  try {
    if (!record || !Array.isArray(record.events) || !SHA256.test(record.recordSha256 ?? ''))
      return false;
    let previousHash = GENESIS;
    for (let index = 0; index < record.events.length; index += 1) {
      const event = record.events[index];
      if (event.sequence !== index + 1 || event.previousEventSha256 !== previousHash) return false;
      const { eventSha256, ...body } = event;
      if (!SHA256.test(eventSha256 ?? '') || sha256(JSON.stringify(body)) !== eventSha256)
        return false;
      previousHash = eventSha256;
    }
    const { recordSha256, ...body } = record;
    return sha256(JSON.stringify(body)) === recordSha256;
  } catch {
    return false;
  }
}
