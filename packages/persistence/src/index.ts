export * from './db.js';
export * from './migrate.js';
export { MIGRATIONS, type Migration } from './migrations.js';
export * from './repositories/types.js';
export * from './repositories/repos.repo.js';
export * from './repositories/captures.repo.js';
export * from './repositories/conversations.repo.js';
export * from './repositories/schedules.repo.js';
export * from './repositories/jobs.repo.js';
export * from './repositories/results.repo.js';
export * from './repositories/approvals.repo.js';
export * from './repositories/executors.repo.js';
export * from './repositories/herdr-workspaces.repo.js';
export * from './repositories/github-watches.repo.js';
export * from './repositories/audit.repo.js';
export * from './repositories/notifications.repo.js';
export * from './repositories/tasks.repo.js';
export * from './repositories/reminders.repo.js';
export * from './repositories/briefings.repo.js';
export * from './repositories/dependencies.repo.js';
export * from './repositories/audit-log.repo.js';
export * from './repositories/retention.repo.js';

import type { Db } from './db.js';
import { ReposRepo } from './repositories/repos.repo.js';
import { CapturesRepo } from './repositories/captures.repo.js';
import { ConversationsRepo } from './repositories/conversations.repo.js';
import { SchedulesRepo } from './repositories/schedules.repo.js';
import { JobsRepo } from './repositories/jobs.repo.js';
import { ResultsRepo } from './repositories/results.repo.js';
import { ApprovalsRepo } from './repositories/approvals.repo.js';
import { ExecutorsRepo } from './repositories/executors.repo.js';
import { HerdrWorkspacesRepo } from './repositories/herdr-workspaces.repo.js';
import { GitHubWatchesRepo } from './repositories/github-watches.repo.js';
import { AuthorizedUserAuditRepo } from './repositories/audit.repo.js';
import { NotificationsRepo } from './repositories/notifications.repo.js';
import { TasksRepo } from './repositories/tasks.repo.js';
import { RemindersRepo } from './repositories/reminders.repo.js';
import { BriefingsRepo } from './repositories/briefings.repo.js';
import { DependenciesRepo } from './repositories/dependencies.repo.js';
import { RetentionRepo } from './repositories/retention.repo.js';
import { AuditLogRepo } from './repositories/audit-log.repo.js';

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
  readonly schedules: SchedulesRepo;
  readonly jobs: JobsRepo;
  readonly results: ResultsRepo;
  readonly approvals: ApprovalsRepo;
  readonly executors: ExecutorsRepo;
  readonly herdrWorkspaces: HerdrWorkspacesRepo;
  readonly githubWatches: GitHubWatchesRepo;
  readonly audit: AuthorizedUserAuditRepo;
  readonly notifications: NotificationsRepo;
  readonly tasks: TasksRepo;
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
}

export function createStore(db: Db): Store {
  return {
    db,
    repos: new ReposRepo(db),
    captures: new CapturesRepo(db),
    conversations: new ConversationsRepo(db),
    schedules: new SchedulesRepo(db),
    jobs: new JobsRepo(db),
    results: new ResultsRepo(db),
    approvals: new ApprovalsRepo(db),
    executors: new ExecutorsRepo(db),
    herdrWorkspaces: new HerdrWorkspacesRepo(db),
    githubWatches: new GitHubWatchesRepo(db),
    audit: new AuthorizedUserAuditRepo(db),
    notifications: new NotificationsRepo(db),
    tasks: new TasksRepo(db),
    reminders: new RemindersRepo(db),
    briefings: new BriefingsRepo(db),
    dependencies: new DependenciesRepo(db),
    auditLog: new AuditLogRepo(db),
    retention: new RetentionRepo(db),
  };
}
