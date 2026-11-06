import type { ReactNode, Ref } from 'react';
import './design.css';

/** Applies the NEXUS tokens and base typography to everything inside it. */
export function NxTheme({ children }: { children: ReactNode }) {
  return <div className="nx-theme">{children}</div>;
}

/**
 * A responsive, centred page column. It never forces a width, so it cannot cause overflow.
 * It is a plain div: the host page owns the single <main> landmark and the skip link target.
 */
export function PageContainer({ children }: { children: ReactNode }) {
  return <div className="nx-container">{children}</div>;
}

/** Small mono telemetry label (identifiers, section eyebrows, column captions). */
export function TelemetryLabel({ children }: { children: ReactNode }) {
  return <span className="nx-label">{children}</span>;
}

type PageHeaderProps = {
  title: string;
  /** Mono eyebrow above the title, for example the module name. */
  eyebrow?: string | undefined;
  description?: string | undefined;
  /** Page-level actions, usually one primary `NxButton`. */
  actions?: ReactNode;
};

/** The one h1 of a page, with an optional eyebrow, description and actions. */
export function PageHeader({ title, eyebrow, description, actions }: PageHeaderProps) {
  return (
    <header className="nx-page-header">
      <div className="nx-page-header__text">
        {eyebrow && <TelemetryLabel>{eyebrow}</TelemetryLabel>}
        <h1>{title}</h1>
        {description && <p className="nx-muted">{description}</p>}
      </div>
      {actions && <div className="nx-page-header__actions">{actions}</div>}
    </header>
  );
}

type PanelProps = {
  title: string;
  /** Heading level, so a panel nests correctly under the page's h1. Defaults to h2. */
  level?: 2 | 3;
  label?: string | undefined;
  actions?: ReactNode;
  /** Makes the heading programmatically focusable (tabIndex -1), so a host can move focus to it. */
  headingRef?: Ref<HTMLHeadingElement>;
  children: ReactNode;
};

/** A titled surface. The region is named by its heading. */
export function Panel({ title, level = 2, label, actions, headingRef, children }: PanelProps) {
  const Heading = level === 2 ? 'h2' : 'h3';
  return (
    <section className="nx-panel" aria-label={title}>
      <div className="nx-panel__head">
        <div>
          {label && <TelemetryLabel>{label}</TelemetryLabel>}
          <Heading ref={headingRef} tabIndex={headingRef ? -1 : undefined}>
            {title}
          </Heading>
        </div>
        {actions}
      </div>
      {children}
    </section>
  );
}

/** A group of label/value facts, built on a real description list. */
export function InfoGroup({ items }: { items: readonly { label: string; value: ReactNode }[] }) {
  return (
    <dl className="nx-info">
      {items.map((item) => (
        <div key={item.label}>
          <dt>
            <TelemetryLabel>{item.label}</TelemetryLabel>
          </dt>
          <dd>{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}
