import { useState } from 'react';
import {
  ConfirmDialog,
  DataTable,
  EmptyState,
  ErrorState,
  Field,
  InfoGroup,
  LoadingState,
  NxButton,
  NxInput,
  NxTheme,
  PageContainer,
  PageHeader,
  Panel,
  SearchFilter,
  StatusBadge,
  type Column,
  type StatusTone,
} from './index.js';

/**
 * A development-only reference page for the NEXUS design system, served by the Vite dev server at
 * /design-system.html. It is not linked from the application and is not part of the production
 * build. All content is sample text and says so; no figure here describes real system activity.
 */

type SampleRow = { id: string; name: string; tone: StatusTone; status: string; note: string };

const rows: readonly SampleRow[] = [
  { id: 'row-1', name: 'Sample record A', tone: 'ok', status: 'Healthy', note: 'Sample data' },
  {
    id: 'row-2',
    name: 'Sample record B',
    tone: 'attention',
    status: 'Needs attention',
    note: 'Sample data',
  },
  { id: 'row-3', name: 'Sample record C', tone: 'danger', status: 'Failed', note: 'Sample data' },
  {
    id: 'row-4',
    name: 'Sample record D',
    tone: 'unknown',
    status: 'Unknown',
    note: 'Not verified',
  },
];

const columns: readonly Column<SampleRow>[] = [
  { key: 'name', header: 'Name', render: (row) => row.name },
  {
    key: 'status',
    header: 'Status',
    render: (row) => <StatusBadge tone={row.tone}>{row.status}</StatusBadge>,
  },
  { key: 'note', header: 'Note', render: (row) => row.note },
];

const tones: readonly { tone: StatusTone; label: string }[] = [
  { tone: 'ok', label: 'Healthy' },
  { tone: 'attention', label: 'Needs attention' },
  { tone: 'danger', label: 'Failed' },
  { tone: 'info', label: 'Informational' },
  { tone: 'neutral', label: 'Idle' },
  { tone: 'unknown', label: 'Unknown' },
];

export function Showcase() {
  const [query, setQuery] = useState('');
  const [name, setName] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const filtered = rows.filter((row) =>
    row.name.toLowerCase().includes(query.trim().toLowerCase()),
  );
  const nameError = submitted && name.trim() === '' ? 'Enter a name.' : undefined;

  return (
    <NxTheme>
      <main id="main-content">
        <PageContainer>
          <PageHeader
            eyebrow="OMNIS OS · DESIGN SYSTEM"
            title="OMNIS NEXUS design system"
            description="Reference for the shared tokens and components. Sample content only."
            actions={<NxButton variant="primary">Primary action</NxButton>}
          />

          <Panel title="Buttons" label="Controls">
            <div className="nx-page-header__actions">
              <NxButton variant="primary">Primary</NxButton>
              <NxButton>Secondary</NxButton>
              <NxButton variant="ghost">Ghost</NxButton>
              <NxButton variant="danger">Danger</NxButton>
              <NxButton disabled>Disabled</NxButton>
              <NxButton
                variant="primary"
                busy={busy}
                onClick={() => {
                  setBusy(true);
                  window.setTimeout(() => setBusy(false), 1500);
                }}
              >
                {busy ? 'Working…' : 'Start (sample)'}
              </NxButton>
            </div>
          </Panel>

          <Panel title="Form field" label="Controls">
            <form
              onSubmit={(event) => {
                event.preventDefault();
                setSubmitted(true);
              }}
              noValidate
            >
              <Field label="Name" hint="Shown to operators." error={nameError}>
                {(control) => (
                  <NxInput {...control} value={name} onChange={(e) => setName(e.target.value)} />
                )}
              </Field>
              <p style={{ marginTop: 12 }}>
                <NxButton type="submit" variant="primary">
                  Validate
                </NxButton>
              </p>
            </form>
          </Panel>

          <Panel title="Status indicators" label="Semantic colour">
            <div className="nx-page-header__actions">
              {tones.map((item) => (
                <StatusBadge key={item.tone} tone={item.tone}>
                  {item.label}
                </StatusBadge>
              ))}
            </div>
          </Panel>

          <Panel title="Information group" label="Layout">
            <InfoGroup
              items={[
                { label: 'Environment', value: 'Sample' },
                { label: 'Last verified event', value: <span className="nx-mono">Unknown</span> },
                {
                  label: 'Runtime',
                  value: <StatusBadge tone="unknown">Not connected</StatusBadge>,
                },
              ]}
            />
          </Panel>

          <Panel title="Table and filter" label="Data">
            <SearchFilter label="Filter sample records" value={query} onChange={setQuery} />
            <DataTable
              caption="Sample records"
              columns={columns}
              rows={filtered}
              rowKey={(row) => row.id}
              empty={{
                title: 'No matching records',
                description: 'Clear the filter to see all sample records.',
              }}
            />
          </Panel>

          <Panel title="States" label="Feedback">
            <LoadingState label="Loading sample data…" />
            <EmptyState title="Nothing here yet" description="Sample empty state." />
            <ErrorState
              title="Could not load sample data"
              description="Sample error state."
              onRetry={() => undefined}
            />
            <div>
              <NxButton variant="danger" onClick={() => setConfirming(true)}>
                Delete sample record…
              </NxButton>
              {confirmed && <p className="nx-muted">Confirmed (sample; nothing was deleted).</p>}
            </div>
          </Panel>
        </PageContainer>
      </main>
      <ConfirmDialog
        open={confirming}
        danger
        title="Delete sample record?"
        description="This is a demonstration. Nothing is deleted."
        confirmLabel="Delete"
        onCancel={() => setConfirming(false)}
        onConfirm={() => {
          setConfirming(false);
          setConfirmed(true);
        }}
      />
    </NxTheme>
  );
}
