# OpenClaw integration

## Status: installed and probed; contract recorded in HALF; provider still unverified

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
| `agent-turn-attempt.json` | the auth model, observed by running a turn |
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
openclaw agent --json --session-key agent:<id>:<thread> --message <text>
```

`--message-file` carries a long body, `--session-id`/`--session-key` carry
thread identity, `--thinking` and `--timeout` are bounded knobs. **`--deliver`
exists and must never be passed**: it sends the agent's reply into a chat
channel, which is Ducky's job and not the provider's.

**3. An agent turn takes TEXT ONLY.** There is no attachment input on it at all.
`message send --media` exists, but that is *outbound to a chat channel* — a
different operation. So milestone 2C's attachment gate stays closed for this
provider **even after its text contract is verified**, and
`capabilities.attachments` must stay `NO_ATTACHMENT_CAPABILITY`. Recording that
now is the point: it is the over-claim that would have mattered most.

### The half that could not be recorded, and why

A real turn was attempted, in the isolated `--dev` profile, without
`--deliver`:

```
openclaw --dev --no-color agent --local --json \
  --session-key agent:probe:ducky-probe --message 'reply with the single word pong'
```

It failed, and **how** it failed is the recorded fact: `ProviderAuthError`
("No API key found for provider \"openai\""), exit code 1, **empty stdout even
with `--json`**, diagnostics on stderr, and a remediation hint pointing at
`openclaw agents add <id>`.

`agents add` is the interactive per-agent helper, and it will also happily take
a pasted API key. The route this project takes is the **subscription** one —
`models auth login --provider openai` — for the reason given under "Finishing
the integration" below. `openclaw models auth list` confirms the current state
directly: `Profiles: (none)`, in the default store *and* the `--dev` store.

So no successful reply envelope has ever been observed on this host. Half a
contract is not a contract:

- `RECORDED_CONTRACT_VERSION` stays `null`;
- `GatewayOpenClawProvider.initializable()` refuses, and says which half is
  missing;
- `reply()` throws `integration_not_verified`;
- production selecting `openclaw` fails **at startup**, not on the owner's first
  message;
- `pnpm probe:openclaw` exits **2** — a partial recording must not read as
  success;
- `DUCKY_CONVERSATION_PROVIDER=disabled` remains the honest production mode.

Nothing in this repository will configure a model provider for an OpenClaw
agent. That spends money on somebody's account, and it is the owner's call.

## Provider modes

`DUCKY_CONVERSATION_PROVIDER` decides, explicitly:

| Mode | development | production |
|---|---|---|
| unset | `mock` | **refused at startup** |
| `mock` | allowed, every reply prefixed `[mock]` | **refused at startup** |
| `disabled` | allowed | allowed — the honest choice today |
| `openclaw` | allowed; needs a private `OPENCLAW_BASE_URL`, fails per request | **refused at startup** while no reply contract is recorded |

This replaced `if (!OPENCLAW_BASE_URL) return mock`, which had **no profile
check at all** — so a production instance with the variable unset silently
answered the owner from a canned mock.

`RECORDED_CONTRACT_VERSION` is a **source constant, not an environment
variable**, on purpose: an operator can set a variable but cannot conjure an
observed response shape, and `verified` has to mean "a contract was recorded" or
it means nothing.

## Finishing the integration

1. **Sign in with a ChatGPT/Codex subscription.** This is the only remaining
   blocker, and it is an owner action: it needs a TTY and it spends somebody's
   subscription quota.

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
2. Run `pnpm probe:openclaw` again. It records a reply envelope **only if a turn
   actually succeeds**, and exits 2 while one has not.
3. Pin zod schemas against the recorded envelope and implement `reply()` over
   the CLI contract: argv only, through `runArgv`, no shell, a mandatory
   timeout, and never `--deliver`. Classify the operations in
   `COMMAND_POLICY` first — an unclassified binary is refused before it spawns,
   which is now true of `herdr` as well as `gh` and `git`.
4. Add the response cases to `openclaw-contract.test.ts` beside the request ones.
5. Set `RECORDED_CONTRACT_VERSION` to the version the fixtures represent.
6. Leave `capabilities.attachments` unavailable. See finding 3.

## Consequence for conversation attachments (2C)

The 2C pipeline is built and closed. An attachment on a conversation message is
refused **before download** because `attachmentsUsable` requires the provider to
be both `verified` and attachment-capable. OpenClaw is neither: its reply
contract is unrecorded, and its agent turn has no attachment input to begin
with.

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
`supportsBinary: true` and `SCHEDULE_BINARY_EXTRACTION_ENABLED=true`.

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
