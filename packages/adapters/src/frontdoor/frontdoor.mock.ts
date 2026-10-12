import type { TicketSpec } from '@ducky/contracts';
import type {
  FrontDoorAvailability, FrontDoorInspection, FrontDoorOnboarding, FrontDoorPort,
  FrontDoorPublication, FrontDoorValidation,
} from './frontdoor.port.js';

/**
 * A scriptable stand-in for the installed helper.
 *
 * TEST-ONLY, and it exists because the real helper creates GitHub issues. A
 * test suite that exercised the real publisher would be a test suite that
 * opens issues on somebody's repository every time it runs -- so the bridge is
 * tested against this, and the REAL integration is honestly reported as
 * unverified until a disposable registered repository exists to point it at.
 *
 * It records every call, so a test can assert what Ducky asked for -- which is
 * how `--ready` is proved never to be inferred.
 */
export class MockFrontDoor implements FrontDoorPort {
  readonly name = 'mock-agent-workflow';

  readonly calls: {
    kind: 'inspect' | 'validate' | 'publish' | 'agentize';
    input: Record<string, unknown>;
  }[] = [];

  constructor(
    private readonly script: {
      availability?: Partial<FrontDoorAvailability>;
      inspect?: Partial<FrontDoorInspection> | (() => never);
      validate?: Partial<FrontDoorValidation>;
      publish?: Partial<FrontDoorPublication> | ((ready: boolean) => Partial<FrontDoorPublication>);
      agentize?: Partial<FrontDoorOnboarding>;
    } = {},
  ) {}

  availability(): FrontDoorAvailability {
    return {
      usable: true,
      detail: 'Mock workflow helper.',
      mutationEnabled: true,
      ...this.script.availability,
    };
  }

  async inspect(input: {
    path?: string;
    repository?: string;
    network?: boolean;
    signal?: AbortSignal;
  }): Promise<FrontDoorInspection> {
    this.calls.push({ kind: 'inspect', input: { ...input } });
    const scripted = this.script.inspect;
    if (typeof scripted === 'function') scripted();
    return {
      root: '/tmp/ducky-demo',
      repository: 'acme/demo',
      repositoryError: undefined,
      dirty: false,
      registered: true,
      registrationEnabled: true,
      completionPolicy: undefined,
      activeJobs: 0,
      signalCount: 3,
      hasWorkflowContract: true,
      beads: true,
      ...scripted,
    };
  }

  async validate(spec: TicketSpec, _signal?: AbortSignal): Promise<FrontDoorValidation> {
    this.calls.push({ kind: 'validate', input: { id: spec.id, repository: spec.repository } });
    return { ok: true, id: spec.id, error: undefined, ...this.script.validate };
  }

  async publish(input: {
    spec: TicketSpec;
    ready: boolean;
    path?: string;
    issue?: number;
    labels?: readonly string[];
  }): Promise<FrontDoorPublication> {
    this.calls.push({
      kind: 'publish',
      input: {
        id: input.spec.id,
        repository: input.spec.repository,
        ready: input.ready,
        issue: input.issue,
        labels: [...(input.labels ?? [])],
      },
    });
    const scripted =
      typeof this.script.publish === 'function'
        ? this.script.publish(input.ready)
        : this.script.publish;
    return {
      ok: true,
      repository: input.spec.repository,
      issue: input.issue ?? 41,
      url: `https://github.com/${input.spec.repository}/issues/${input.issue ?? 41}`,
      created: input.issue === undefined,
      // Mirrors the helper's own rule: queued ONLY when --ready was passed.
      queued: input.ready,
      queueVerified: input.ready,
      started: false,
      alreadyAuthorized: false,
      classificationLabels: [...(input.labels ?? [])],
      classificationVerified: (input.labels ?? []).length > 0,
      error: undefined,
      ...scripted,
    };
  }

  async agentize(input: {
    path?: string;
    repository?: string;
    localOnly?: boolean;
  }): Promise<FrontDoorOnboarding> {
    this.calls.push({ kind: 'agentize', input: { ...input } });
    return {
      ok: true,
      repository: 'acme/demo',
      root: '/tmp/ducky-demo',
      changed: ['.agent/workflow.json'],
      registered: true,
      labelsCreated: [],
      dispatcher: 'running',
      error: undefined,
      ...this.script.agentize,
    };
  }
}
