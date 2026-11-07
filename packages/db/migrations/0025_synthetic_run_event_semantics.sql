-- Expose the broker handoff and uncertain completion truthfully in durable Run history.
-- Existing run_events are immutable; legacy unknown rows may retain their old event label.
ALTER TABLE omnis.run_events
  DROP CONSTRAINT run_events_event_type_check,
  ADD CONSTRAINT run_events_event_type_check CHECK (event_type IN (
    'run.queued', 'run.started', 'run.provider_submission_requested', 'run.output',
    'run.stop_requested', 'run.completed', 'run.cancelled', 'run.failed',
    'run.interrupted', 'run.outcome_unknown'
  ));
