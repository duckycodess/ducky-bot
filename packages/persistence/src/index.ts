export * from './db.js';
export * from './migrate.js';
export { MIGRATIONS, type Migration } from './migrations.js';
export * from './repositories/types.js';
export * from './repositories/repos.repo.js';
export * from './repositories/captures.repo.js';
export * from './repositories/conversations.repo.js';
export * from './repositories/conversation-threads.repo.js';
export * from './repositories/schedules.repo.js';
export * from './repositories/jobs.repo.js';
export * from './repositories/results.repo.js';
export * from './repositories/approvals.repo.js';
export * from './repositories/executors.repo.js';
export * from './repositories/herdr-workspaces.repo.js';
export * from './repositories/github-watches.repo.js';
export * from './repositories/github-feed.repo.js';
export * from './repositories/audit.repo.js';
export * from './repositories/notifications.repo.js';
export * from './repositories/tasks.repo.js';
export * from './repositories/task-previews.repo.js';
export * from './repositories/reminders.repo.js';
export * from './repositories/briefings.repo.js';
export * from './repositories/dependencies.repo.js';
export * from './repositories/audit-log.repo.js';
export * from './repositories/retention.repo.js';
export * from './repositories/agent-threads.repo.js';
export * from './repositories/assistant-import.repo.js';
export * from './repositories/rollback-delta.repo.js';
export * from './repositories/schedule-rules.repo.js';
export * from './repositories/owner-preferences.repo.js';
export * from './repositories/assistant-watch.repo.js';
export * from './repositories/native-transitions.repo.js';
export * from './runtime-lock.js';
export * from './backup-check.js';

import type { Db } from './db.js';
import { ReposRepo } from './repositories/repos.repo.js';
import { CapturesRepo } from './repositories/captures.repo.js';
import { ConversationsRepo } from './repositories/conversations.repo.js';
import { ConversationThreadsRepo } from './repositories/conversation-threads.repo.js';
import { SchedulesRepo } from './repositories/schedules.repo.js';
import { JobsRepo } from './repositories/jobs.repo.js';
import { ResultsRepo } from './repositories/results.repo.js';
import { ApprovalsRepo } from './repositories/approvals.repo.js';
import { ExecutorsRepo } from './repositories/executors.repo.js';
import { HerdrWorkspacesRepo } from './repositories/herdr-workspaces.repo.js';
import { GitHubWatchesRepo } from './repositories/github-watches.repo.js';
import { GitHubFeedRepo } from './repositories/github-feed.repo.js';
import { AuthorizedUserAuditRepo } from './repositories/audit.repo.js';
import { NotificationsRepo } from './repositories/notifications.repo.js';
import { TasksRepo } from './repositories/tasks.repo.js';
import { TaskPreviewsRepo } from './repositories/task-previews.repo.js';
import { RemindersRepo } from './repositories/reminders.repo.js';
import { BriefingsRepo } from './repositories/briefings.repo.js';
import { DependenciesRepo } from './repositories/dependencies.repo.js';
import { RetentionRepo } from './repositories/retention.repo.js';
import { AuditLogRepo } from './repositories/audit-log.repo.js';
import { AgentThreadsRepo } from './repositories/agent-threads.repo.js';
import { AssistantImportRepo } from './repositories/assistant-import.repo.js';
import { RollbackDeltaRepo } from './repositories/rollback-delta.repo.js';
import { ScheduleRulesRepo } from './repositories/schedule-rules.repo.js';
import { OwnerPreferencesRepo } from './repositories/owner-preferences.repo.js';
import { AssistantWatchRepo } from './repositories/assistant-watch.repo.js';
import { NativeTransitionsRepo } from './repositories/native-transitions.repo.js';

