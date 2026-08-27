import { describe, expect, it } from 'vitest';
import { assertPrivateGatewayUrl, isPrivateGatewayUrl } from '../src/openclaw/private-url.js';
import { HttpOpenClawProvider } from '../src/openclaw/openclaw.http.js';
import { MockConversationProvider } from '../src/openclaw/openclaw.mock.js';

describe('OpenClaw gateway guard', () => {
  it('accepts loopback and tailnet addresses', () => {
    for (const u of [
      'http://127.0.0.1:8080',
      'http://localhost:1234/x',
      'https://100.64.0.7:443',
      'https://100.127.255.254',
      'https://laptop.tailnet-1234.ts.net',
    ]) {
      expect(isPrivateGatewayUrl(u), u).toBe(true);
    }
  });

  it('rejects public and malformed URLs', () => {
    for (const u of [
      'https://openclaw.example.com',
      'http://8.8.8.8',
      'https://100.63.0.1',
      'https://100.128.0.1',
      'ftp://127.0.0.1',
      'not-a-url',
      'https://evil.ts.net.attacker.com',
    ]) {
      expect(isPrivateGatewayUrl(u), u).toBe(false);
      expect(() => assertPrivateGatewayUrl(u)).toThrow();
    }
  });

  it('guards the HTTP provider at construction and refuses to invent an API', async () => {
    expect(() => new HttpOpenClawProvider('https://openclaw.example.com')).toThrow();
    const p = new HttpOpenClawProvider('http://127.0.0.1:9999');
    await expect(p.reply({ userId: '1', text: 'hi', threadKey: 't' })).rejects.toThrow(
      /not been verified/i,
    );
    expect(p.verified).toBe(false);
  });

  it('marks every mock reply so it cannot pass for a real answer', async () => {
    const mock = new MockConversationProvider();
    const reply = await mock.reply({ userId: '1', text: 'hello', threadKey: 't' });
    expect(reply.mock).toBe(true);
    expect(mock.verified).toBe(false);
  });
});
