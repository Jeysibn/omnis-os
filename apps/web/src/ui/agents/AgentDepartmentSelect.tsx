import { useEffect, useId, useRef, useState } from 'react';
import type { Department } from '@omnis/contracts';
import { ApiRequestError } from '../api.js';
import { fetchDepartments } from '../departments/data.js';

type DepartmentLoad =
  | { status: 'loading' }
  | { status: 'ready'; departments: Department[] }
  | { status: 'error'; message: string };

export function AgentDepartmentSelect({
  value,
  pendingDepartmentId,
  disabled,
  onChange,
  onUnauthorized,
}: {
  value: string | null;
  pendingDepartmentId: string | null;
  disabled: boolean;
  onChange: (value: string | null) => void;
  onUnauthorized: (cause: unknown) => void;
}) {
  const id = useId();
  const [departmentLoad, setDepartmentLoad] = useState<DepartmentLoad>({ status: 'loading' });
  const [retry, setRetry] = useState(0);
  const onUnauthorizedRef = useRef(onUnauthorized);
  onUnauthorizedRef.current = onUnauthorized;

  useEffect(() => {
    let current = true;
    setDepartmentLoad({ status: 'loading' });
    void fetchDepartments(false).then(
      (result) => {
        if (current)
          setDepartmentLoad({
            status: 'ready',
            departments: result.departments.filter((department) => department.archivedAt === null),
          });
      },
      (cause: unknown) => {
        if (!current) return;
        if (cause instanceof ApiRequestError && cause.status === 401)
          onUnauthorizedRef.current(cause);
        setDepartmentLoad({
          status: 'error',
          message:
            cause instanceof ApiRequestError && cause.status === 403
              ? "You don't have access to departments. You can still create this agent without one."
              : 'Departments could not be loaded. Retry, or create this agent without a department.',
        });
      },
    );
    return () => {
      current = false;
    };
  }, [retry]);

  return (
    <div className="agents-field">
      <label htmlFor={id}>Department</label>
      <select
        id={id}
        value={value ?? ''}
        disabled={disabled || departmentLoad.status === 'loading'}
        onChange={(event) => onChange(event.target.value || null)}
      >
        <option value="">
          {departmentLoad.status === 'loading' ? 'Loading departments…' : 'No department'}
        </option>
        {pendingDepartmentId &&
          !(
            departmentLoad.status === 'ready' &&
            departmentLoad.departments.some((department) => department.id === pendingDepartmentId)
          ) && <option value={pendingDepartmentId}>Selected department unavailable</option>}
        {departmentLoad.status === 'ready' &&
          departmentLoad.departments.map((department) => (
            <option key={department.id} value={department.id}>
              {department.name}
            </option>
          ))}
      </select>
      {departmentLoad.status === 'error' && (
        <div>
          <p role="status">{departmentLoad.message}</p>
          <button
            type="button"
            className="secondary-button"
            disabled={disabled}
            onClick={() => setRetry((attempt) => attempt + 1)}
          >
            Try departments again
          </button>
        </div>
      )}
    </div>
  );
}
