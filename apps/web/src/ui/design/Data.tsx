import type { ReactNode } from 'react';
import { Field, NxInput } from './Controls.js';
import { EmptyState } from './States.js';
import './design.css';

export type Column<Row> = {
  key: string;
  header: string;
  render: (row: Row) => ReactNode;
};

type DataTableProps<Row> = {
  /** Required: names the table for assistive technology and states what it lists. */
  caption: string;
  columns: readonly Column<Row>[];
  rows: readonly Row[];
  rowKey: (row: Row) => string;
  /** Shown instead of the table when `rows` is empty. */
  empty: { title: string; description?: string | undefined };
};

/**
 * A semantic table. It scrolls horizontally inside its own region on narrow screens instead of
 * widening the page, and that region is keyboard-focusable so it can be scrolled without a mouse.
 */
export function DataTable<Row>({ caption, columns, rows, rowKey, empty }: DataTableProps<Row>) {
  if (rows.length === 0) return <EmptyState title={empty.title} description={empty.description} />;
  return (
    // The scrollable region must be keyboard reachable, so it takes tabIndex 0.
    <div className="nx-table-wrap" tabIndex={0} role="region" aria-label={caption}>
      <table className="nx-table">
        <caption>{caption}</caption>
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column.key} scope="col">
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={rowKey(row)}>
              {columns.map((column) => (
                <td key={column.key}>{column.render(row)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** A labelled search field for filtering a list. The parent owns the value and the filtering. */
export function SearchFilter({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="nx-filters" role="search" aria-label="Filters">
      <Field label={label}>
        {(control) => (
          <NxInput
            {...control}
            type="search"
            value={value}
            onChange={(event) => onChange(event.target.value)}
          />
        )}
      </Field>
    </div>
  );
}
