import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AgentDirectoryResponseSchema,
  AgentIdempotencyKeySchema,
  AgentMutationReceiptSchema,
  AgentIdentityUpdateReceiptSchema,
  AgentProfileDraftResponseSchema,
  AgentProfileResponseSchema,
  AgentProfileVersionResponseSchema,
  AgentProfileVersionsResponseSchema,
  type AgentDirectoryResponse,
  type AgentMutationReceipt,
  type UpdateAgentIdentityInput,
  type AgentProfileDraftResponse,
  type AgentProfileWriteInput,
  type AgentProfileResponse,
  type AgentProfileVersionResponse,
  type AgentProfileVersionSummary,
  type AgentSummary,
} from '@omnis/contracts';
import { ApiRequestError, request } from '../api.js';

export type AgentsErrorKind = 'forbidden' | 'not-found' | 'unexpected' | 'failure';
export type AgentsError = { kind: AgentsErrorKind; message: string };
export type Loaded<T> =
  { status: 'loading' } | { status: 'ready'; data: T } | { status: 'error'; error: AgentsError };

const unexpectedMessage = 'Omnis OS received an unexpected agent response.';

/** Maps a failure to a UI state. Returns null for 401, which the shell handles. */
export function classifyError(cause: unknown, onUnauthorized: (cause: unknown) => void) {
  if (cause instanceof ApiRequestError) {
    if (cause.status === 401) {
      onUnauthorized(cause);
      return null;
    }
    if (cause.status === 403)
      return { kind: 'forbidden', message: "You don't have access to agents." } as AgentsError;
    if (cause.status === 404) return { kind: 'not-found', message: 'Not found.' } as AgentsError;
    if (cause.outcome === 'invalid-response')
      return { kind: 'unexpected', message: unexpectedMessage } as AgentsError;
    return { kind: 'failure', message: cause.message } as AgentsError;
  }
  return { kind: 'failure', message: 'Agents could not be loaded.' } as AgentsError;
}

function mismatch(): never {
  throw new Error('Response does not match the requested route.');
}

export const fetchDirectory = (signal: AbortSignal): Promise<AgentDirectoryResponse> =>
  request('/api/v1/agents', { signal }, (value) => AgentDirectoryResponseSchema.parse(value));

export const fetchProfile = (agentId: string, signal: AbortSignal): Promise<AgentProfileResponse> =>
  request(`/api/v1/agents/${encodeURIComponent(agentId)}`, { signal }, (value) => {
    const result = AgentProfileResponseSchema.parse(value);
    if (result.agent.id !== agentId) mismatch();
    return result;
  });

export const archiveAgent = (agentId: string, requestId: string, csrfToken: string) => {
  if (!AgentIdempotencyKeySchema.safeParse(requestId).success) mismatch();
  return request(
    `/api/v1/agents/${encodeURIComponent(agentId)}/archive`,
    {
      method: 'POST',
      headers: { 'x-omnis-csrf': csrfToken, 'idempotency-key': requestId },
    },
    (value) => {
      const receipt = AgentMutationReceiptSchema.parse(value);
      if (
        receipt.requestId !== requestId ||
        receipt.operation !== 'agent.archived' ||
        receipt.agentId !== agentId ||
        receipt.lifecycle !== 'archived'
      )
        mismatch();
      return receipt;
    },
  );
};

export const updateAgentIdentity = (
  agentId: string,
  input: UpdateAgentIdentityInput,
  csrfToken: string,
  requestId: string,
) => {
  if (!AgentIdempotencyKeySchema.safeParse(requestId).success) mismatch();
  return request(
    `/api/v1/agents/${encodeURIComponent(agentId)}/identity`,
    {
      method: 'PUT',
      headers: { 'x-omnis-csrf': csrfToken, 'idempotency-key': requestId },
      body: JSON.stringify(input),
    },
    (value) => {
      const receipt = AgentIdentityUpdateReceiptSchema.parse(value);
      if (
        receipt.requestId !== requestId ||
        receipt.operation !== 'agent.identity_updated' ||
        receipt.agentId !== agentId ||
        receipt.name !== input.name.trim() ||
        receipt.slug !== input.slug ||
        receipt.identityRevision !== input.expectedIdentityRevision + 1
      )
        mismatch();
      return receipt;
    },
  );
};

export const fetchDraft = (
  agentId: string,
  signal: AbortSignal,
): Promise<AgentProfileDraftResponse> =>
  request(`/api/v1/agents/${encodeURIComponent(agentId)}/draft-profile`, { signal }, (value) => {
    const result = AgentProfileDraftResponseSchema.parse(value);
    if (result.agentId !== agentId) mismatch();
    return result;
  });

