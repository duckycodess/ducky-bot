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
 * BOTH halves are now recorded: the request argv that was exercised, and the
 * reply envelope a real successful turn produced. These tests pin the contract
 * to those fixtures, so the adapter cannot drift away from the call that
 * actually produced the evidence — and so the one capability that stayed
 * closed (attachments) cannot quietly open just because the provider became
 * verified.
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

  it('records a real turn as an observation, not a description', () => {
    if (!turn) return;
    // This asserted `exitCode: 1` and `ProviderAuthError` for two milestones,
    // which was the honest state then. A provider is signed in now and the
    // turn succeeds; the assertion moved with the evidence.
    expect(turn['exitCode']).toBe(0);
    expect(turn['stdoutIsJson']).toBe(true);
    expect(turn['errorClass']).toBeNull();
  });

  it('pins the adapter to the argv that actually produced the reply', () => {
    if (!turn) return;
    const recorded = turn['requestArgv'] as string[];

    // `--deliver` would post the agent's output into a chat channel. It is
    // absent from the recorded call and unconstructable by the adapter.
    expect(recorded).not.toContain('--deliver');
    expect(turn['neverDelivers']).toBe(true);

    // The owner's words must never enter argv: `checkCommandAllowed` scans
    // every element for forbidden verbs, so a question containing "push" or
    // "login" would be refused before it reached the subprocess.
    expect(recorded).toContain('--message-file');
    expect(recorded).not.toContain('--message');

    // And the adapter builds THAT call, with only the two caller-supplied
    // values differing. An adapter pinned to a reply envelope some other
    // invocation produced would be pinned to evidence it did not create.
    const built = new GatewayOpenClawProvider('ws://127.0.0.1:19001', { profile: 'dev' })
      .buildArgv('agent:probe:ducky-probe', '/tmp/x/message.txt');
    expect(built.map((a) => (a === '/tmp/x/message.txt' ? '<message-file>' : a))).toEqual(recorded);
  });

  it('is verified only because a reply envelope was recorded', () => {
    // The load-bearing assertion, in both directions: the constant and the
    // fixture must agree. `verified` is DERIVED from the constant, so somebody
    // cannot flip the flag without producing the evidence.
    const replyRecorded = read('agent-turn-reply') !== undefined;
    expect(replyRecorded).toBe(RECORDED_CONTRACT_VERSION !== null);

    const provider = new GatewayOpenClawProvider('ws://127.0.0.1:19001');
    expect(provider.verified).toBe(RECORDED_CONTRACT_VERSION !== null);
    expect(GatewayOpenClawProvider.initializable().ok).toBe(RECORDED_CONTRACT_VERSION !== null);
  });

  it('records a reply envelope of TYPES, never the model\'s answer', () => {
    const reply = read('agent-turn-reply');
    if (!reply) return;
    expect(reply['keys']).toEqual(['meta', 'payloads']);
    expect(reply['hasPayloads']).toBe(true);
    expect(reply['firstPayloadKeys']).toEqual(['mediaUrl', 'text']);

    // The observed envelope carried no deliveryStatus, because --deliver was
    // never passed. One appearing would mean an argv nobody intended.
    expect(reply['hasDeliveryStatus']).toBe(false);

    // Every leaf is a type word or a count. A real string surviving would mean
    // the model's answer reached a committed file.
    const allowed = new Set(['string', 'number', 'boolean', 'null', 'undefined', 'object', 'empty']);
    const walk = (node: unknown, at: string): void => {
      if (typeof node === 'string') {
        if (/^\d+$/.test(node)) return;
        expect(allowed.has(node), `${at} = ${JSON.stringify(node)}`).toBe(true);
        return;
      }
      if (node && typeof node === 'object') {
        for (const [k, v] of Object.entries(node)) walk(v, `${at}.${k}`);
      }
    };
    walk(reply['shape'], 'shape');
  });

  it('keeps attachments unavailable EVEN THOUGH the provider is now verified', () => {
    /**
     * The gate that matters most, and the reason it matters more now than it
     * did before. `attachmentsUsable` requires `verified` AND a declared
     * capability; `verified` used to be false, so the capability flag was
     * belt and braces. It is now the only thing holding the line.
     *
     * The recorded turn takes text only -- the fixture's
     * `attachmentInputOnAgentTurn` is empty -- so declaring otherwise would be
     * an over-claim on the path that carries the owner's personal files.
     */
    const provider = new GatewayOpenClawProvider('ws://127.0.0.1:19001');
    expect(provider.verified).toBe(true);
    expect(provider.capabilities.attachments.supported).toBe(false);
    expect(provider.capabilities.attachments.contentTypes).toEqual([]);
    expect(provider.capabilities.attachments.maxBytes).toBe(0);
  });

  it('never records a credential or a host path in a fixture', () => {
    for (const name of [
      'cli', 'agent-cli-contract', 'gateway-contract', 'agent-turn-attempt',
      'agent-turn-reply', 'config-locations',
    ]) {
      const body = read(name);
      if (!body) continue;
      const text = JSON.stringify(body);
      expect(text, name).not.toMatch(/\/home\/[a-z]/i);
      expect(text, name).not.toMatch(/sk-[A-Za-z0-9]{8,}/);
      expect(text, name).not.toMatch(/eyJ[A-Za-z0-9_-]{8,}\./);
    }
  });
});
