import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  createRenderedRequestDigest,
  type ConnectorAuthorizationRequest,
} from '@omnis/contracts/connector-authorization';
import { AgentProfileVersionSchema } from '@omnis/contracts';
import { renderSyntheticConnectorRequest } from '@omnis/contracts/synthetic-connector-prompt';
import {
  SyntheticTaskRunRequestSchema,
  SyntheticTaskRunResponseSchema,
  type SyntheticTaskRunRequest,
  type SyntheticTaskRunResponse,
} from '@omnis/contracts/synthetic-task-run';
import type {
  EnqueueRun,
  PostgresAgentProfileStore,
  PostgresRunStore,
  SyntheticBrokerRun,
  SyntheticBrokerRunResult,
} from '@omnis/db';
import type { Run } from '@omnis/contracts';
import type { SyntheticBrokerExecutor } from './synthetic-broker-client.ts';
import type { DurableEvent } from '@omnis/db';

const runLeaseSeconds = 30;
const heartbeatMs = 5_000;
const QueueJobSchema = z
  .object({
    runId: z
      .string()
      .regex(
        /^(?:run-[0-9]{4,}|[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i,
      ),
  })
  .strict();

export class SyntheticBrokerRunCoordinator {
  private readonly store: PostgresRunStore;
  private readonly profiles: PostgresAgentProfileStore;
  private readonly broker: SyntheticBrokerExecutor;
  private readonly enqueue: EnqueueRun;
  private readonly publish: (events: DurableEvent[]) => void;
  private readonly workerId = randomUUID();

  constructor(input: {
    store: PostgresRunStore;
    profiles: PostgresAgentProfileStore;
    broker: SyntheticBrokerExecutor;
    enqueue: EnqueueRun;
    publish: (events: DurableEvent[]) => void;
  }) {
    this.store = input.store;
    this.profiles = input.profiles;
    this.broker = input.broker;
    this.enqueue = input.enqueue;
    this.publish = input.publish;
  }

  async admit(input: {
    taskId: string;
    authorizationId: string;
    requestId: string;
    correlationId: string;
    binding: ConnectorAuthorizationRequest;
  }): Promise<{ run: Run; created: boolean }> {
    const result = await this.store.admitSyntheticBrokerRun(
      { ...input, runId: input.correlationId },
      this.enqueue,
    );
    this.publish(result.events);
    return { run: result.run, created: result.created };
  }

  async isSyntheticJob(value: unknown): Promise<boolean> {
    const parsed = QueueJobSchema.safeParse(value);
    if (!parsed.success) return false;
    return Boolean(await this.store.getSyntheticBrokerRun(parsed.data.runId));
  }

  async handleQueueJob(value: unknown, jobSignal?: AbortSignal): Promise<void> {
    const parsed = QueueJobSchema.safeParse(value);
    if (!parsed.success) throw new Error('The durable task job payload is invalid.');
    const link = await this.store.getSyntheticBrokerRun(parsed.data.runId);
    if (!link) throw new Error('The synthetic broker Run binding is unavailable.');
    const begun = await this.store.beginSyntheticBrokerRun(
      parsed.data.runId,
      this.workerId,
      runLeaseSeconds,
    );
    this.publish(begun.events);
    if (!begun.started) return;

    let heartbeatBusy = false;
    const heartbeat = setInterval(() => {
      if (heartbeatBusy) return;
      heartbeatBusy = true;
      void this.store
        .renewSyntheticBrokerLease(
          parsed.data.runId,
          this.workerId,
          begun.generation,
          runLeaseSeconds,
        )
        .finally(() => {
          heartbeatBusy = false;
        })
        .catch(() => undefined);
    }, heartbeatMs);

    try {
      if (jobSignal?.aborted) {
        await this.finish(link.run.id, begun.generation, { status: 'interrupted' });
        return;
      }
      const request = await this.reconstruct(link);
      if (!request) {
        await this.finish(link.run.id, begun.generation, { status: 'failed' });
        return;
      }
      let response: SyntheticTaskRunResponse;
      try {
        response = SyntheticTaskRunResponseSchema.parse(
          await this.broker.execute(link.run.taskId, request),
        );
      } catch {
        // The broker may have crossed the provider boundary before a lost or
        // malformed reply. Keep the Run unknown and never retry the queue job.
        await this.finish(link.run.id, begun.generation, { status: 'unknown' });
        return;
      }
      if (
        response.taskId !== link.run.taskId ||
        response.authorizationId !== link.authorizationId ||
        response.requestId !== link.requestId ||
        (response.correlationId !== undefined && response.correlationId !== link.correlationId)
      ) {
        await this.finish(link.run.id, begun.generation, { status: 'unknown' });
        return;
      }
      await this.finish(link.run.id, begun.generation, {
        attemptId: response.attemptId,
        status: response.status,
        ...(response.responseText ? { responseText: response.responseText } : {}),
      });
    } finally {
      clearInterval(heartbeat);
    }
  }

  async cancel(input: { runId: string; taskId: string; authorizationId: string }): Promise<void> {
    const link = await this.store.getSyntheticBrokerRunByAuthorization(input.authorizationId);
    if (!link) return;
    if (link.run.id !== input.runId || link.run.taskId !== input.taskId) {
      throw new Error('Synthetic cancellation identity does not match the persisted Run.');
    }
    const result = await this.store.requestSyntheticBrokerStop(link.run.id, input.authorizationId);
    this.publish(result.events);
  }

  private async reconstruct(
    link: SyntheticBrokerRun,
  ): Promise<SyntheticTaskRunRequest | undefined> {
    const task = await this.store.getTask(link.run.taskId);
    const profileResponse = await this.profiles.getVersion(
      link.binding.agentId,
      link.binding.profileVersion,
    );
    const profile = profileResponse
      ? AgentProfileVersionSchema.safeParse(profileResponse.version)
      : undefined;
    if (
      !task ||
      !profile?.success ||
      task.id !== link.binding.taskId ||
      task.projectId !== link.binding.projectId ||
      task.associationRevision !== link.binding.taskRevision ||
      profile.data.agentId !== link.binding.agentId ||
      profile.data.versionNo !== link.binding.profileVersion
    )
      return undefined;
    let renderedRequest: string;
    try {
      renderedRequest = renderSyntheticConnectorRequest(task, profile.data);
    } catch {
      return undefined;
    }
    if (createRenderedRequestDigest(renderedRequest) !== link.binding.promptDigest)
      return undefined;
    return SyntheticTaskRunRequestSchema.parse({
      version: 'omnis.synthetic-task-run.v1',
      authorizationId: link.authorizationId,
      requestId: link.requestId,
      request: link.binding,
      renderedRequest,
    });
  }

  private async finish(
    runId: string,
    generation: number,
    result: SyntheticBrokerRunResult,
  ): Promise<void> {
    const completed = await this.store.finishSyntheticBrokerRun(
      runId,
      this.workerId,
      generation,
      result,
    );
    this.publish(completed.events);
  }
}
