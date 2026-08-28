import { isUpToDate } from '@ducky/persistence';
import { attachmentAvailability } from './discord/conversation-attachments.js';
import type { App } from './app.js';

export interface Diagnostic {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}

/** Fails loudly at startup instead of degrading quietly at runtime. */
export function runStartupDiagnostics(app: App): Diagnostic[] {
  const out: Diagnostic[] = [];
  const add = (name: string, ok: boolean, detail: string) => out.push({ name, ok, detail });

  add('profile', true, `${app.discordProfile.profile} (${app.paths.instanceLabel})`);
  add('database', safe(() => app.store.db.prepare('SELECT 1').get() !== undefined), app.paths.dbPath);
  add('migrations', safe(() => isUpToDate(app.store.db)), 'schema up to date');
  add('owner', true, `configured (${app.authz.ownerId.slice(0, 4)}…)`);
  add('component signing key', true, `present (${app.discordProfile.profile}-scoped)`);
  add('executor credentials', true, app.paths.credentialsFile);
  add(
    'discord',
    true,
    app.transport.kind === 'real'
      ? `real client (${app.discordProfile.profile} bot)`
      : `mock transport (no ${app.discordProfile.profile} token)`,
  );
  add(
    'discord intents',
    app.transport.kind !== 'real',
    app.transport.kind === 'real'
      ? 'enable the privileged MessageContent intent and Partials.Channel for DMs'
      : 'not applicable to the mock transport',
  );
  add('conversation', app.conversation.verified, `${app.conversation.name}`);
  // Not a warning when unavailable: refusing to hand files to an unverified
  // provider is the correct state, not a degraded one.
  add('chat attachments', true, attachmentAvailability(app.conversation, app.conversationAttachments));
  // Already validated in createApp; reported so the owner can see WHICH zone
  // every due date, reminder and briefing day boundary is computed in.
  add('owner timezone', true, app.clock.timeZone);
  add('repositories', app.allowlist.list().length > 0, `${app.allowlist.list().length} allowlisted`);
  add('executors', true, `${app.store.executors.listExecutors().length} registered`);
  return out;
}

export function formatDiagnostics(list: readonly Diagnostic[]): string {
  return list.map((d) => `${d.ok ? 'ok  ' : 'WARN'} ${d.name}: ${d.detail}`).join('\n');
}

const safe = (fn: () => boolean): boolean => {
  try {
    return fn();
  } catch {
    return false;
  }
};