export interface Store {
  readonly db: Db;
  readonly repos: ReposRepo;
  readonly captures: CapturesRepo;
  /**
   * Stored conversation turns. Present whether or not the feature is enabled:
   * the SERVICE decides whether anything is written, and `/forget` must be able
   * to delete rows an earlier run stored even after the flag goes off again.
   */
  readonly conversations: ConversationsRepo;
  /**
   * Native thread mapping, explicit participation, the compact checkpoint and
   * the provider session epochs. Separate from `conversations` because turns
   * are what was SAID and these are the scaffolding around them: nothing here
   * can delete a turn.
   */
  readonly conversationThreads: ConversationThreadsRepo;
  readonly schedules: SchedulesRepo;
  readonly jobs: JobsRepo;
  readonly results: ResultsRepo;
  readonly approvals: ApprovalsRepo;
  readonly executors: ExecutorsRepo;
  readonly herdrWorkspaces: HerdrWorkspacesRepo;
  readonly githubWatches: GitHubWatchesRepo;
  /** The GitHub feed: selected list, cursors, event ledger, commit buffer, digest slots. */
  readonly githubFeed: GitHubFeedRepo;
  readonly audit: AuthorizedUserAuditRepo;
  readonly notifications: NotificationsRepo;
  readonly tasks: TasksRepo;
  /**
   * Pasted-list previews. Present whether or not anything is pending: the
   * reconciler sweeps expired rows on every pass, so the table is bounded
   * without retention having to be configured.
   */
  readonly taskPreviews: TaskPreviewsRepo;
  readonly reminders: RemindersRepo;
  /** The proactive-briefing outbox. Present whether or not briefings are on. */
  readonly briefings: BriefingsRepo;
  readonly dependencies: DependenciesRepo;
  /**
   * The general structured audit log. Distinct from `audit`, which is the
   * Phase 1 authorized-user observation trail; both are records, neither is
   * ever consulted for a decision.
   */
  readonly auditLog: AuditLogRepo;
  readonly retention: RetentionRepo;
  /**
   * The repository-workflow binding per Discord thread (issue #7). Present
   * whether or not the bridge is configured: `/forget conversation` must be
   * able to delete rows an earlier run stored even after it is switched off.
   */
  readonly agentThreads: AgentThreadsRepo;
  /** Import-specific writes and the permanent correlation ledger (ADR 0030). */
  readonly assistantImport: AssistantImportRepo;
  readonly rollbackDelta: RollbackDeltaRepo;
  /**
   * Runs a deletion path under a named cause, so the tombstone an imported record
   * leaves says WHY it went (`forget`, `owner_delete`, `retention`) in one word and
   * nothing else. A deletion with no path is recorded as `unknown`. Nests: the
   * outermost cause wins.
   */
  withDeletionCause<T>(cause: 'forget' | 'owner_delete' | 'retention', fn: () => T): T;
  /**
   * Removes a deletion cause left behind by a process that died mid-deletion. Only
   * safe while the runtime lock is held, which is where start-up calls it. Returns
   * how many rows it removed.
   */
  clearStaleDeletionContext(): number;
  /** Indefinite weekly rules and their dated exceptions. */
  readonly scheduleRules: ScheduleRulesRepo;
  /** Non-authoritative owner preferences; authorization never reads them. */
  readonly ownerPreferences: OwnerPreferencesRepo;
  /** Notification-only watch targets, typed checkpoints and events. */
  readonly assistantWatch: AssistantWatchRepo;
  /** The exact native/target reconciliation ledger (ADR 0034). */
  readonly nativeTransitions: NativeTransitionsRepo;
}

export function createStore(db: Db): Store {
  // Nesting is tracked in MEMORY. The row is only what the triggers read, so a crash
  // that leaves it behind cannot be mistaken for a deletion path that is running: the
  // outermost entry of a fresh process overwrites it, and start-up clears it.
  let depth = 0;
  const withDeletionCause = <T>(cause: 'forget' | 'owner_delete' | 'retention', fn: () => T): T => {
    if (depth > 0) return fn();
    depth += 1;
    db.prepare('INSERT OR REPLACE INTO deletion_context (id, cause) VALUES (1, ?)').run(cause);
    try {
      return fn();
    } finally {
      depth -= 1;
      db.prepare('DELETE FROM deletion_context WHERE id = 1').run();
    }
  };
  return {
    db,
    repos: new ReposRepo(db),
    captures: new CapturesRepo(db),
    conversations: new ConversationsRepo(db),
    conversationThreads: new ConversationThreadsRepo(db),
    schedules: new SchedulesRepo(db),
    jobs: new JobsRepo(db),
    results: new ResultsRepo(db),
    approvals: new ApprovalsRepo(db),
    executors: new ExecutorsRepo(db),
    herdrWorkspaces: new HerdrWorkspacesRepo(db),
    githubWatches: new GitHubWatchesRepo(db),
    githubFeed: new GitHubFeedRepo(db),
    audit: new AuthorizedUserAuditRepo(db),
    notifications: new NotificationsRepo(db),
    tasks: new TasksRepo(db),
    taskPreviews: new TaskPreviewsRepo(db),
    reminders: new RemindersRepo(db),
    briefings: new BriefingsRepo(db),
    dependencies: new DependenciesRepo(db),
    auditLog: new AuditLogRepo(db),
    retention: new RetentionRepo(db),
    agentThreads: new AgentThreadsRepo(db),
    assistantImport: new AssistantImportRepo(db),
    rollbackDelta: new RollbackDeltaRepo(db),
    withDeletionCause,
    clearStaleDeletionContext: () => Number(db.prepare('DELETE FROM deletion_context').run().changes),
    scheduleRules: new ScheduleRulesRepo(db),
    ownerPreferences: new OwnerPreferencesRepo(db),
    assistantWatch: new AssistantWatchRepo(db),
    nativeTransitions: new NativeTransitionsRepo(db),
  };
}
