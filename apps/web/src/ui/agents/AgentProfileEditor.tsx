import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AgentProfileWriteInputSchema,
  type AgentProfileResponse,
  type AgentProfileWriteInput,
} from '@omnis/contracts';
import { ApiRequestError } from '../api.js';
import { classifyError, fetchDraft, publishDraft, saveDraft } from './data.js';
import { AgentProfileFields } from './AgentProfileFields.js';

type PendingOperation =
  | {
      kind: 'save';
      requestId: string;
      input: {
        expectedDraftRevision: number;
        baseVersionNo: number | null;
        profile: AgentProfileWriteInput;
      };
    }
  | {
      kind: 'publish';
      requestId: string;
      input: { expectedVersionNo: number | null; expectedDraftRevision: number };
    };

const emptyProfile: AgentProfileWriteInput = {
  profession: '',
  seniority: null,
  specialties: [],
  personality: { traits: [], tone: null, principles: [] },
  behavior: { autonomy: null, escalation: null },
  instructions: '',
};

function fromVersion(profile: AgentProfileResponse['currentVersion']): AgentProfileWriteInput {
  if (!profile) return emptyProfile;
  return {
    profession: profile.profession,
    seniority: profile.seniority,
    specialties: profile.specialties,
    personality: profile.personality,
    behavior: profile.behavior,
    instructions: profile.instructions,
  };
}

