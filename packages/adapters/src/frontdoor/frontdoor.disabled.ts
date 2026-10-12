import { DuckyError } from '@ducky/contracts';
import type {
  FrontDoorAvailability, FrontDoorInspection, FrontDoorOnboarding, FrontDoorPort,
  FrontDoorPublication, FrontDoorValidation,
} from './frontdoor.port.js';

/**
 * The shipped default: the bridge is OFF.
 *
 * Every method refuses, clearly and identically, and the refusal names what is
 * missing rather than pretending the feature half-works. This is the same
 * fail-closed posture `DisabledConversationProvider` takes -- an instance that
 * has not been configured for the workflow must be unable to reach it, not
 * merely unlikely to.
 */
export class DisabledFrontDoor implements FrontDoorPort {
  readonly name = 'disabled';

  availability(): FrontDoorAvailability {
    return {
      usable: false,
      reason: 'disabled',
      detail:
        'The repository workflow is not enabled on this instance. ' +
        'Nothing was read, created or queued.',
      mutationEnabled: false,
    };
  }

  #refuse(): never {
    throw new DuckyError('not_enabled_in_phase1', this.availability().detail);
  }

  async inspect(): Promise<FrontDoorInspection> {
    this.#refuse();
  }

  async validate(): Promise<FrontDoorValidation> {
    this.#refuse();
  }

  async publish(): Promise<FrontDoorPublication> {
    this.#refuse();
  }

  async agentize(): Promise<FrontDoorOnboarding> {
    this.#refuse();
  }
}
