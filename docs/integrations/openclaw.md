# OpenClaw integration

## Status: installed, probed, and VERIFIED — the full contract is recorded

OpenClaw **is** on this host now, installed deliberately for the final
milestone:

```
npm i --prefix ~/.local/opt/ducky-openclaw openclaw@2026.7.1-2
```

**Pinned, local, and not on `PATH`.** Not `-g`, not inside the repository, not
production. `pnpm probe:openclaw` looks for
`~/.local/opt/ducky-openclaw/node_modules/.bin/openclaw` first and falls back to
`PATH` for an operator who put it somewhere else.

Registry metadata, read before installing: `openclaw@2026.7.1-2`, MIT, bin
`openclaw`, `engines.node` accepting this host's 24.15.0, 56 dependencies
(`express`, `ws`, `undici`, `grammy`, `openai`, `kysely`, `clawpdf`…), ~87 MB
unpacked. Described as a *multi-channel AI gateway with extensible messaging
integrations*, which turned out to be exactly right and not at all what the
first adapter assumed.

## What the probe recorded

`pnpm probe:openclaw` writes redacted fixtures into
`packages/adapters/src/openclaw/openclaw.fixtures/`, and
`openclaw-contract.test.ts` asserts them.

| Fixture | What it pins |
|---|---|
| `cli.json` | version, install source, 62 top-level commands |
| `agent-cli-contract.json` | the agent-turn REQUEST shape, flag names only |
| `gateway-contract.json` | transport, bind modes, auth modes |
| `agent-turn-attempt.json` | the outcome of a real turn, and the exact argv that produced it |
| `agent-turn-reply.json` | the successful reply envelope, as a type-only shape |
| `config-locations.json` | which config directories exist; names only |

### Three findings that changed the code

**1. It is not an HTTP JSON endpoint.** OpenClaw runs a **WebSocket gateway**
(`ws://127.0.0.1:19001` on its `--dev` profile), with bind modes
`loopback | lan | tailnet | auto | custom` and auth modes
`none | token | password | trusted-proxy`. The adapter that assumed HTTP was
renamed accordingly (`GatewayOpenClawProvider`), and the private-URL guard now
accepts `ws:`/`wss:` as well as `http(s):` — otherwise a correctly configured
gateway URL would have been refused at boot.

**2. The supported one-shot contract is the CLI**, and it maps cleanly onto
`ConversationProvider.reply`:

```
openclaw agent --json --session-key agent:<id>:<thread> --message-file <path>
```

(`--message` exists and is the obvious choice; Ducky uses `--message-file`
instead, for the command-policy reason given below.) `--message-file` also
carries a long body, `--session-id`/`--session-key` carry
thread identity, `--thinking` and `--timeout` are bounded knobs. **`--deliver`
exists and must never be passed**: it sends the agent's reply into a chat
channel, which is Ducky's job and not the provider's.

**3. An agent turn takes TEXT ONLY.** There is no attachment input on it at all.
`message send --media` exists, but that is *outbound to a chat channel* — a
different operation. So milestone 2C's attachment gate stays closed for this
provider **even after its text contract is verified**, and
`capabilities.attachments` must stay `NO_ATTACHMENT_CAPABILITY`. Recording that
now is the point: it is the over-claim that would have mattered most.

### The half that is now recorded

The blocker was model provider credentials, and the owner cleared it by signing
in with a **ChatGPT/Codex subscription** — `models auth login --provider openai
--device-code`, under `--dev`. Read-only checks confirm what that produced:

```
models auth list  →  openai:ducky  [openai/oauth]
models status     →  oauth=1, token=0, api_key=0
                     openai via codex ... status=usable
```

**No API key is configured and none is read.** `api_key=0` is the measured
state, not a policy statement, and nothing in this repository reads
`OPENAI_API_KEY` or `OPENAI_ADMIN_KEY`.

The model is `openai/gpt-5.6-sol`, the documented Codex-runtime route, chosen
from what `models list --provider openai` actually offers this account.

`pnpm probe:openclaw` now exits **0** and records the reply envelope:

```json
{ "payloads": [{ "text": "…", "mediaUrl": null }], "meta": { … } }
```

recorded as a **type-only shape** — every leaf is `"string"`, `"number"`,
`"null"` — because the reply is a model's answer to a prompt and does not
belong in a committed file. A test walks the fixture asserting no real string
survived.

`meta` carries a great deal more (`agentMeta`, `systemPromptReport`,
`executionTrace`, usage counters). None of it is modelled beyond `durationMs`:
it is another tool's internals, it will change between versions, and
`systemPromptReport` contains a `workspaceDir`. The schema is permissive there
on purpose and nothing reads it.

### The historical failure, kept because it is how the blocker was found

