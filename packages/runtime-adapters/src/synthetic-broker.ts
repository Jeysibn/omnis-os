import {
  verifyConnectorDecisionEnvelope,
  type ConnectorDecisionEnvelope,
  type ConnectorExecutionStatus,
  type UsageProvenance,
  type VerificationKey,
} from '@omnis/contracts/connector-broker';
import { createRenderedRequestDigest } from '@omnis/contracts/connector-authorization';

export type SyntheticSubmissionResult =
  | {
      kind: 'completed';
      providerSubmissionId: string;
      acceptedEventId: string;
      completedEventId: string;
      responseText: string;
      usage?: UsageProvenance;
    }
  | { kind: 'accepted'; providerSubmissionId: string; eventId: string; usage?: UsageProvenance }
  | { kind: 'rejected'; eventId: string }
  | { kind: 'accepted_response_lost'; eventId: string }
  | { kind: 'timeout_before_confirmation'; eventId: string }
  | { kind: 'failed_after_submission'; providerSubmissionId: string; eventId: string }
  | { kind: 'unavailable' };

export interface SyntheticProvider {
  submit(
    envelope: ConnectorDecisionEnvelope,
    renderedRequest: string,
  ): Promise<SyntheticSubmissionResult>;
}

export interface SyntheticBrokerAuthorizer {
  beginSyntheticSubmission(
    attemptId: string,
    envelope: unknown,
    renderedRequest: string,
  ): Promise<{ status: ConnectorExecutionStatus }>;
  recordSyntheticProviderEvent(
    attemptId: string,
    event: {
      eventId: string;
      status: 'accepted' | 'running' | 'completed' | 'failed' | 'interrupted' | 'unknown';
      providerSubmissionId?: string;
      usage?: UsageProvenance;
      responseText?: string;
    },
  ): Promise<{ status: ConnectorExecutionStatus }>;
}

export type SyntheticBrokerResult = {
  attemptId: string;
  status: ConnectorExecutionStatus;
  submitted: boolean;
  mayHaveReachedProvider: boolean;
  responseText?: string;
};

/** Test-only broker orchestration. It has no transport and is not wired to the worker. */
export class SyntheticBrokerHarness {
  private readonly authorizer: SyntheticBrokerAuthorizer;
  private readonly provider: SyntheticProvider;
  private readonly trustAnchors: readonly VerificationKey[];

  constructor(
    authorizer: SyntheticBrokerAuthorizer,
    provider: SyntheticProvider,
    trustAnchors: readonly VerificationKey[],
  ) {
    this.authorizer = authorizer;
    this.provider = provider;
    this.trustAnchors = trustAnchors;
  }