export const saveDraft = (
  agentId: string,
  input: {
    expectedDraftRevision: number;
    baseVersionNo: number | null;
    profile: AgentProfileWriteInput;
  },
  csrfToken: string,
  requestId: string,
): Promise<AgentMutationReceipt> =>
  request(
    `/api/v1/agents/${encodeURIComponent(agentId)}/draft-profile`,
    {
      method: 'PUT',
      headers: { 'x-omnis-csrf': csrfToken, 'idempotency-key': requestId },
      body: JSON.stringify(input),
    },
    (value) => {
      const result = AgentMutationReceiptSchema.parse(value);
      if (
        result.requestId !== requestId ||
        result.operation !== 'profile.draft_saved' ||
        result.agentId !== agentId ||
        result.draftRevision !== input.expectedDraftRevision + 1
      )
        mismatch();
      return result;
    },
  );

export const publishDraft = (
  agentId: string,
  input: { expectedVersionNo: number | null; expectedDraftRevision: number },
  csrfToken: string,
  requestId: string,
): Promise<AgentMutationReceipt> =>
  request(
    `/api/v1/agents/${encodeURIComponent(agentId)}/publish`,
    {
      method: 'POST',
      headers: { 'x-omnis-csrf': csrfToken, 'idempotency-key': requestId },
      body: JSON.stringify(input),
    },
    (value) => {
      const result = AgentMutationReceiptSchema.parse(value);
      if (
        result.requestId !== requestId ||
        result.operation !== 'profile.published' ||
        result.agentId !== agentId ||
        result.lifecycle !== 'available' ||
        result.versionNo !== (input.expectedVersionNo ?? 0) + 1
      )
        mismatch();
      return result;
    },
  );

export const fetchVersion = (
  agentId: string,
  version: number,
  signal: AbortSignal,
): Promise<AgentProfileVersionResponse> =>
  request(
    `/api/v1/agents/${encodeURIComponent(agentId)}/versions/${version}`,
    { signal },
    (value) => {
      const result = AgentProfileVersionResponseSchema.parse(value);
      if (
        result.agent.id !== agentId ||
        result.version.agentId !== agentId ||
        result.version.versionNo !== version
      )
        mismatch();
      return result;
    },
  );

/** One keyed resource with abort, race protection and Retry. State from other keys is never shown. */
export function useAgentResource<T>(
  key: string,
  load: (signal: AbortSignal) => Promise<T>,
  onUnauthorized: (cause: unknown) => void,
) {
  const [state, setState] = useState<{ key: string; value: Loaded<T> }>({
    key,
    value: { status: 'loading' },
  });
  const [attempt, setAttempt] = useState(0);
  const loadRef = useRef(load);
  loadRef.current = load;
  const unauthorizedRef = useRef(onUnauthorized);
  unauthorizedRef.current = onUnauthorized;

  useEffect(() => {
    const controller = new AbortController();
    setState({ key, value: { status: 'loading' } });
    loadRef
      .current(controller.signal)
      .then((data) => {
        if (!controller.signal.aborted) setState({ key, value: { status: 'ready', data } });
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        const error = classifyError(cause, (value) => unauthorizedRef.current(value));
        if (error) setState({ key, value: { status: 'error', error } });
      });
    return () => controller.abort();
  }, [key, attempt]);

  const retry = useCallback(() => setAttempt((value) => value + 1), []);
  const value: Loaded<T> = state.key === key ? state.value : { status: 'loading' };
  return [value, retry] as const;
}

export type HistoryProblem = { kind: 'changed' | 'invalid' | 'failure'; message: string };
export type HistoryState =
  | { status: 'loading' }
  | { status: 'error'; error: AgentsError }
  | {
      status: 'ready';
      agent: AgentSummary;
      versions: AgentProfileVersionSummary[];
      total: number;
      complete: boolean;
      nextCursor: string | null;
      loadingMore: boolean;
      problem: HistoryProblem | null;
    };

/**
 * Version history, one page at a time. Only properties observable in the received pages are
 * checked here; that the backend omitted no record is a backend guarantee this cannot prove.
 */
