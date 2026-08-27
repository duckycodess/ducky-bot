import { createHmac } from 'node:crypto';
import { CUSTOM_ID_MAX, DuckyError, KEY_ID_RE } from '@ducky/contracts';
import { constantTimeEquals, secretBytes } from '@ducky/adapters';
import { MIN_SECRET_BYTES } from '@ducky/contracts';

export interface ComponentIdParts {
  readonly kind: string;
  readonly entityId: string;
  readonly actorUserId: string;
  /** Bumped when the underlying row changes, so a stale control stops working. */
  readonly version?: string;
}

/**
 * Signs Discord component ids.
 *
 * This is defence in depth only: the primary control is that every interaction
 * re-checks owner identity and row ownership server-side. Signing stops a stale
 * or copied control from being replayed, and binding the actor id makes a
 * copied id useless to anyone else.
 */
export class ComponentSigner {
  constructor(
    private readonly secret: string,
    private readonly keyId = 'c1',
  ) {
    if (secretBytes(secret) < MIN_SECRET_BYTES) {
      throw new DuckyError(
        'invalid_input',
        'DUCKY_COMPONENT_SIGNING_KEY must be at least 32 bytes of base64url randomness.',
      );
    }
    if (!KEY_ID_RE.test(keyId)) {
      throw new DuckyError('invalid_input', 'Component signing key id is malformed.');
    }
  }

  private mac(parts: ComponentIdParts): string {
    return createHmac('sha256', this.secret)
      .update([parts.kind, parts.entityId, parts.actorUserId, parts.version ?? ''].join('|'))
      .digest('base64url')
      .slice(0, 22);
  }

  sign(parts: ComponentIdParts): string {
    const id = ['v1', this.keyId, parts.kind, parts.entityId, this.mac(parts)].join(':');
    if (id.length > CUSTOM_ID_MAX) {
      throw new DuckyError('invalid_input', 'Component id exceeded the Discord length limit.');
    }
    return id;
  }

  /** Returns the parsed kind/entity only when the signature verifies. */
  verify(customId: string, actorUserId: string, version?: string):
    | { kind: string; entityId: string }
    | undefined {
    const segments = customId.split(':');
    if (segments.length !== 5) return undefined;
    const [v, keyId, kind, entityId, sig] = segments as [string, string, string, string, string];
    if (v !== 'v1' || keyId !== this.keyId) return undefined;
    const expected = this.mac({ kind, entityId, actorUserId, version });
    return constantTimeEquals(expected, sig) ? { kind, entityId } : undefined;
  }
}
