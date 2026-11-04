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
  'agentManagementCounts', json_build_object(
    'departments', (SELECT count(*) FROM omnis.departments),
    'agents', (SELECT count(*) FROM omnis.agents),
    'publishedVersions', (SELECT count(*) FROM omnis.agent_profile_versions),
    'draftProfiles', (SELECT count(*) FROM omnis.agent_profile_drafts),
    'managementAudits', (SELECT count(*) FROM omnis.agent_management_audit),
    'managementIdempotency', (SELECT count(*) FROM omnis.agent_management_idempotency)
  ),
  'leasedRuns', (SELECT count(*) FROM omnis.runs WHERE lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL),
  'recordFingerprints', json_build_object(
    'tasks', (SELECT md5(COALESCE(string_agg(md5(to_jsonb(t)::text), ':' ORDER BY t.id), '')) FROM omnis.tasks t),
    'runs', (SELECT md5(COALESCE(string_agg(md5(to_jsonb(r)::text), ':' ORDER BY r.id), '')) FROM omnis.runs r),
    'events', (SELECT md5(COALESCE(string_agg(md5(to_jsonb(e)::text), ':' ORDER BY e.run_id, e.sequence), '')) FROM omnis.run_events e),
    'idempotency', (SELECT md5(COALESCE(string_agg(md5(to_jsonb(i)::text), ':' ORDER BY i.idempotency_key), '')) FROM omnis.run_idempotency i),
    'departments', (SELECT md5(COALESCE(string_agg(md5(to_jsonb(d)::text), ':' ORDER BY d.id), '')) FROM omnis.departments d),
    'agents', (SELECT md5(COALESCE(string_agg(md5(to_jsonb(a)::text), ':' ORDER BY a.id), '')) FROM omnis.agents a),
    'agentProfileVersions', (SELECT md5(COALESCE(string_agg(md5(to_jsonb(v)::text), ':' ORDER BY v.agent_id, v.version_no), '')) FROM omnis.agent_profile_versions v),
    'agentProfileDrafts', (SELECT md5(COALESCE(string_agg(md5(to_jsonb(d)::text), ':' ORDER BY d.agent_id), '')) FROM omnis.agent_profile_drafts d),
    'agentManagementAudit', (SELECT md5(COALESCE(string_agg(md5(to_jsonb(a)::text), ':' ORDER BY a.id), '')) FROM omnis.agent_management_audit a),
    'agentManagementIdempotency', (SELECT md5(COALESCE(string_agg(md5(to_jsonb(i)::text), ':' ORDER BY i.request_id), '')) FROM omnis.agent_management_idempotency i)
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
  'idSequences', json_build_object(
    'tasks', (
      SELECT json_build_object(
        'lastValue', sequence_state.last_value::text,
        'isCalled', sequence_state.is_called,
        'incrementBy', definition.seqincrement::text,
        'maxIssued', COALESCE((
          SELECT max(substring(id from '^task-([0-9]+)$')::numeric)::text
          FROM omnis.tasks WHERE id ~ '^task-[0-9]+$'
        ), '0'),
        'malformedIds', (SELECT count(*) FROM omnis.tasks WHERE id !~ '^task-[0-9]+$'),
        'nextValue', (sequence_state.last_value::numeric +
          CASE WHEN sequence_state.is_called THEN definition.seqincrement ELSE 0 END)::text
      )
      FROM omnis.task_id_seq AS sequence_state
      JOIN pg_sequence AS definition ON definition.seqrelid = 'omnis.task_id_seq'::regclass
    ),
    'runs', (
      SELECT json_build_object(
        'lastValue', sequence_state.last_value::text,
        'isCalled', sequence_state.is_called,
        'incrementBy', definition.seqincrement::text,
        'maxIssued', COALESCE((
          SELECT max(substring(id from '^run-([0-9]+)$')::numeric)::text
          FROM omnis.runs WHERE id ~ '^run-[0-9]+$'
        ), '0'),
        'malformedIds', (SELECT count(*) FROM omnis.runs WHERE id !~ '^run-[0-9]+$'),
        'nextValue', (sequence_state.last_value::numeric +
          CASE WHEN sequence_state.is_called THEN definition.seqincrement ELSE 0 END)::text
      )
      FROM omnis.run_id_seq AS sequence_state
      JOIN pg_sequence AS definition ON definition.seqrelid = 'omnis.run_id_seq'::regclass
    )
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
    !report.migrations.includes('0014_agent_profile_lifecycle') ||
    !validAgentManagementCounts(report.agentManagementCounts) ||
    !validAgentManagementFingerprints(report.recordFingerprints) ||
    report.syntheticOnly !== true ||
    report.sequenceInvariants !== true ||
    report.applicationQueryWorks !== true ||
    !validIdSequence(report.idSequences?.tasks, 'task') ||
    !validIdSequence(report.idSequences?.runs, 'run')
  ) {
    throw new Error('Database did not satisfy Omnis backup invariants.');
  }
}

function validIdSequence(sequence, label) {
  const integerText = /^-?[0-9]+$/;
  if (
    !sequence ||
    typeof sequence.lastValue !== 'string' ||
    !integerText.test(sequence.lastValue) ||
    typeof sequence.incrementBy !== 'string' ||
    !integerText.test(sequence.incrementBy) ||
    BigInt(sequence.incrementBy) <= 0n ||
    typeof sequence.maxIssued !== 'string' ||
    !integerText.test(sequence.maxIssued) ||
    typeof sequence.nextValue !== 'string' ||
    !integerText.test(sequence.nextValue) ||
    typeof sequence.isCalled !== 'boolean' ||
    sequence.malformedIds !== 0
  ) {
    throw new Error(`Database ${label} ID sequence state is missing or malformed.`);
  }
  const nextValue =
    BigInt(sequence.lastValue) + (sequence.isCalled ? BigInt(sequence.incrementBy) : 0n);
  if (BigInt(sequence.nextValue) !== nextValue || nextValue <= BigInt(sequence.maxIssued)) {
    throw new Error(`Database ${label} ID sequence is stale and could generate a collision.`);
  }
  return true;
}

export function assertBackupSafe(report) {
  assertValidMetrics(report);
  if (report.unsafeRunStates !== 0 || report.leasedRuns !== 0) {
    throw new Error(
      'Backup requires all queued, running, stopping, unknown, and leased work to settle.',
    );
  }
}

export function metricsMatch(source, restored) {
  assertValidMetrics(restored);
  for (const key of ['tasks', 'runs', 'events', 'idempotencyRecords', 'leasedRuns']) {
    if (source[key] !== restored[key]) return false;
  }
  for (const key of [
    'migrations',
    'runStatuses',
    'eventTypes',
    'recordFingerprints',
    'agentManagementCounts',
  ]) {
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

function validAgentManagementCounts(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return [
    'departments',
    'agents',
    'publishedVersions',
    'draftProfiles',
    'managementAudits',
    'managementIdempotency',
  ].every((key) => Number.isSafeInteger(value[key]) && value[key] >= 0);
}

function validAgentManagementFingerprints(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return [
    'departments',
    'agents',
    'agentProfileVersions',
    'agentProfileDrafts',
    'agentManagementAudit',
    'agentManagementIdempotency',
  ].every((key) => typeof value[key] === 'string' && /^[a-f0-9]{32}$/.test(value[key]));
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
