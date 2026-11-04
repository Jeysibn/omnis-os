import { useCallback, useEffect, useRef, useState } from 'react';
import {
  CreateDepartmentSchema,
  DepartmentListResponseSchema,
  DepartmentSchema,
  type CreateDepartmentInput,
  type Department,
  type DepartmentListResponse,
} from '@omnis/contracts';
import { ApiRequestError, request } from '../api.js';

export type DeptErrorKind = 'forbidden' | 'unexpected' | 'limit' | 'failure';
export type DeptError = { kind: DeptErrorKind; message: string };
export type Loaded<T> =
  { status: 'loading' } | { status: 'ready'; data: T } | { status: 'error'; error: DeptError };

/** Maps a failed read to a UI state. Returns null for 401, which the shell handles. */
export function classifyReadError(
  cause: unknown,
  onUnauthorized: (cause: unknown) => void,
): DeptError | null {
  if (cause instanceof ApiRequestError) {
    if (cause.status === 401) {
      onUnauthorized(cause);
      return null;
    }
    if (cause.status === 403)
      return { kind: 'forbidden', message: "You don't have access to departments." };
    // 422 means this UI sent a query the API refused, which is a contract problem, not user error.
    if (cause.outcome === 'invalid-response' || cause.status === 422)
      return {
        kind: 'unexpected',
        message: 'Omnis OS received an unexpected department response.',
      };
    // The only 503 the list route documents is `limit`; other 503s fall through to the generic message.
    if (cause.status === 503 && cause.code === 'limit')
      return { kind: 'limit', message: 'The department list is too large to show reliably.' };
    return { kind: 'failure', message: cause.message };
  }
  return { kind: 'failure', message: 'Departments could not be loaded.' };
}

/** The strict schema plus the integrity rules the spec requires (unique ids and slugs). */
export function parseDepartmentList(value: unknown): DepartmentListResponse {
  const result = DepartmentListResponseSchema.parse(value);
  const ids = new Set(result.departments.map((item) => item.id));
  const slugs = new Set(result.departments.map((item) => item.slug));
  if (ids.size !== result.departments.length || slugs.size !== result.departments.length)
    throw new Error('Duplicate department id or slug.');
  return result;
}

export const fetchDepartments = (
  includeArchived: boolean,
  signal?: AbortSignal,
): Promise<DepartmentListResponse> =>
  request(
    includeArchived ? '/api/v1/departments?includeArchived=true' : '/api/v1/departments',
    signal ? { signal } : {},
    parseDepartmentList,
  );

function mustMatch(ok: boolean): void {
  if (!ok) throw new Error('Response does not match the request.');
}

/** A 2xx is only confirmation when the body is a valid Department that matches the request. */
export const createDepartment = (input: CreateDepartmentInput, csrfToken: string) =>
  request(
    '/api/v1/departments',
    { method: 'POST', headers: { 'x-omnis-csrf': csrfToken }, body: JSON.stringify(input) },
    (value) => {
      const department = DepartmentSchema.parse(value);
      mustMatch(department.slug === input.slug && department.name === input.name);
      return department;
    },
  );

export const renameDepartment = (id: string, input: CreateDepartmentInput, csrfToken: string) =>
  request(
    `/api/v1/departments/${encodeURIComponent(id)}`,
    { method: 'PATCH', headers: { 'x-omnis-csrf': csrfToken }, body: JSON.stringify(input) },
    (value) => {
      const department = DepartmentSchema.parse(value);
      mustMatch(
        department.id === id && department.slug === input.slug && department.name === input.name,
      );
      return department;
    },
  );

export type Failure =
  | { evidence: 'unauthorized' }
  | { evidence: 'rejected'; status: 403 | 404 | 409 | 422; code: string }
  | { evidence: 'unknown' };

/**
 * Evidence level of a failed mutation. Only a definitive 403/404/409/422 with a valid error
 * envelope is a rejection; every other failure leaves the outcome unknown (spec 7.2).
 */
export function classifyMutationFailure(cause: unknown): Failure {
  if (!(cause instanceof ApiRequestError)) return { evidence: 'unknown' };
  if (cause.status === 401) return { evidence: 'unauthorized' };
  if (
    cause.outcome === 'rejected' &&
    cause.code !== 'http_error' &&
    (cause.status === 403 || cause.status === 404 || cause.status === 409 || cause.status === 422)
  )
    return { evidence: 'rejected', status: cause.status, code: cause.code };
  return { evidence: 'unknown' };
}

export type FieldErrors = { name?: string; slug?: string };

/**
 * Client-side convenience checks. The shared schema decides validity; the messages only explain
 * it, and the server stays authoritative. Uppercase is reported, never lowercased silently.
 */
export function validateDepartmentInput(raw: { name: string; slug: string }): {
  errors: FieldErrors;
  value: CreateDepartmentInput | null;
} {
  const errors: FieldErrors = {};
  const name = raw.name.trim();
  const slug = raw.slug.trim();
  if (!CreateDepartmentSchema.shape.name.safeParse(name).success)
    errors.name = name.length === 0 ? 'Enter a name.' : 'Use 120 characters or fewer.';
  if (!CreateDepartmentSchema.shape.slug.safeParse(slug).success)
    errors.slug =
      slug.length === 0
        ? 'Enter a slug.'
        : slug.length > 80
          ? 'Use 80 characters or fewer.'
          : 'Use lowercase letters, numbers and single hyphens.';
  if (errors.name || errors.slug) return { errors, value: null };
  const parsed = CreateDepartmentSchema.safeParse({ slug, name });
  return parsed.success ? { errors, value: parsed.data } : { errors, value: null };
}

/** One list read keyed by the archived setting, with abort, race protection and reload. */
export function useDepartmentList(
  includeArchived: boolean,
  enabled: boolean,
  onUnauthorized: (cause: unknown) => void,
) {
  const [state, setState] = useState<{ key: boolean; value: Loaded<DepartmentListResponse> }>({
    key: includeArchived,
    value: { status: 'loading' },
  });
  const [attempt, setAttempt] = useState(0);
  const unauthorizedRef = useRef(onUnauthorized);
  unauthorizedRef.current = onUnauthorized;

  useEffect(() => {
    if (!enabled) return; // malformed links make no request
    const controller = new AbortController();
    setState({ key: includeArchived, value: { status: 'loading' } });
    fetchDepartments(includeArchived, controller.signal)
      .then((data) => {
        if (!controller.signal.aborted)
          setState({ key: includeArchived, value: { status: 'ready', data } });
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        const error = classifyReadError(cause, (value) => unauthorizedRef.current(value));
        if (error) setState({ key: includeArchived, value: { status: 'error', error } });
      });
    return () => controller.abort();
  }, [includeArchived, enabled, attempt]);

  const reload = useCallback(() => setAttempt((value) => value + 1), []);
  const value: Loaded<DepartmentListResponse> =
    state.key === includeArchived ? state.value : { status: 'loading' };
  return [value, reload] as const;
}

export type { Department };
