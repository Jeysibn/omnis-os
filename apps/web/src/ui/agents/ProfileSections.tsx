import type { ReactNode } from 'react';
import type { AgentProfileVersion } from '@omnis/contracts';
import { Text } from './shared.js';

const NOT_SPECIFIED = 'Not specified';

function Field({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="agents-fact">
      <dt>{label}</dt>
      <dd>
        {value ? <Text>{value}</Text> : <span className="agents-muted">{NOT_SPECIFIED}</span>}
      </dd>
    </div>
  );
}

function List({ items, empty }: { items: string[]; empty: string }) {
  if (items.length === 0) return <p className="agents-muted">{empty}</p>;
  return (
    <ul className="agents-plain-list">
      {items.map((item, index) => (
        <li key={`${index}-${item}`}>
          <Text>{item}</Text>
        </li>
      ))}
    </ul>
  );
}

export function Section({
  id,
  title,
  children,
}: {
  id: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="panel agents-section" aria-labelledby={`agents-${id}-heading`}>
      <h3 id={`agents-${id}-heading`} tabIndex={-1}>
        {title}
      </h3>
      {children}
    </section>
  );
}

/** Profession, personality/behavior and instructions of one immutable snapshot. */
export function SnapshotSections({ version }: { version: AgentProfileVersion }) {
  return (
    <>
      <Section id="profession" title="Profession">
        <dl className="agents-facts">
          <Field label="Title" value={version.profession} />
          <Field label="Seniority" value={version.seniority} />
        </dl>
        <h4>Specialties</h4>
        <List items={version.specialties} empty="None listed" />
      </Section>
      <Section id="personality" title="Personality and behavior">
        <h4>Traits</h4>
        <List items={version.personality.traits} empty={NOT_SPECIFIED} />
        <dl className="agents-facts">
          <Field label="Tone" value={version.personality.tone} />
          <Field label="Autonomy" value={version.behavior.autonomy} />
          <Field label="Escalation" value={version.behavior.escalation} />
        </dl>
        <h4>Principles</h4>
        <List items={version.personality.principles} empty={NOT_SPECIFIED} />
      </Section>
      <Section id="instructions" title="Instructions">
        <div
          className="agents-instructions"
          role="region"
          aria-label="Instructions (plain text)"
          tabIndex={0}
        >
          {version.instructions ? (
            <Text block>{version.instructions}</Text>
          ) : (
            <span className="agents-muted">{NOT_SPECIFIED}</span>
          )}
        </div>
      </Section>
    </>
  );
}

export function PermissionsNote() {
  return (
    <Section id="permissions" title="Permissions">
      <p>
        A job title or personality does not grant authority. Actions require explicit authorization
        recorded by Omnis OS.
      </p>
      <p className="agents-muted">Tool and skill permissions aren't shown in this release.</p>
    </Section>
  );
}
