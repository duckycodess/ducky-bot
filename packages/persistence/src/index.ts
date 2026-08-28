export * from './db.js';
export * from './migrate.js';
export { MIGRATIONS, type Migration } from './migrations.js';
export * from './repositories/types.js';
export * from './repositories/repos.repo.js';
export * from './repositories/captures.repo.js';
export * from './repositories/schedules.repo.js';
export * from './repositories/jobs.repo.js';
export * from './repositories/results.repo.js';
export * from './repositories/approvals.repo.js';
export * from './repositories/executors.repo.js';
export * from './repositories/herdr-workspaces.repo.js';
export * from './repositories/audit.repo.js';
export * from './repositories/notifications.repo.js';
export * from './repositories/tasks.repo.js';
export * from './repositories/reminders.repo.js';

import type { Db } from './db.js';
import { ReposRepo } from './repositories/repos.repo.js';
import { CapturesRepo } from './repositories/captures.repo.js';
import { SchedulesRepo } from './repositories/schedules.repo.js';
import { JobsRepo } from './repositories/jobs.repo.js';
import { ResultsRepo } from './repositories/results.repo.js';
import { ApprovalsRepo } from './repositories/approvals.repo.js';
import { ExecutorsRepo } from './repositories/executors.repo.js';
import { HerdrWorkspacesRepo } from './repositories/herdr-workspaces.repo.js';
import { AuthorizedUserAuditRepo } from './repositories/audit.repo.js';
import { NotificationsRepo } from './repositories/notifications.repo.js';
import { TasksRepo } from './repositories/tasks.repo.js';
import { RemindersRepo } from './repositories/reminders.repo.js';

export interface Store {
  readonly db: Db;
  readonly repos: ReposRepo;
  readonly captures: CapturesRepo;
  readonly schedules: SchedulesRepo;
  readonly jobs: JobsRepo;
  readonly results: ResultsRepo;
  readonly approvals: ApprovalsRepo;
  readonly executors: ExecutorsRepo;
  readonly herdrWorkspaces: HerdrWorkspacesRepo;
  readonly audit: AuthorizedUserAuditRepo;
  readonly notifications: NotificationsRepo;
  readonly tasks: TasksRepo;
  readonly reminders: RemindersRepo;
}

export function createStore(db: Db): Store {
  return {
    db,
    repos: new ReposRepo(db),
    captures: new CapturesRepo(db),
    schedules: new SchedulesRepo(db),
    jobs: new JobsRepo(db),
    results: new ResultsRepo(db),
    approvals: new ApprovalsRepo(db),
    executors: new ExecutorsRepo(db),
    herdrWorkspaces: new HerdrWorkspacesRepo(db),
    audit: new AuthorizedUserAuditRepo(db),
    notifications: new NotificationsRepo(db),
    tasks: new TasksRepo(db),
    reminders: new RemindersRepo(db),
  };
}