  async submit(
    envelopeInput: unknown,
    renderedRequest: string,
    now = new Date(),
  ): Promise<SyntheticBrokerResult> {
    const envelope = verifyConnectorDecisionEnvelope(envelopeInput, this.trustAnchors, now);
    if (
      typeof renderedRequest !== 'string' ||
      renderedRequest.length < 1 ||
      renderedRequest.length > 32_000 ||
      renderedRequest.includes('\0') ||
      renderedRequest.trim().length === 0 ||
      createRenderedRequestDigest(renderedRequest) !== envelope.claims.promptDigest
    ) {
      throw new Error('Rendered connector request does not match the signed digest.');
    }
    const attemptId = envelope.claims.attemptId;
    // Persist the submission boundary before crossing into the provider implementation.
    const admitted = await this.authorizer.beginSyntheticSubmission(
      attemptId,
      envelope,
      renderedRequest,
    );
    if (admitted.status !== 'submitting')
      throw new Error('Authorizer did not persist submitting state.');
    const outcome = await this.provider.submit(envelope, renderedRequest);
    switch (outcome.kind) {
      case 'unavailable':
        await this.authorizer.recordSyntheticProviderEvent(attemptId, {
          eventId: `unavailable:${attemptId}`,
          status: 'failed',
          usage: { kind: 'unknown', reason: 'provider_unavailable', billingExposure: 'unknown' },
        });
        return { attemptId, status: 'failed', submitted: false, mayHaveReachedProvider: false };
      case 'accepted': {
        const saved = await this.authorizer.recordSyntheticProviderEvent(attemptId, {
          eventId: outcome.eventId,
          status: 'accepted',
          providerSubmissionId: outcome.providerSubmissionId,
          ...(outcome.usage ? { usage: outcome.usage } : {}),
        });
        return { attemptId, status: saved.status, submitted: true, mayHaveReachedProvider: true };
      }
      case 'completed': {
        await this.authorizer.recordSyntheticProviderEvent(attemptId, {
          eventId: outcome.acceptedEventId,
          status: 'accepted',
          providerSubmissionId: outcome.providerSubmissionId,
        });
        const saved = await this.authorizer.recordSyntheticProviderEvent(attemptId, {
          eventId: outcome.completedEventId,
          status: 'completed',
          providerSubmissionId: outcome.providerSubmissionId,
          responseText: outcome.responseText,
          ...(outcome.usage ? { usage: outcome.usage } : {}),
        });
        return {
          attemptId,
          status: saved.status,
          submitted: true,
          mayHaveReachedProvider: true,
          responseText: outcome.responseText,
        };
      }
      case 'rejected': {
        const saved = await this.authorizer.recordSyntheticProviderEvent(attemptId, {
          eventId: outcome.eventId,
          status: 'failed',
        });
        return { attemptId, status: saved.status, submitted: true, mayHaveReachedProvider: true };
      }
      case 'accepted_response_lost':
      case 'timeout_before_confirmation': {
        const saved = await this.authorizer.recordSyntheticProviderEvent(attemptId, {
          eventId: outcome.eventId,
          status: 'unknown',
          usage: { kind: 'unknown', reason: 'submission_uncertain', billingExposure: 'unknown' },
        });
        return { attemptId, status: saved.status, submitted: true, mayHaveReachedProvider: true };
      }
      case 'failed_after_submission': {
        const saved = await this.authorizer.recordSyntheticProviderEvent(attemptId, {
          eventId: outcome.eventId,
          status: 'failed',
          providerSubmissionId: outcome.providerSubmissionId,
          usage: { kind: 'unknown', reason: 'not_reported', billingExposure: 'unknown' },
        });
        return { attemptId, status: saved.status, submitted: true, mayHaveReachedProvider: true };
      }
    }
  }

  /** A restart never repeats submit: an orphaned submitting attempt is persisted as uncertain. */
  async recover(attemptId: string, eventId: string): Promise<SyntheticBrokerResult> {
    const saved = await this.authorizer.recordSyntheticProviderEvent(attemptId, {
      eventId,
      status: 'unknown',
      usage: { kind: 'unknown', reason: 'submission_uncertain', billingExposure: 'unknown' },
    });
    return { attemptId, status: saved.status, submitted: false, mayHaveReachedProvider: true };
  }
}

export type FakeProviderScenario =
  SyntheticSubmissionResult | { kind: 'duplicate'; first: SyntheticSubmissionResult };

/** Deterministic fake endpoint. No sockets, credentials, DNS, or provider URLs exist here. */
export class DeterministicSyntheticProvider implements SyntheticProvider {
  readonly submissions: string[] = [];
  readonly requests: string[] = [];
  private readonly scenario: FakeProviderScenario;

  constructor(scenario: FakeProviderScenario) {
    this.scenario = scenario;
  }

  async submit(
    envelope: ConnectorDecisionEnvelope,
    renderedRequest: string,
  ): Promise<SyntheticSubmissionResult> {
    if (this.submissions.includes(envelope.claims.attemptId))
      throw new Error('Synthetic provider received a duplicate attempt.');
    this.submissions.push(envelope.claims.attemptId);
    this.requests.push(renderedRequest);
    if (this.scenario.kind === 'duplicate') return this.scenario.first;
    return this.scenario;
  }
}