Before the login, a real turn was attempted in the isolated `--dev` profile,
without `--deliver`:

```
openclaw --dev --no-color agent --local --json \
  --session-key agent:probe:ducky-probe --message 'reply with the single word pong'
```

It failed, and **how** it failed is the recorded fact: `ProviderAuthError`
("No API key found for provider \"openai\""), exit code 1, **empty stdout even
with `--json`**, diagnostics on stderr, and a remediation hint pointing at
`openclaw agents add <id>`.

`agents add` is the interactive per-agent helper, and it will also happily take
a pasted API key. The route this project took is the **subscription** one —
`models auth login --provider openai --device-code` — and `models auth list`
now reports one `openai/oauth` profile in the `--dev` store where it previously
reported `Profiles: (none)`.

That failure is what named the blocker precisely, and it is why the probe exits
non-zero on a partial recording rather than reporting success.

### What the adapter builds, and three choices inside it

```
openclaw --dev --no-color agent --local --json \
  --session-key agent:ducky:<thread> --message-file <path>
```

That is the argv the probe **recorded**, not a plausible reconstruction: the
probe writes the argv it actually ran into `agent-turn-attempt.json`, and a test
asserts the adapter builds the same one. An adapter pinned to a reply envelope
that some *other* invocation produced would be pinned to evidence it did not
create.

1. **`--message-file`, never `--message`.** `checkCommandAllowed` scans every
   argv element for forbidden verbs and matches whole elements — so a one-word
   message of "push", "login" or "auth" would be refused before reaching the
   subprocess, while a longer sentence sailed through. A failure that narrow is
   worth designing out rather than remembering. The body goes into a `0600` file
   in a `mkdtemp` directory, removed in a `finally` on every path.
2. **`--deliver` is never constructed**, in any profile. It would post the
   agent's reply into a chat channel; Ducky decides where its own output goes.
3. **`--local`** is what was exercised, so it is what is built. A
   gateway-backed run is a different code path and has not been observed.

### Consequences of being verified

- `RECORDED_CONTRACT_VERSION` is `'2026.7.1-2'`, and
  `GatewayOpenClawProvider.verified` is **derived** from it rather than set
  independently, so the two cannot drift.
- `initializable()` passes, so **production may select `openclaw`**.
- What that gate still does not check is whether a given host is signed in.
  Checking would mean running the CLI at boot, and a login that expired
  overnight would then stop the coordinator from starting rather than making one
  reply fail. A signed-out host gets a per-request refusal naming the remedy —
  which refuses rather than fabricating, so it is not the failure the gate
  exists for.
- `OPENCLAW_PROFILE` (`dev` | `default`) selects which local profile store to
  run under. It defaults to `dev` because that is where the contract was
  recorded and where the signed-in account lives. It is a choice about a local
  store, not a claim that a backend exists, so it does not offend ADR 0019.
- `OPENCLAW_TIMEOUT_MS` now defaults to **120 s**, not 30 s. A measured turn
  took **33 s**; the old default was inherited from the adapter that assumed
  HTTP and would have killed a normal reasoning turn.

Nothing in this repository will configure a model provider for an OpenClaw
agent. That spends money on somebody's account, and it is the owner's call.

## Provider modes

`DUCKY_CONVERSATION_PROVIDER` decides, explicitly:

| Mode | development | production |
|---|---|---|
| unset | `mock` | **refused at startup** |
| `mock` | allowed, every reply prefixed `[mock]` | **refused at startup** |
| `disabled` | allowed | allowed — and still the right choice for a host that is not signed in |
| `openclaw` | allowed | **allowed**, now that a reply contract is recorded. Needs a private `OPENCLAW_BASE_URL` and a host signed in under `OPENCLAW_PROFILE` |

This replaced `if (!OPENCLAW_BASE_URL) return mock`, which had **no profile
check at all** — so a production instance with the variable unset silently
answered the owner from a canned mock.

`RECORDED_CONTRACT_VERSION` is a **source constant, not an environment
variable**, on purpose: an operator can set a variable but cannot conjure an
observed response shape, and `verified` has to mean "a contract was recorded" or
it means nothing.

## How the integration was finished

Kept as a record of what was done, and as the procedure for any OTHER host that
needs to reach the same state — a production machine has its own profile store
and its own sign-in.

