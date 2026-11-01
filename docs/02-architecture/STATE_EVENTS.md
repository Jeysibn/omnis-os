# State Machines and Event Contracts

## Canonical states

### Task

`backlog -> ready -> assigned -> in_progress -> in_review -> accepted` or `blocked/cancelled`.

- `in_progress` requires at least one associated run.
- A completed run does **not** imply `accepted` task.
- A task with rejected evidence can return to `ready` for a new run.
- A blocked task must have a recorded reason; dependencies may block ready transition.

### Run

`requested -> admitted -> queued -> starting -> running -> (waiting_approval | stopping | completed | failed | cancelled | interrupted | unknown)`.

- `completed`, `failed`, `cancelled`, `interrupted` are terminal observations for that **attempt**.
- `unknown` is a reconciliation state after a lost connection, not a success. Never auto-retry side effects without review.
- `stopping` indicates a stop request sent but not yet acknowledged.
- `waiting_approval` pauses privileged action but is not itself a terminal status.
- Actual runtime terminal flags override any optimistic 'success' text.

### Approval

`pending -> approved | denied | expired | revoked`. Approval binds to exact tool, arguments digest, principal, run, scope, expiry and authorization policy version.

### Automation

`draft -> enabled <-> paused -> archived`; one automation can have many occurrences. Each occurrence `due -> enqueued -> started -> succeeded|failed|skipped|missed|unknown`.

### Knowledge proposal

`draft -> submitted -> approved|rejected|needs_changes -> published|superseded`. Agents cannot directly mark proposals approved without explicit policy.

## Event envelope (design proposal)

```json
{
  "event_id": "uuid",
  "sequence": 42,
  "event_type": "run.tool.completed",
  "occurred_at": "2026-11-02T00:30:00Z",
  "recorded_at": "2026-11-02T00:30:01Z",
  "run_id": "uuid",
  "task_id": "uuid",
  "agent_id": "uuid",
  "execution_generation": 1,
  "source_runtime": "hermes",
  "source_event_key": "opaque-external-event-id",
  "scope": {"project_id": "uuid"},
  "payload": {"tool_name": "read_file", "outcome": "ok"},
  "redaction_level": "safe_summary"
}
```

**Requirements:** stable IDs and per-run monotonic sequence; dedup `(run_id, source_runtime, source_event_key, execution_generation)` when available; producer must not fabricate source IDs; redact payload before DB/audit and SSE. If source lacks event IDs, assign app IDs with best-effort ordering and explicit provenance.

## SSE protocol

- On subscribe, obtain authorized snapshot plus stream from `after` cursor.
- Send `id: <cursor>`, `event: run.updated`, `data: <redacted JSON>`.
- Browser reconnect supplies last event ID; if cursor expired, API returns snapshot-required event or status and UI reloads snapshot.
- Event access re-checks scope; do not leak raw tool arguments, secrets, or private project data across sessions.
- Heartbeat events allowed without implying model is executing.

## Idempotency and retries

- **Request idempotency:** same director/command/key/payload => same run receipt; changed payload using same key => 409 conflict.
- **Worker lease:** claim+heartbeat+generation prevents two workers from owning same execution concurrently. Lease loss moves to reconciliation; does not imply external process stopped.
- **Side effects:** exact-once execution cannot be guaranteed across external systems; require operation IDs, protected workspace, postcondition verification and cautious retry.
- **Stop:** cancellation request acknowledgement and run terminal settlement are separate signals.
- **Subscription quota:** rate limited runtime yields retryable blocked status only when idempotence is safe.

## 3D scene projections

`idle -> seated`; `running + coding tool -> typing`; `running + research tool -> searching`; `knowledge.read -> library visit animation`; `waiting_approval -> attention icon`; `failed -> error marker`; `offline -> disconnected`. Do not infer activity simply from elapsed time. Temporary idle animations clearly decorative, not proof of model activity.
