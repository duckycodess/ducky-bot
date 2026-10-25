/**
 * The typed notification-watch reader port, and its records.
 *
 * The port lives with the adapters (`@ducky/adapters`, `github/watch.port.ts`)
 * because the adapter that implements it, `GhWatchReader`, is the only module
 * allowed to build the notification-watch `gh api` shapes. It is re-exported here
 * so the engine and the service keep one import path for what they consume.
 */
export {
  UnavailableAssistantWatchReader, WatchReadError,
  type AssistantWatchReader, type CommitRecord, type DiscoveredRepository, type IssueRecord, type Page,
  type PullRecord, type ReleaseRecord, type RepositoryRecord, type ReviewRecord, type RunRecord,
  type WatchReadErrorCode, type WatchRepoRef,
} from '@ducky/adapters';
