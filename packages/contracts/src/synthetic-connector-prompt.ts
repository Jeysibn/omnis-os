import {
  AgentProfileVersionSchema,
  TaskSchema,
  type AgentProfileVersion,
  type Task,
} from './index.ts';

export const SyntheticConnectorPromptVersion = 'omnis.synthetic-connector-request.v1';
const maxRenderedRequestBytes = 32_000;

/** Canonical prompt used both for owner approval and later task-run reconstruction. */
export function renderSyntheticConnectorRequest(taskInput: unknown, profileInput: unknown): string {
  const task = TaskSchema.parse(taskInput);
  const profile = AgentProfileVersionSchema.parse(profileInput);
  const rendered = JSON.stringify({
    version: SyntheticConnectorPromptVersion,
    task: {
      id: task.id,
      title: task.title,
      detail: task.detail,
    },
    agentProfile: {
      agentId: profile.agentId,
      versionNo: profile.versionNo,
      profession: profile.profession,
      seniority: profile.seniority,
      specialties: profile.specialties,
      personality: profile.personality,
      behavior: profile.behavior,
      instructions: profile.instructions,
    },
  });
  if (new TextEncoder().encode(rendered).byteLength > maxRenderedRequestBytes) {
    throw new Error('The rendered synthetic connector request exceeds its size limit.');
  }
  if (rendered.includes('\0')) {
    throw new Error('The rendered synthetic connector request contains invalid text.');
  }
  return rendered;
}

export type { AgentProfileVersion, Task };