1. **Sign in with a ChatGPT/Codex subscription.** ✅ done by the owner. It needs
   a TTY and it spends somebody's subscription quota, so nothing here does it.

   ```bash
   openclaw --dev models auth login --provider openai --device-code
   ```

   Three things about that command, each recorded rather than assumed:

   - **`--provider openai` is the subscription route.** OpenClaw uses one
     provider id for both API-key auth and ChatGPT/Codex subscription auth
     (`docs/providers/openai.md` in the pinned install). `models auth login`
     runs the provider's OAuth flow; `--device-code` is its headless variant,
     which `models auth login --help` confirms exists.
   - **`--dev` is load-bearing.** `models auth list` reports the auth state
     store per profile: `~/.openclaw/agents/main/agent/openclaw-agent.sqlite`
     by default, `~/.openclaw-dev/…` under `--dev`. The probe runs everything
     under `--dev`, so a login without it lands in a store the probe never
     reads and the turn still fails with `ProviderAuthError`.
   - **Never an API key.** Not `OPENAI_API_KEY`, not `OPENAI_ADMIN_KEY`, not
     `models auth paste-api-key`. Those are OpenAI Platform billing, which is a
     different account and a different bill from the subscription the owner
     chose. Nothing in this repository configures one.

   Afterwards, select the subscription-backed model — also an owner-scoped
   local config write, in the `--dev` profile only:

   ```bash
   openclaw --dev config set agents.defaults.model.primary openai/gpt-5.6-sol
   openclaw --dev models list --provider openai   # confirms what this account exposes
   ```

   If the account does not expose GPT-5.6, `openai/gpt-5.5` is the explicit
   recovery choice. OpenClaw does not silently downgrade and neither does this.
2. Run `pnpm probe:openclaw` again. ✅ exits 0; it records a reply envelope
   **only if a turn actually succeeds**, and exits 2 while one has not.
3. Pin zod schemas against the recorded envelope and implement `reply()` over
   the CLI contract: argv only, through `runArgv`, no shell, a mandatory
   timeout, and never `--deliver`. ✅ done — `openclaw.schema.ts` and
   `openclaw.gateway.ts`. `COMMAND_POLICY` classifies `openclaw agent` as a
   local mutation (a turn writes a session record on this host) and
   `models status` as read-only; every auth verb stays forbidden, so no code
   path can sign in.
4. Add the response cases to `openclaw-contract.test.ts` beside the request
   ones. ✅ plus `openclaw-reply.test.ts` for parsing, refusals and argv.
5. Set `RECORDED_CONTRACT_VERSION` to the version the fixtures represent.
   ✅ `'2026.7.1-2'`.
6. Leave `capabilities.attachments` unavailable. ✅ See finding 3 — and note it
   matters MORE now, not less: `attachmentsUsable` requires `verified` AND a
   declared capability, and `verified` is no longer the thing holding the line.

## Consequence for conversation attachments (2C)

The 2C pipeline is built and closed. An attachment on a conversation message is
refused **before download** because `attachmentsUsable` requires the provider to
be both `verified` and attachment-capable.

**That gate now rests on one leg instead of two.** OpenClaw was neither
verified nor capable; it is now verified, so the only thing refusing an
attachment is the capability flag — and that flag is honest because the
recorded agent turn has no attachment input at all
(`attachmentInputOnAgentTurn` is empty in the fixture). A test asserts the two
shipped providers are shut for *different* reasons, precisely so that this does
not get flattened into "both are unavailable" and quietly flipped later.

No attachment byte has ever been fetched on this host, and none is sent
anywhere. See
[decisions/0015](../decisions/0015-provider-agnostic-conversation-attachments.md).

## Consequence for conversation continuity

Bounded continuity (ADR 0021) is provider-independent and already shipped, off
by default. `ConversationInput.history` is optional, and both stand-ins ignore
it, so continuity does not wait on this integration — but nothing except the
marked mock can consume it until a real provider answers.

The CLI's `--session-key agent:<id>:<key>` maps onto Ducky's per-(user, thread)
key, which is the shape continuity already stores. Ducky keeps its own history
regardless: a provider-side session is somebody else's retention policy.

## Consequence for schedules

The deterministic extractor reads text and CSV only and reports
`supportsBinary: false`. Nothing here changes that: an OpenClaw agent turn
cannot be handed an image or a PDF, so image/PDF schedule extraction stays
refused **before download**. (OpenClaw depends on `clawpdf`, so a document
capability may exist somewhere in its own surface; it has not been probed, and
an unprobed dependency is not a capability.)

Enabling binary extraction still requires both a provider reporting
`supportsBinary: true` and `SCHEDULE_BINARY_EXTRACTION_ENABLED=true` — and, on
this host, a decoder that does not exist. `pnpm probe:extraction` records that
directly.

## What the probe refuses to do

- It never runs `onboard`, `configure`, `channels add` or `pairing`: no channel
  is connected, no account is paired, nothing is sent anywhere.
- It never passes `--deliver`.
- Everything runs under the `--dev` profile, so a real configuration is never
  touched.
- It captures configuration directory names, flag names and an error CLASS —
  never a value. A fixture containing a token would be worse than no fixture.
- A partial recording exits non-zero. A probe that cannot fail is not a
  certifier.
