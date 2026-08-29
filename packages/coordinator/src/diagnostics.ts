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
  /**
   * Not a warning any more, and the reason is worth stating.
   *
   * This line used to WARN unconditionally whenever the transport was real,
   * telling the operator to enable an intent it had no way of checking. That
   * makes a healthy instance report a warning forever, and it was actively
   * wrong on this host: the intent is enabled, measured by connecting.
   *
   * The coordinator still cannot check it HERE -- diagnostics print before the
   * gateway is up. But the honest fact is better than the guess either way:
   * Discord refuses the connection outright when the intent is disabled, so a
   * client that connects has already proved it, and `pnpm probe:discord-gateway`
   * answers the question in a few seconds without starting a coordinator.
   */
  add(
    'discord intents',
    true,
    app.transport.kind === 'real'
      ? 'MessageContent is privileged: a gateway that CONNECTS has it enabled, because Discord ' +
        'refuses the connection otherwise. Check without booting: pnpm probe:discord-gateway'
      : 'not applicable to the mock transport',
  );
  // Not a warning when `disabled`: refusing to answer is the correct state for
  // an instance with no verified backend, and is materially better than a
  // canned reply the owner might believe. `mock` IS a warning, because a
  // marked stand-in is still answering.
  add(
    'conversation',
    app.conversation.verified || app.conversation.name === 'disabled',
    app.conversation.name === 'disabled'
      ? 'disabled — conversation refuses clearly; no backend is verified'
      : `${app.conversation.name}${app.conversation.verified ? '' : ' (unverified)'}`,
  );
  // Not a warning when unavailable: refusing to hand files to an unverified
  // provider is the correct state, not a degraded one.
  add('chat attachments', true, attachmentAvailability(app.conversation, app.conversationAttachments));
  /**
   * The tool policy is PROVED per process, lazily, on the first turn -- not
   * here. A boot-time subprocess would let a wedged CLI stop the coordinator
   * from starting, and the property does not change under a running process
   * without somebody editing configuration.
   *
   * This line says where the guarantee comes from, so an operator reading the
   * boot output knows it is enforced rather than assumed.
   */
  if (app.conversation.name.startsWith('openclaw')) {
    add(
      'chat tool policy',
      true,
      'verified on first turn; a conversation is refused unless OpenClaw is provably ' +
        'text-only (tools.profile=minimal, session_status denied)',
    );
  }
  // Not a warning either way: storing nothing is the safe default, and storing
  // a bounded, deletable history because the operator asked for it is a choice,
  // not a degradation.
  add(
    'chat memory',
    true,
    app.conversationMemory.enabled
      ? `enabled — bounded per (user, thread); /forget conversation deletes it`
      : 'disabled — no conversation turn is stored',
  );
  // Already validated in createApp; reported so the owner can see WHICH zone
  // every due date, reminder and briefing day boundary is computed in.
  add('owner timezone', true, app.clock.timeZone);
  // Not a warning either way: a pulled briefing is the default, and a pushed one
  // is a choice.
  add(
    'proactive briefings',
    true,
    app.briefingNotifier.enabled
      ? `enabled — morning and evening, to ${briefingDestination(app)}, on the reconcile interval`
      : 'disabled — /briefing only',
  );
  /**
   * Reported because it changes where the owner's own words end up.
   *
   * Not a warning in either direction: no role channel is the conservative
   * default, and configuring one is a deliberate choice. Role NAMES only -- a
   * boot line is a health readout, not a configuration dump, and a channel id
   * in a log adds nothing a reader can act on.
   */
  add(
    'assistant channels',
    true,
    app.channelRoles.enabled
      ? `${app.channelRoles.configured.map((c) => c.role).join(', ')} — your replies PERSIST there`
      : 'none — every reply in a guild stays ephemeral',
  );
  // Not a warning: refusing to resume a job on an unchecked dependency is the
  // correct state, not a degraded one.
  add(
    'dependency checker',
    true,
    app.dependencies.checkerVerified
      ? `${app.dependencies.checkerName} (verified)`
      : `${app.dependencies.checkerName} — waits expire to the owner, never auto-resume`,
  );
  // Not a warning when disabled: keeping everything is the safe default, and an
  // operator who has not chosen a retention policy should not be nagged into
  // deleting the owner's records.
  add(
    'retention',
    true,
    app.retention.enabled
      ? 'enabled — finished records are pruned on the reconcile interval'
      : 'disabled — nothing is ever deleted automatically',
  );
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

/** Where a proactive briefing lands, in the owner's terms. */
function briefingDestination(app: App): string {
  switch (app.briefingNotifier.delivery) {
    case 'dm':
      return 'your DM';
    case 'channel':
      return 'the briefing channel';
    case 'both':
      return 'your DM and the briefing channel';
  }
}
