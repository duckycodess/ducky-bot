#!/usr/bin/env tsx
/**
 * PROBE F -- does the gateway accept this bot, with the intents it asks for?
 *
 * One specific blocker, answered without a human: `MessageContent` is a
 * PRIVILEGED intent. If it is not enabled in the Discord developer portal, the
 * gateway does not degrade -- it refuses the connection outright with
 * `DisallowedIntents`. That means every DM, every reminder, every briefing and
 * every conversational reply fails at once, and the failure looks like "the bot
 * will not start" rather than like a missing checkbox.
 *
 * WHAT IT DOES
 * - Connects with EXACTLY the intents `DiscordJsTransport` requests.
 * - Waits for `ClientReady`, records that it happened, and disconnects.
 *
 * WHAT IT DELIBERATELY DOES NOT DO -- and this is the important part:
 *
 * **It registers no handlers.** Not for messages, not for interactions, not
 * for anything. A coordinator may already be running on this same bot
 * identity, and two connections both wired to respond would race to answer the
 * same interaction. This one is deaf on purpose: it proves the connection is
 * ACCEPTED and then leaves. An event arriving during the few seconds it is
 * connected is still delivered to the real coordinator, which answers it.
 *
 * It also sends nothing, registers no command, and reads no message content.
 *
 * SAFETY
 * - The token is read from the profile's own environment and never printed,
 *   logged or written to a fixture.
 * - The recording is booleans and counts. Not the bot's name, not a guild
 *   name, not an id.
 * - Exit 2 when the gateway refuses, with the exact remedy.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { redact } from '../packages/adapters/src/index.js';
import { resolveDiscordProfile } from '../packages/coordinator/src/discord/profile-config.js';
import { probeGatewayConnection } from '../packages/coordinator/src/discord/discordjs.transport.js';
import { PROFILE_ENV } from '../packages/contracts/src/index.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURES = path.join(ROOT, 'packages/coordinator/src/discord/discord.fixtures');

const out = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

/** How long to wait for READY before calling it a failure. */
const READY_TIMEOUT_MS = 30_000;

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const profileArg = flag('profile');
  if (!profileArg) {
    process.stderr.write('--profile <development|production> is required. Refusing to guess.\n');
    process.exit(1);
  }

  const config = resolveDiscordProfile(profileArg, process.env);
  const names = PROFILE_ENV[config.profile];
  if (!config.token) {
    process.stderr.write(`${names.token} is not set; there is no bot to connect as.\n`);
    process.exit(2);
  }

  out(`connecting as the ${config.profile} bot, with Guilds + DirectMessages + MessageContent`);
  out('registering NO handlers: a coordinator may be running on this same identity.');

  // The connection itself lives in the transport -- the one module permitted to
  // import discord.js. A probe with its own import would widen that guarantee
  // to two modules for the sake of one connection.
  const result = await probeGatewayConnection(config.token, READY_TIMEOUT_MS);

  mkdirSync(FIXTURES, { recursive: true });
  writeFileSync(
    path.join(FIXTURES, 'gateway-connect.json'),
    `${JSON.stringify(
      {
        _note:
          'Recorded by scripts/probe-discord-gateway.ts. Booleans and counts only: no token, ' +
          'no bot name, no guild name, no id. No handler was registered and nothing was sent.',
        profile: config.profile,
        intentsRequested: ['Guilds', 'DirectMessages', 'MessageContent'],
        /** The privileged one. If this connected, the portal toggle is ON. */
        messageContentAccepted: result.ok,
        connected: result.ok,
        readyMs: result.ok ? result.ms : null,
        guildCount: result.ok ? result.guilds : null,
        handlersRegistered: 0,
        messagesSent: 0,
      },
      null,
      2,
    )}\n`,
  );
  out('recorded gateway-connect.json');

  if (result.ok) {
    out('');
    out(`READY in ${result.ms}ms; the bot is in ${result.guilds} guild(s).`);
    out('The MessageContent privileged intent is ENABLED: the gateway would have refused');
    out('the connection outright otherwise.');
    out('');
    out('What this does NOT prove: that a human interaction round-trips. No handler was');
    out('registered and nothing was answered. A real slash command and a real DM, by the');
    out('owner, against a running coordinator, are still the only evidence of that.');
    process.exit(0);
  }

  const disallowed = /disallowed intent/i.test(result.error);
  process.stderr.write(
    [
      '',
      `The gateway did not accept the connection: ${redact(result.error)}`,
      '',
      ...(disallowed
        ? [
            'That error means exactly one thing, and it is fixable in a minute:',
            '',
            '  Discord Developer Portal -> Applications -> (your bot)',
            '    -> Bot -> Privileged Gateway Intents',
            '    -> enable MESSAGE CONTENT INTENT -> Save Changes',
            '',
            'Until it is enabled, the coordinator cannot connect at all -- so DMs, reminders,',
            'briefings, watch summaries and conversation all fail together, and the symptom',
            'looks like "the bot will not start" rather than a missing checkbox.',
          ]
        : [
            'Check the token for this profile, and that the bot still exists.',
            'The token is never printed by this probe; re-issue it in the portal if in doubt.',
          ]),
      '',
    ].join('\n') + '\n',
  );
  process.exit(2);
}

main().catch((err) => {
  process.stderr.write(`discord gateway probe failed: ${redact((err as Error).message)}\n`);
  process.exit(1);
});
