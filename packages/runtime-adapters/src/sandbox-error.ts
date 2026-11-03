export type SandboxErrorCode =
  | 'timed_out'
  | 'cancelled'
  | 'unavailable'
  | 'crashed'
  | 'output_limit'
  | 'launch_failed'
  | 'termination_failed';

const safeMessages: Record<SandboxErrorCode, string> = {
  timed_out: 'The isolated execution exceeded its time limit.',
  cancelled: 'The isolated execution was cancelled.',
  unavailable: 'The isolated execution service is unavailable.',
  crashed: 'The isolated execution process failed.',
  output_limit: 'The isolated execution exceeded its output limit.',
  launch_failed: 'The isolated execution could not be started.',
  termination_failed: 'The isolated execution could not be confirmed stopped.',
};

export class SandboxError extends Error {
  readonly code: SandboxErrorCode;

  constructor(code: SandboxErrorCode) {
    super(safeMessages[code]);
    this.name = 'SandboxError';
    this.code = code;
  }
}
