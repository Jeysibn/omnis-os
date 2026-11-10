import type { Ref } from 'react';
import type { Epic, Milestone } from '@omnis/contracts';
import { Notice } from '../parts.js';
import {
  archiveEpic,
  archiveMilestone,
  createEpic,
  createMilestone,
  fetchEpic,
  fetchEpics,
  fetchMilestone,
  fetchMilestones,
  updateEpic,
  updateMilestone,
} from './data.js';
import { EpicTasks, type EpicTaskRef } from './EpicTasks.js';
import { RecordsPanel } from './RecordsPanel.js';

type Props = {
  projectId: string;
  readOnly: boolean;
  csrfToken: string;
  refreshCsrf: () => Promise<string>;
  onUnauthorized: (cause: unknown) => void;
  /** Bumped when a task moved between epics, so open epic task lists are read again. */
  version: number;
  onChangeEpic: (task: EpicTaskRef) => void;
  message: string | null;
  statusRef: Ref<HTMLDivElement>;
  announce: (text: string) => void;
};

/** Epics and milestones for one project: the planning half of the project workspace. */
export function PlanningRegion({
  projectId,
  readOnly,
  csrfToken,
  refreshCsrf,
  onUnauthorized,
  version,
  onChangeEpic,
  message,
  statusRef,
  announce,
}: Props) {
  const shared = { projectId, readOnly, csrfToken, refreshCsrf, onUnauthorized, announce };
  const fallbackFocus = () => document.querySelector<HTMLElement>('[data-planning-status]');
  return (
    <>
      <div
        ref={statusRef}
        tabIndex={-1}
        data-planning-status
        className="pw-planning-status pw-area-status"
        aria-live="polite"
      >
        {message && <Notice tone="success">{message}</Notice>}
      </div>
      <div className="pw-area-epics">
        <RecordsPanel<Epic>
          {...shared}
          kind="epic"
          title="Epics"
          fallbackFocus={fallbackFocus}
          fetchPage={(cursor, signal) =>
            fetchEpics(projectId, cursor, signal).then((result) => ({
              items: result.epics,
              page: result.page,
            }))
          }
          create={(changes, key, csrf) =>
            createEpic(
              projectId,
              {
                title: changes.title ?? '',
                ...(changes.description ? { description: changes.description } : {}),
              },
              key,
              csrf,
            )
          }
          update={(epic, changes, key, csrf) =>
            updateEpic(
              projectId,
              epic.id,
              { expectedRevision: epic.revision, ...changes } as Parameters<typeof updateEpic>[2],
              key,
              csrf,
            )
          }
          archive={(epic, key, csrf) => archiveEpic(projectId, epic.id, epic.revision, key, csrf)}
          read={(id) => fetchEpic(projectId, id)}
          detailsLabel="tasks"
          details={(epic) => (
            <EpicTasks
              projectId={projectId}
              epic={epic}
              version={version}
              readOnly={readOnly}
              onUnauthorized={onUnauthorized}
              onChangeEpic={onChangeEpic}
            />
          )}
        />
      </div>
      <div className="pw-area-milestones">
        <RecordsPanel<Milestone>
          {...shared}
          kind="milestone"
          title="Milestones"
          fallbackFocus={fallbackFocus}
          fetchPage={(cursor, signal) =>
            fetchMilestones(projectId, cursor, signal).then((result) => ({
              items: result.milestones,
              page: result.page,
            }))
          }
          create={(changes, key, csrf) =>
            createMilestone(
              projectId,
              {
                title: changes.title ?? '',
                ...(changes.description ? { description: changes.description } : {}),
                ...(changes.targetDate ? { targetDate: changes.targetDate } : {}),
              },
              key,
              csrf,
            )
          }
          update={(milestone, changes, key, csrf) =>
            updateMilestone(
              projectId,
              milestone.id,
              { expectedRevision: milestone.revision, ...changes } as Parameters<
                typeof updateMilestone
              >[2],
              key,
              csrf,
            )
          }
          archive={(milestone, key, csrf) =>
            archiveMilestone(projectId, milestone.id, milestone.revision, key, csrf)
          }
          read={(id) => fetchMilestone(projectId, id)}
        />
      </div>
    </>
  );
}
