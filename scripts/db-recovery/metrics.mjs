export const metricsQuery = `SELECT json_build_object(
  'migrations', (SELECT COALESCE(json_agg(id ORDER BY id), '[]'::json) FROM omnis.schema_migrations),
  'tasks', (SELECT count(*) FROM omnis.tasks),
  'runs', (SELECT count(*) FROM omnis.runs),
  'runStatuses', (
    SELECT COALESCE(json_object_agg(status, run_count), '{}'::json)
    FROM (SELECT status, count(*) AS run_count FROM omnis.runs GROUP BY status) statuses
  ),
  'events', (SELECT count(*) FROM omnis.run_events),
  'eventTypes', (
    SELECT COALESCE(json_object_agg(event_type, event_count), '{}'::json)
    FROM (SELECT event_type, count(*) AS event_count FROM omnis.run_events GROUP BY event_type) types
  ),
  'idempotencyRecords', (SELECT count(*) FROM omnis.run_idempotency),
  'leasedRuns', (SELECT count(*) FROM omnis.runs WHERE lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL),
  'recordFingerprints', json_build_object(
    'tasks', (SELECT md5(COALESCE(string_agg(md5(to_jsonb(t)::text), ':' ORDER BY t.id), '')) FROM omnis.tasks t),
    'runs', (SELECT md5(COALESCE(string_agg(md5(to_jsonb(r)::text), ':' ORDER BY r.id), '')) FROM omnis.runs r),
    'events', (SELECT md5(COALESCE(string_agg(md5(to_jsonb(e)::text), ':' ORDER BY e.run_id, e.sequence), '')) FROM omnis.run_events e),
    'idempotency', (SELECT md5(COALESCE(string_agg(md5(to_jsonb(i)::text), ':' ORDER BY i.idempotency_key), '')) FROM omnis.run_idempotency i)
  ),
  'syntheticOnly', (SELECT COALESCE(bool_and(synthetic IS TRUE AND runtime_kind = 'mock'), true) FROM omnis.runs),
  'sequenceInvariants', (
    SELECT COALESCE(bool_and(
      r.last_event_sequence = counts.event_count AND
      (counts.event_count = 0 OR (counts.first_sequence = 1 AND counts.last_sequence = counts.event_count))
    ), true)
    FROM omnis.runs r
    LEFT JOIN LATERAL (
      SELECT count(*)::integer AS event_count, min(sequence) AS first_sequence, max(sequence) AS last_sequence
      FROM omnis.run_events e WHERE e.run_id = r.id
    ) counts ON true
  ),
  'applicationQueryWorks', (
    SELECT EXISTS (
      SELECT t.id, r.id, r.status, count(e.id)
      FROM omnis.tasks t
      LEFT JOIN omnis.runs r ON r.task_id = t.id
      LEFT JOIN omnis.run_events e ON e.run_id = r.id
      GROUP BY t.id, r.id, r.status
      ORDER BY t.id, r.id
      LIMIT 1
    ) OR NOT EXISTS (SELECT 1 FROM omnis.tasks)
  ),
  'unsafeRunStates', (SELECT count(*) FROM omnis.runs WHERE status IN ('queued', 'running', 'stopping', 'unknown'))
)`;

export function parseMetrics(output) {
  const report = JSON.parse(output.trim());
  assertValidMetrics(report);
  return report;
}

export function assertValidMetrics(report) {
  if (
    !Array.isArray(report.migrations) ||
    !report.migrations.includes('0001_initial') ||
    report.syntheticOnly !== true ||
    report.sequenceInvariants !== true ||
    report.applicationQueryWorks !== true
  ) {
    throw new Error('Database did not satisfy Omnis backup invariants.');
  }
}

export function metricsMatch(source, restored) {
  assertValidMetrics(restored);
  for (const key of ['tasks', 'runs', 'events', 'idempotencyRecords', 'leasedRuns']) {
    if (source[key] !== restored[key]) return false;
  }
  for (const key of ['migrations', 'runStatuses', 'eventTypes', 'recordFingerprints']) {
    if (JSON.stringify(canonical(source[key])) !== JSON.stringify(canonical(restored[key]))) {
      return false;
    }
  }
  return (
    source.sequenceInvariants === true &&
    source.syntheticOnly === true &&
    source.applicationQueryWorks === true &&
    source.unsafeRunStates === 0 &&
    restored.unsafeRunStates === 0
  );
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonical(item)]),
    );
  }
  return value;
}
