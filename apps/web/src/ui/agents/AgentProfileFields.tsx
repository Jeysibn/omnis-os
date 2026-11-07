import type { Dispatch, SetStateAction } from 'react';
import type { AgentProfileWriteInput } from '@omnis/contracts';

function lines(value: string) {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function displayLines(value: readonly string[]) {
  return value.join('\n');
}

export function AgentProfileFields({
  value,
  disabled,
  onChange,
}: {
  value: AgentProfileWriteInput;
  disabled: boolean;
  onChange: Dispatch<SetStateAction<AgentProfileWriteInput>>;
}) {
  const updateList = (path: 'specialties' | 'traits' | 'principles', text: string) => {
    if (path === 'specialties') onChange((current) => ({ ...current, specialties: lines(text) }));
    else if (path === 'traits')
      onChange((current) => ({
        ...current,
        personality: { ...current.personality, traits: lines(text) },
      }));
    else
      onChange((current) => ({
        ...current,
        personality: { ...current.personality, principles: lines(text) },
      }));
  };

  return (
    <>
      <label>
        Profession
        <input
          maxLength={160}
          value={value.profession}
          disabled={disabled}
          onChange={(event) =>
            onChange((current) => ({ ...current, profession: event.target.value }))
          }
        />
      </label>
      <label>
        Seniority
        <input
          maxLength={80}
          value={value.seniority ?? ''}
          disabled={disabled}
          onChange={(event) =>
            onChange((current) => ({ ...current, seniority: event.target.value || null }))
          }
        />
      </label>
      <label>
        Specialties (one per line)
        <textarea
          rows={3}
          value={displayLines(value.specialties)}
          disabled={disabled}
          onChange={(event) => updateList('specialties', event.target.value)}
        />
      </label>
      <label>
        Personality traits (one per line)
        <textarea
          rows={3}
          value={displayLines(value.personality.traits)}
          disabled={disabled}
          onChange={(event) => updateList('traits', event.target.value)}
        />
      </label>
      <label>
        Tone
        <input
          maxLength={120}
          value={value.personality.tone ?? ''}
          disabled={disabled}
          onChange={(event) =>
            onChange((current) => ({
              ...current,
              personality: { ...current.personality, tone: event.target.value || null },
            }))
          }
        />
      </label>
      <label>
        Principles (one per line)
        <textarea
          rows={3}
          value={displayLines(value.personality.principles)}
          disabled={disabled}
          onChange={(event) => updateList('principles', event.target.value)}
        />
      </label>
      <label>
        Autonomy
        <textarea
          rows={3}
          maxLength={500}
          value={value.behavior.autonomy ?? ''}
          disabled={disabled}
          onChange={(event) =>
            onChange((current) => ({
              ...current,
              behavior: { ...current.behavior, autonomy: event.target.value || null },
            }))
          }
        />
      </label>
      <label>
        Escalation
        <textarea
          rows={3}
          maxLength={1000}
          value={value.behavior.escalation ?? ''}
          disabled={disabled}
          onChange={(event) =>
            onChange((current) => ({
              ...current,
              behavior: { ...current.behavior, escalation: event.target.value || null },
            }))
          }
        />
      </label>
      <label className="agents-profile-instructions">
        Instructions
        <textarea
          rows={8}
          maxLength={16_384}
          value={value.instructions}
          disabled={disabled}
          onChange={(event) =>
            onChange((current) => ({ ...current, instructions: event.target.value }))
          }
        />
      </label>
    </>
  );
}
