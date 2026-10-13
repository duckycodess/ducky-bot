# Proposal

## Why

Guild channel messages currently share one channel key, native thread children lose their role, and OpenClaw persists a second transcript that `/forget` cannot erase. This prevents durable, scoped conversations and makes deletion claims incomplete.

## What Changes

- A qualifying top-level message starts exactly one native Discord thread; subsequent messages and replies stay in it. Explicit Branch and Compact controls operate on the conversation, not on Discord-visible history.
- Persist full per-thread conversation history and a separate bounded model-context summary/checkpoint. Scope replay to visible participants in that thread; retain owner-only command and control authorization.
- Delete targeted application and supported provider session state on Forget, invalidate replay on incomplete deletion, report actual deletion coverage, and audit counts only.
- Render conversational/grilling replies as concise plain Markdown, preserving actionable controls as buttons; update the relevant ADRs and tests.

## Capabilities

### New Capabilities

- `discord-thread-conversations`: Native thread creation, routing, reply anchoring, branching, participation, durable transcript, bounded compaction and deletion across stores.
- `conversation-presentation`: Plain conversational/grilling language and compact actionable controls.

### Modified Capabilities

None: this worktree has no existing OpenSpec capability inventory.

## Impact

Discord transport/context and roles, router and controls, conversation memory and SQLite migrations/retention, provider port/OpenClaw adapter and deletion policy, tests, ADRs and operator configuration. No general-chat tool access or independent engineering pipeline.
