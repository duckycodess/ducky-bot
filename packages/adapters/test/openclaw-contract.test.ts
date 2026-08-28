import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { RECORDED_CONTRACT_VERSION } from '../src/openclaw/openclaw.contract.js';
import { GatewayOpenClawProvider } from '../src/openclaw/openclaw.gateway.js';
import { isPrivateGatewayUrl } from '../src/openclaw/private-url.js';

const FIXTURES = path.resolve(import.meta.dirname, '..', 'src', 'openclaw', 'openclaw.fixtures');
const read = (name: string): Record<string, unknown> | undefined => {
  const file = path.join(FIXTURES, `${name}.json`);
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>) : undefined;
};

/**
 * What `pnpm probe:openclaw` actually recorded, asserted.
 *
 * OpenClaw is installed on this host (pinned, local prefix), so unlike before
 * there ARE fixtures. What there is not is a successful agent turn: that needs
 * model provider credentials nobody has configured here. These tests pin both
 * halves of that state — what is known, and that the unknown half keeps the
 * provider unverified — so neither can drift quietly.
 */
describe('the recorded OpenClaw surface', () => {
  const cli = read('cli');
  const agent = read('agent-cli-contract');
  const gateway = read('gateway-contract');
  const turn = read('agent-turn-attempt');

  it('reports honestly when nothing has been probed', () => {
    if (!cli) {
      expect(cli).toBeUndefined();
      return;
    }
    expect(cli['version']).toMatch(/OpenClaw \d{4}\./);
  });

  it('records the request half of the agent contract', () => {
    if (!agent) return;
    // The three flags the port maps onto. If any of these disappears in a later
    // OpenClaw, the adapter's argv is wrong and this is where it shows up.
    expect(agent['carriesMessage']).toBe(true);
    expect(agent['carriesSessionKey']).toBe(true);
    expect(agent['carriesJsonOutput']).toBe(true);
  });

  it('records that an agent turn has NO attachment input', () => {
    if (!agent) return;
    // The finding that settles 2C for this provider. `message send --media`
    // exists, but that is outbound to a chat channel, not an attachment on a
    // turn -- so the attachment gate stays closed even once text is verified.
    expect(agent['attachmentInputOnAgentTurn']).toEqual([]);
    expect(agent['messageSendHasMedia']).toBe(true);
  });

  it('records a WebSocket gateway rather than the HTTP endpoint first assumed', () => {
    if (!gateway) return;
    expect(gateway['bindModes']).toContain('loopback');
    expect(gateway['bindModes']).toContain('tailnet');
    expect(gateway['authModes']).toContain('token');
    // Both of the schemes OpenClaw's own transport uses have to pass the guard,
    // or a correctly configured gateway URL would be refused at boot.
    expect(isPrivateGatewayUrl('ws://127.0.0.1:19001')).toBe(true);
    expect(isPrivateGatewayUrl('wss://host.ts.net:19001')).toBe(true);
    expect(isPrivateGatewayUrl('wss://openclaw.example.com')).toBe(false);
  });

  it('records the auth blocker as an observation, not a description', () => {
    if (!turn) return;
    // A real turn was attempted and failed for a specific, recorded reason.
    expect(turn['exitCode']).toBe(1);
    expect(turn['errorClass']).toBe('ProviderAuthError');
    expect(turn['stdoutEmpty']).toBe(true);
  });

  it('keeps the provider unverified while the reply half is unrecorded', () => {
    // The load-bearing assertion. A reply envelope has never been observed, so
    // no version is recorded, `initializable()` refuses, and `reply()` throws --
    // production cannot select this provider by accident.
    const replyRecorded = read('agent-turn-reply') !== undefined;
    expect(replyRecorded).toBe(RECORDED_CONTRACT_VERSION !== null);

    if (!replyRecorded) {
      const init = GatewayOpenClawProvider.initializable();
      expect(init.ok).toBe(false);
      expect(init.reason).toMatch(/recorded only in HALF/i);
      expect(new GatewayOpenClawProvider('ws://127.0.0.1:19001').verified).toBe(false);
    }
  });

  it('never records a credential or a host path in a fixture', () => {
    for (const name of ['cli', 'agent-cli-contract', 'gateway-contract', 'agent-turn-attempt', 'config-locations']) {
      const body = read(name);
      if (!body) continue;
      const text = JSON.stringify(body);
      expect(text, name).not.toMatch(/\/home\/[a-z]/i);
      expect(text, name).not.toMatch(/sk-[A-Za-z0-9]{8,}/);
      expect(text, name).not.toMatch(/eyJ[A-Za-z0-9_-]{8,}\./);
    }
  });
});
