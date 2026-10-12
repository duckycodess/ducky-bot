# Tasks

## 1. Native thread and routing

- [x] 1.1 Extend incoming transport contracts and mock parity for message ID, parent ID and reply reference; add testable starter policy plus injected ThreadStarter port, idempotent starter mapping and `160004` recovery, sanitized fixed thread name, 429/permission failure without parent fallback, seven-day auto-archive and archived-unlocked recovery; verify with transport/router tests for parent, child, bot/webhook, non-chat, locked and missing cases.
- [x] 1.2 Inherit parent role/routing on native children without widening auth or shared reads; source authorization from the existing Authorizer only, exclude parent shared channels from memory, profile-scope new config with boot conflicts/status; verify router/authz tests for owner and additional chat user.
- [ ] 1.3 Add same-thread bounded reply anchors and isolated Branch/Compact controls with signed actor/thread/anchor checks, explicit conversational-kind manifest and positive dispatch while retaining owner-only manifest; write an ADR for this narrow surface; verify old-reference, unavailable/cross-thread, copied control and branching tests.
- [ ] 1.4 Document channel setup, permission requirements and recovery in ADR 0023/operator docs; verify with targeted docs/test assertions.

## 2. Durable bounded conversation

- [x] 2.1 Add numbered SQLite migration for mapping/participants/checkpoint/provider epoch and full transcript; require verified participation proof at thread-read signature level, explicitly supersede ADR 0021 §2/§3 and verify migration/restart/per-thread participant isolation with `pnpm migrate --dry`.
- [x] 2.2 Add separate checkpoint and manual/automatic Compact with configured byte-budget provider input, durable decisions/recent turns and refusal when even compact context exceeds budget; verify memory/provider tests including restart, oversized context and unchanged transcript count.
- [ ] 2.3 Make retention lifecycle-aware with explicit deleted-thread cleanup, preserving full live transcript without wipe-all paths per owner-approved issue; document unbounded-live storage/privacy tradeoff and guest owner-mediated deletion in docs/SECURITY.md, update ADR 0020/0021/0022; verify retention tests and dry-run counts.

## 3. Targeted two-store deletion

- [ ] 3.1 Extend safe OpenClaw probe to record deletion/readback capability names without values, then verify a narrow supported deletion/readback contract and argv policy; if absent or forbidden, ship honest unsupported/partial status without weakening forbidden verbs, with recorded fixtures and no shell execution.
- [ ] 3.2 Keep existing all-user `/forget conversation` default; add safe targeted scope if supported without widening owner-only surface, track all provider actor sessions contaminated by a shared thread, persist epoch rotation for stale-session prevention and report orphaned provider data/partial deletion honestly; verify conversation-provider, conversation-memory, authz and forget tests and count-only audit.
- [ ] 3.3 Update ADR 0024 and operator docs for deletion guarantees and caveats; verify doc matches supported provider behavior.

## 4. Presentation and integration

- [ ] 4.1 Render concise Markdown conversation/grilling where existing, numbered unblocked questions where supported, actual controls, no new workflow trigger subsystem, and clean local deadline display; verify presenter/router tests for quoted data, controls and deadlines.
- [ ] 4.2 Update docs/CURRENT_STATE.md, docs/SECURITY.md, docs/ROADMAP.md and document manifest for the owner's explicit reversal of the roadmap follow-only proposal; exercise relevant focused tests, then pnpm typecheck, pnpm test, pnpm build and OpenSpec validation; document live Discord/provider checks that cannot run without a configured development profile.