export function AgentProfileEditor({
  profile,
  csrfToken,
  onUnauthorized,
  onConflict,
  onPublished,
}: {
  profile: AgentProfileResponse;
  csrfToken: string;
  onUnauthorized: (cause: unknown) => void;
  onConflict: () => void;
  onPublished: () => void;
}) {
  const { agent, currentVersion } = profile;
  const [draft, setDraft] = useState<Awaited<ReturnType<typeof fetchDraft>> | null>(null);
  const [draftError, setDraftError] = useState('');
  const [generation, setGeneration] = useState(0);
  const [editing, setEditing] = useState(currentVersion === null);
  const [form, setForm] = useState<AgentProfileWriteInput>(fromVersion(currentVersion));
  const [pending, setPending] = useState<PendingOperation | null>(null);
  const [busy, setBusy] = useState(false);
  const [unknown, setUnknown] = useState(false);
  const [message, setMessage] = useState('');
  const unauthorizedRef = useRef(onUnauthorized);
  unauthorizedRef.current = onUnauthorized;

  useEffect(() => {
    const controller = new AbortController();
    setDraft(null);
    setDraftError('');
    void fetchDraft(agent.id, controller.signal)
      .then((result) => {
        if (controller.signal.aborted) return;
        setDraft(result);
        setForm(result.profile ?? fromVersion(currentVersion));
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        const error = classifyError(cause, (value) => unauthorizedRef.current(value));
        if (error) setDraftError(error.message);
      });
    return () => controller.abort();
  }, [agent.id, currentVersion, generation]);

  const savedProfile = draft?.profile ?? (currentVersion ? fromVersion(currentVersion) : null);
  const dirty = useMemo(
    () => JSON.stringify(form) !== JSON.stringify(savedProfile),
    [form, savedProfile],
  );
  const locked = busy || unknown;

  async function perform(operation: PendingOperation) {
    setPending(operation);
    setBusy(true);
    setMessage('');
    try {
      if (operation.kind === 'save') {
        const receipt = await saveDraft(agent.id, operation.input, csrfToken, operation.requestId);
        setDraft({
          agentId: agent.id,
          draftRevision: receipt.draftRevision,
          baseVersionNo: operation.input.baseVersionNo,
          profile: operation.input.profile,
          updatedAt: receipt.occurredAt,
        });
        setForm(operation.input.profile);
        setEditing(false);
        setMessage('The server confirmed that the profile draft was saved.');
      } else {
        await publishDraft(agent.id, operation.input, csrfToken, operation.requestId);
        setEditing(false);
        setPending(null);
        setUnknown(false);
        setMessage('');
        setGeneration((value) => value + 1);
        onPublished();
      }
      setPending(null);
      setUnknown(false);
    } catch (cause) {
      if (cause instanceof ApiRequestError && cause.status === 401) {
        onUnauthorized(cause);
      } else if (cause instanceof ApiRequestError && cause.outcome !== 'rejected') {
        setUnknown(true);
        setMessage(
          `The ${operation.kind === 'save' ? 'save' : 'publish'} result is unknown. Retry the exact request before editing again.`,
        );
      } else {
        setPending(null);
        setUnknown(false);
        const error = classifyError(cause, onUnauthorized);
        setMessage(error?.message ?? 'The profile change was not confirmed.');
        if (cause instanceof ApiRequestError && cause.status === 409) {
          setGeneration((value) => value + 1);
          onConflict();
        }
      }
    } finally {
      setBusy(false);
    }
  }

  function save() {
    if (!draft) return;
    const parsed = AgentProfileWriteInputSchema.safeParse({
      ...form,
      profession: form.profession.trim(),
      seniority: form.seniority?.trim() || null,
      specialties: form.specialties.map((item) => item.trim()).filter(Boolean),
      personality: {
        traits: form.personality.traits.map((item) => item.trim()).filter(Boolean),
        tone: form.personality.tone?.trim() || null,
        principles: form.personality.principles.map((item) => item.trim()).filter(Boolean),
      },
      behavior: {
        autonomy: form.behavior.autonomy?.trim() || null,
        escalation: form.behavior.escalation?.trim() || null,
      },
    });
    if (!parsed.success) {
      setMessage('Review the profile fields. One or more values exceed the supported limits.');
      return;
    }
    void perform({
      kind: 'save',
      requestId: crypto.randomUUID(),
      input: {
        expectedDraftRevision: draft.draftRevision,
        baseVersionNo: draft.profile ? draft.baseVersionNo : (currentVersion?.versionNo ?? null),
        profile: parsed.data,
      },
    });
  }

  function publish() {
    if (!draft?.profile || dirty) return;
    void perform({
      kind: 'publish',
      requestId: crypto.randomUUID(),
      input: {
        expectedVersionNo: currentVersion?.versionNo ?? null,
        expectedDraftRevision: draft.draftRevision,
      },
    });
  }

  if (agent.lifecycle === 'archived') return null;
  if (draftError)
    return (
      <div className="agents-create-error" role="alert">
        Profile management is unavailable: {draftError}
      </div>
    );
  if (!draft)
    return (
      <p className="agents-muted" role="status">
        Loading profile draft…
      </p>
    );

  return (
    <section className="agents-profile-editor" aria-labelledby="agent-profile-editor-heading">
      <div className="agents-profile-editor-head">
        <div>
          <h3 id="agent-profile-editor-heading">Profile management</h3>
          <p>
            Profile versions are immutable after publication. Credentials and secrets are not
            profile content.
          </p>
        </div>
        {!editing && (
          <button type="button" className="secondary-button" onClick={() => setEditing(true)}>
            {draft.profile ? 'Edit draft' : currentVersion ? 'Create next draft' : 'Define profile'}
          </button>
        )}
      </div>
      {message && <p role="status">{message}</p>}
      {unknown && pending && (
        <div className="agents-profile-editor-actions">
          <button
            type="button"
            className="secondary-button"
            disabled={busy}
            onClick={() => void perform(pending)}
          >
            Retry same request
          </button>
        </div>
      )}
      {editing && (
        <div className="agents-profile-editor-fields" aria-disabled={locked}>
          <AgentProfileFields value={form} disabled={locked} onChange={setForm} />
          <div className="agents-profile-editor-actions">
            <button
              type="button"
              className="secondary-button"
              disabled={busy}
              onClick={() => {
                setForm(savedProfile ?? emptyProfile);
                setEditing(false);
              }}
            >
              Cancel editing
            </button>
            <button
              type="button"
              className="primary-button"
              disabled={locked || !csrfToken}
              onClick={save}
            >
              {busy && pending?.kind === 'save' ? 'Saving…' : 'Save draft'}
            </button>
          </div>
        </div>
      )}
      {draft.profile && !editing && (
        <div className="agents-profile-editor-actions">
          <span className="agents-muted">Draft revision {draft.draftRevision}</span>
          <button
            type="button"
            className="primary-button"
            disabled={locked || dirty || !csrfToken}
            onClick={publish}
          >
            {busy && pending?.kind === 'publish' ? 'Publishing…' : 'Publish immutable version'}
          </button>
        </div>
      )}
    </section>
  );
}