export function useVersionHistory(agentId: string, onUnauthorized: (cause: unknown) => void) {
  const [state, setState] = useState<{ agentId: string; value: HistoryState }>({
    agentId,
    value: { status: 'loading' },
  });
  const [generation, setGeneration] = useState(0);
  const controllerRef = useRef<AbortController | null>(null);
  const busyRef = useRef(false);
  const valueRef = useRef<HistoryState>({ status: 'loading' });
  const unauthorizedRef = useRef(onUnauthorized);
  unauthorizedRef.current = onUnauthorized;

  const commit = useCallback(
    (value: HistoryState) => {
      valueRef.current = value;
      setState({ agentId, value });
    },
    [agentId],
  );

  const loadPage = useCallback(
    async (cursor: string | null, signal: AbortSignal) => {
      const previous = valueRef.current;
      const accumulated = previous.status === 'ready' && cursor !== null ? previous : null;
      busyRef.current = true;
      if (accumulated) commit({ ...accumulated, loadingMore: true, problem: null });
      const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
      try {
        const page = await request(
          `/api/v1/agents/${encodeURIComponent(agentId)}/versions${query}`,
          { signal },
          (value) => AgentProfileVersionsResponseSchema.parse(value),
        );
        if (signal.aborted) return;
        const known = accumulated?.versions ?? [];
        const problem = checkPage({
          agentId,
          agent: page.agent,
          known,
          knownTotal: accumulated?.total ?? null,
          sentCursor: cursor,
          page: page.versions,
          total: page.page.total,
          complete: page.page.complete,
          nextCursor: page.page.nextCursor,
        });
        if (problem) {
          if (accumulated) commit({ ...accumulated, loadingMore: false, problem });
          else
            commit({
              status: 'error',
              error: { kind: 'unexpected', message: unexpectedMessage },
            });
          return;
        }
        commit({
          status: 'ready',
          agent: page.agent,
          versions: [...known, ...page.versions],
          total: page.page.total,
          complete: page.page.complete,
          nextCursor: page.page.nextCursor,
          loadingMore: false,
          problem: null,
        });
      } catch (cause) {
        if (signal.aborted) return;
        const error = classifyError(cause, (value) => unauthorizedRef.current(value));
        if (!error) return;
        if (accumulated) {
          commit({
            ...accumulated,
            loadingMore: false,
            problem: {
              kind: error.kind === 'unexpected' ? 'invalid' : 'failure',
              message: error.message,
            },
          });
        } else commit({ status: 'error', error });
      } finally {
        busyRef.current = false;
      }
    },
    [agentId, commit],
  );

  useEffect(() => {
    const controller = new AbortController();
    controllerRef.current = controller;
    valueRef.current = { status: 'loading' };
    busyRef.current = false;
    setState({ agentId, value: { status: 'loading' } });
    void loadPage(null, controller.signal);
    return () => controller.abort();
  }, [agentId, generation, loadPage]);

  const loadMore = useCallback(() => {
    const current = valueRef.current;
    const controller = controllerRef.current;
    if (busyRef.current || !controller || current.status !== 'ready' || !current.nextCursor) return;
    void loadPage(current.nextCursor, controller.signal);
  }, [loadPage]);
  const reload = useCallback(() => setGeneration((value) => value + 1), []);
  const value: HistoryState = state.agentId === agentId ? state.value : { status: 'loading' };
  return { state: value, loadMore, reload };
}

function checkPage(input: {
  agentId: string;
  agent: AgentSummary;
  known: AgentProfileVersionSummary[];
  knownTotal: number | null;
  sentCursor: string | null;
  page: AgentProfileVersionSummary[];
  total: number;
  complete: boolean;
  nextCursor: string | null;
}): HistoryProblem | null {
  const invalid = (message: string): HistoryProblem => ({ kind: 'invalid', message });
  if (input.agent.id !== input.agentId) return invalid(unexpectedMessage);
  if (input.knownTotal !== null && input.total !== input.knownTotal)
    return { kind: 'changed', message: 'History changed while loading.' };
  const numbers = new Set(input.known.map((version) => version.versionNo));
  const ids = new Set(input.known.map((version) => version.versionId));
  for (const version of input.page) {
    if (numbers.has(version.versionNo) || ids.has(version.versionId))
      return invalid(unexpectedMessage);
  }
  const last = input.known[input.known.length - 1];
  const first = input.page[0];
  if (last && first && first.versionNo >= last.versionNo) return invalid(unexpectedMessage);
  const count = input.known.length + input.page.length;
  if (count > input.total) return invalid(unexpectedMessage);
  if (input.complete && count !== input.total) return invalid(unexpectedMessage);
  if (!input.complete) {
    if (input.page.length === 0 || input.nextCursor === input.sentCursor)
      return invalid(unexpectedMessage);
  }
  return null;
}
