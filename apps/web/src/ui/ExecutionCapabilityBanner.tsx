import { Ban, CircleAlert, FlaskConical, LoaderCircle, ServerOff } from 'lucide-react';
import type { ExecutionGate } from './executionCapability.js';

const icons = {
  loading: LoaderCircle,
  load_failed: CircleAlert,
  disabled: Ban,
  worker_unavailable: ServerOff,
  authorizer_unavailable: ServerOff,
  unavailable: CircleAlert,
  mode_mismatch: CircleAlert,
  mock_ready: FlaskConical,
} as const;

export function ExecutionCapabilityBanner({
  gate,
  onRetry,
}: {
  gate: ExecutionGate;
  onRetry: () => void;
}) {
  const Icon = icons[gate.kind];
  const retryable =
    gate.kind !== 'disabled' && gate.kind !== 'mock_ready' && gate.kind !== 'loading';
  return (
    <section
      className={`execution-banner execution-${gate.kind}`}
      aria-labelledby="execution-banner-title"
      data-execution-state={gate.kind}
    >
      <Icon size={18} aria-hidden="true" />
      <div aria-live="polite">
        <strong id="execution-banner-title">{gate.title}</strong>
        <p>{gate.detail}</p>
      </div>
      {retryable && (
        <button type="button" className="secondary-button" onClick={onRetry}>
          Check again
        </button>
      )}
    </section>
  );
}
