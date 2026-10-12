import { sanitizeOutbound } from './sanitize-outbound.js';
import { EPHEMERAL_FLAG, toDiscordPayload, toModalPayload } from './payload.js';
import type { ThreadStartOutcome } from '../domain/conversation-threads.js';
import type { OutboundMessage, SendTarget } from './message.js';
import type {
  ConversationThreadEntry, DiscordSink, DiscordTransport, Incoming, IncomingAuthorKind,
  IncomingHandler, IncomingMessage,
} from './transport.js';

/**
 * The ONLY module allowed to import discord.js (asserted by a test).
 *
 * discord.js is loaded lazily, so a token-less local run never pulls it in.
 * Everything sent is sanitized here, at the boundary, before any client sees
 * it, and converted structurally so embeds, action rows and buttons survive.
 */
/**
 * Connect, confirm the gateway accepted us, and leave. Registers NOTHING.
 *
 * `MessageContent` is a PRIVILEGED intent: if it is not enabled in the
 * developer portal the gateway refuses the connection outright rather than
 * degrading, so every DM, reminder, briefing and conversational reply fails
 * together and the symptom looks like "the bot will not start". That is worth
 * being able to check without a human and without a coordinator.
 *
 * It lives HERE, in the one module permitted to import discord.js, rather than
 * in the probe that uses it. A probe with its own `import('discord.js')` would
 * make that guarantee two modules wide for the sake of one connection.
 *
 * **No handler is registered, deliberately.** A coordinator may already be
 * running on this same bot identity; two connections both wired to respond
 * would race to answer the same interaction. This one is deaf, so an event
 * arriving while it is connected is still answered by the real coordinator.
 */
export async function probeGatewayConnection(
  token: string,
  timeoutMs = 30_000,
): Promise<{ ok: true; ms: number; guilds: number } | { ok: false; error: string }> {
  const discord = (await import('discord.js')) as typeof import('discord.js');
  const { Client, GatewayIntentBits, Partials, Events } = discord;

  // EXACTLY what `start` asks for. Asking for less would prove nothing about
  // the intent that actually blocks startup.
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      // Guild MESSAGE events. `Guilds` alone carries guild and channel
      // metadata and delivers no message at all, which is why a message in a
      // guild channel produced no reply while DMs worked.
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.DirectMessages,
      GatewayIntentBits.MessageContent,
    ],
    partials: [Partials.Channel, Partials.Message],
  });

  const startedAt = Date.now();
  const settled = new Promise<{ ok: true; ms: number; guilds: number } | { ok: false; error: string }>(
    (resolve) => {
      client.once(Events.ClientReady, (c) =>
        resolve({ ok: true, ms: Date.now() - startedAt, guilds: c.guilds.cache.size }),
      );
      client.once(Events.Error, (err) => resolve({ ok: false, error: err.message }));
      setTimeout(() => resolve({ ok: false, error: `no READY within ${timeoutMs}ms` }), timeoutMs)
        .unref();
    },
  );

  try {
    await client.login(token);
    return await settled;
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  } finally {
    // Always. Leaving this open would be a second client on the bot for as
    // long as the process lived.
    await client.destroy().catch(() => undefined);
  }
}

export class DiscordJsTransport implements DiscordTransport {
  readonly kind = 'real';
  #handler: IncomingHandler | undefined;
  #client: unknown;
  #enterThread: ConversationThreadEntry | undefined;
  #threadGone: ((threadId: string) => void) | undefined;

  constructor(
    private readonly token: string,
    private readonly sinkFactory: (client: unknown) => DiscordSink,
    private readonly sink?: DiscordSink,
    /**
     * Whether an interaction's reply should be visible in the channel.
     *
     * Injected as a PREDICATE rather than a policy object, so the transport
     * holds no domain rule of its own -- it asks a question and obeys the
     * answer. The composition root builds it from the same
     * `ReplyPersistencePolicy` the router uses, which is what stops the two
     * from disagreeing.
     *
     * Absent means ephemeral, which is the conservative default and what every
     * instance with no role channel configured gets.
     */
    private readonly persists?: (event: Incoming) => boolean,
  ) {}

  useConversationThreads(enter: ConversationThreadEntry, onGone?: (threadId: string) => void): void {
    this.#enterThread = enter;
    this.#threadGone = onGone;
  }

  async start(handler: IncomingHandler): Promise<void> {
    this.#handler = handler;
    if (this.sink) return; // injected sink: nothing to connect

    const discord = (await import('discord.js')) as typeof import('discord.js');
    const { Client, GatewayIntentBits, Partials, Events } = discord;
    const client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        /**
         * Guild MESSAGE events, and the reason this list is not shorter.
         *
         * `Guilds` carries guild and channel METADATA. It delivers no message.
         * Without `GuildMessages`, `MessageCreate` never fires for a guild
         * channel -- so DMs worked, every guild channel was silent, and it
         * looked exactly like a provider that was not answering.
         *
         * Not privileged, unlike `MessageContent` below, so it needs no portal
         * toggle. It is still the narrowest thing that makes a guild
         * conversation possible: no presence, no members, no reactions, no
         * voice.
         */
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.DirectMessages,
        // Privileged: must be enabled in the Discord developer portal, or DMs
        // and guild messages arrive with empty content.
        GatewayIntentBits.MessageContent,
      ],
      partials: [Partials.Channel, Partials.Message],
    });
    this.#client = client;

    client.on(Events.MessageCreate, (message) => {
      if (message.author.bot) return;

      /**
       * Typing, while the model thinks.
       *
       * A real turn takes twenty to thirty seconds and Discord shows nothing
       * during it, so the assistant reads as broken. `sendTyping` is the
       * platform's own affordance for exactly this and carries NO content.
       *
       * Strictly best-effort: fired and forgotten, never awaited, and its
       * failure is swallowed. It must not delay routing, alter it, or fail a
       * reply -- an indicator is a courtesy, and a courtesy that can break the
       * answer is not one. There is deliberately no fake progress text.
       */
      void (async () => {
        try {
          await (message.channel as { sendTyping?: () => Promise<unknown> }).sendTyping?.();
        } catch {
          /* the channel may not permit it, or may be gone; either is fine */
        }
      })();

      const event: IncomingMessage = {
        kind: 'message',
        userId: message.author.id,
        text: message.content,
        threadKey: message.channelId,
        messageId: message.id,
        authorKind: authorKindOf(message),
        // The same context a command carries. `guildId` is null in a DM, and
        // normalizing it to undefined is what lets every policy tell a private
        // conversation from a guild channel rather than guessing from an id.
        context: {
          channelId: message.channelId,
          guildId: message.guildId ?? undefined,
          // Present only for a thread. A thread's id is not its parent's, so
          // without this every configured-channel policy answers "no" for a
          // thread under that channel.
          ...(parentChannelIdOf(message) === undefined
            ? {}
            : { parentChannelId: parentChannelIdOf(message) }),
        },
        ...(referenceOf(message) === undefined ? {} : { reference: referenceOf(message) }),
        // Metadata only. Nothing is fetched here; the router decides whether
        // anything may be, and refuses before any download when it may not.
        attachments: [...message.attachments.values()].map((a) => ({
          filename: a.name,
          contentType: a.contentType ?? null,
          size: a.size,
          url: a.url,
        })),
      };

      void this.deliverMessage(message, event);
    });

    client.on(Events.InteractionCreate, (interaction) => {
      if (interaction.isChatInputCommand()) {
        void this.handleDeferred(interaction, this.fromCommand(interaction));
        return;
      }
      if (interaction.isButton()) {
        void this.handleComponent(interaction);
        return;
      }
      if (interaction.isModalSubmit()) {
        void this.handleDeferred(interaction, {
          kind: 'component',
          customId: interaction.customId,
          userId: interaction.user.id,
          values: modalValues(interaction),
        });
      }
    });

    await client.login(this.token);
  }

  async stop(): Promise<void> {
    this.#handler = undefined;
    const client = this.#client as { destroy?: () => Promise<void> } | undefined;
    await client?.destroy?.();
  }

  /** Sanitization happens here, before anything reaches a client. */
  async send(target: SendTarget, message: OutboundMessage): Promise<void> {
    const safe = sanitizeOutbound(message);
    const sink = this.sink ?? this.sinkFactory(this.#client);
    await sink.deliver(target, safe);
  }

  // --------------------------------------------------------------------------

  /**
   * Routes one message into the conversation it belongs to, and answers THERE.
   *
   * The thread decision runs BEFORE routing, because it decides the
   * `threadKey` everything downstream is scoped by -- memory, participation
   * and the provider session all key on it.
   *
   * A refusal is published in the channel and the message is NOT routed. That
   * is the important half: a thread that could not be created must never fall
   * back to answering in the shared parent, because the parent is a different
   * conversation with a different audience.
   */
  private async deliverMessage(
    message: import('discord.js').Message,
    event: IncomingMessage,
  ): Promise<void> {
    let routed = event;
    let threadId: string | undefined;

    if (this.#enterThread) {
      const outcome = await this.#enterThread(event);
      if (outcome.kind === 'refused') {
        await message
          .reply(toDiscordPayload({ content: outcome.message, ephemeral: false }))
          .catch(() => undefined);
        return;
      }
      if (outcome.kind === 'thread' && outcome.threadId !== event.threadKey) {
        threadId = outcome.threadId;
        routed = {
          ...event,
          threadKey: outcome.threadId,
          context: {
            channelId: outcome.threadId,
            guildId: event.context?.guildId,
            // The channel the message was actually typed in becomes the
            // thread's parent, which is what makes role inheritance and
            // shared-channel exclusion work on the very first turn.
            parentChannelId: event.context?.channelId,
          },
        };
      }
    }

    const reply = await this.route(routed);
    if (!reply) return;
    const payload = toDiscordPayload({ ...reply, ephemeral: false });

    if (threadId !== undefined) {
      const sent = await this.sendToChannel(threadId, payload);
      if (sent) return;
      // The thread exists but we cannot post in it. Say so where the owner is
      // looking, and do NOT publish the answer in the parent instead.
      await message
        .reply(
          toDiscordPayload({
            content:
              'I opened a thread for this but could not post in it, so I have not answered. ' +
              'The bot needs Send Messages in Threads here.',
            ephemeral: false,
          }),
        )
        .catch(() => undefined);
      return;
    }
    await message.reply(payload).catch(() => undefined);
  }

  private async sendToChannel(channelId: string, payload: unknown): Promise<boolean> {
    const client = this.#client as {
      channels?: { fetch(id: string): Promise<unknown> };
    } | undefined;
    if (!client?.channels) return false;
    try {
      const channel = (await client.channels.fetch(channelId)) as
        | { send?: (p: unknown) => Promise<unknown> }
        | null;
      if (!channel || typeof channel.send !== 'function') return false;
      await channel.send(payload);
      return true;
    } catch (err) {
      /**
       * `Unknown Channel` is the one failure that means something durable: the
       * thread has been deleted. Recording it starts the retention clock on
       * that conversation, and it is the ONLY signal Ducky has -- there is no
       * channel-delete event wired, and adding one would mean another gateway
       * intent for a fact this already establishes.
       *
       * Every other failure is transient and leaves the mapping alone: a
       * permission that was revoked for an afternoon must not age a
       * conversation out.
       */
      if ((err as { code?: unknown } | undefined)?.code === UNKNOWN_CHANNEL) {
        this.#threadGone?.(channelId);
      }
      return false;
    }
  }

  /**
   * Opens a native thread, from a message or standalone in a channel.
   *
   * The ONLY place thread creation touches Discord, and it reports WHY it
   * failed rather than collapsing every cause into "no". The distinction
   * matters to whoever reads the refusal: a missing permission is something
   * they fix, a rate limit is something they wait out.
   *
   * `MESSAGE_ALREADY_HAS_THREAD` (160004) is recovered by the documented
   * identity -- a thread created from a message carries that message's id --
   * so a retry rejoins the conversation instead of opening a second one.
   */
  async startThread(input: {
    readonly channelId: string;
    readonly messageId?: string | undefined;
    readonly name: string;
    readonly autoArchiveMinutes: number;
  }): Promise<ThreadStartOutcome> {
    const client = this.#client as {
      channels?: { fetch(id: string): Promise<unknown> };
    } | undefined;
    if (!client?.channels) return { ok: false, failure: 'unavailable' };

    try {
      const channel = (await client.channels.fetch(input.channelId)) as {
        messages?: { fetch(id: string): Promise<{ startThread(o: unknown): Promise<{ id: string }> }> };
        threads?: { create(o: unknown): Promise<{ id: string }> };
      } | null;
      if (!channel) return { ok: false, failure: 'unavailable' };

      if (input.messageId !== undefined) {
        if (!channel.messages) return { ok: false, failure: 'unavailable' };
        const message = await channel.messages.fetch(input.messageId);
        const thread = await message.startThread({
          name: input.name,
          autoArchiveDuration: input.autoArchiveMinutes,
        });
        return { ok: true, threadId: thread.id };
      }

      if (!channel.threads) return { ok: false, failure: 'unavailable' };
      const thread = await channel.threads.create({
        name: input.name,
        autoArchiveDuration: input.autoArchiveMinutes,
      });
      return { ok: true, threadId: thread.id };
    } catch (err) {
      return threadFailureFrom(err, input.messageId);
    }
  }

  private async route(event: Incoming): Promise<OutboundMessage | undefined> {
    if (!this.#handler) return undefined;
    const reply = await this.#handler(event);
    return reply ? sanitizeOutbound(reply) : undefined;
  }

  private fromCommand(
    interaction: import('discord.js').ChatInputCommandInteraction,
  ): Incoming {
    const options: Record<string, string | number | boolean | undefined> = {};
    const collect = (list: readonly import('discord.js').CommandInteractionOption[]): void => {
      for (const opt of list) {
        if (opt.value !== undefined) options[opt.name] = opt.value as string | number | boolean;
        if (opt.options) collect(opt.options);
      }
    };
    collect(interaction.options.data);

    const file = interaction.options.getAttachment?.('file') ?? null;
    return {
      kind: 'command',
      name: interaction.commandName,
      subcommand: interaction.options.getSubcommand(false) ?? undefined,
      userId: interaction.user.id,
      // `guildId` is null in a DM. Normalizing it to undefined is what lets
      // the shared-channel policy tell a DM from a guild channel without ever
      // matching a configured id against a private conversation.
      context: {
        channelId: interaction.channelId ?? undefined,
        guildId: interaction.guildId ?? undefined,
      },
      options,
      attachment: file
        ? {
            filename: file.name,
            contentType: file.contentType ?? null,
            size: file.size,
            url: file.url,
          }
        : undefined,
    };
  }

  /**
   * Discord rejects an interaction that is not acknowledged within three
   * seconds. Command handling can outlast that -- an attachment download, a
   * `gh` call -- so acknowledge first and edit the reply once the work is done.
   */
  private async handleDeferred(
    interaction:
      | import('discord.js').ChatInputCommandInteraction
      | import('discord.js').ModalSubmitInteraction,
    event: Incoming,
  ): Promise<void> {
    /**
     * Visibility is decided HERE, and it is final.
     *
     * `deferReply` fixes whether a reply is ephemeral; a later `editReply`
     * cannot change it. So a router that marks a reply persistent after
     * routing changes nothing in Discord -- which is precisely the bug this
     * replaced: the flag was set faithfully and discarded silently.
     *
     * The decision uses the SAME policy object the router uses, over trusted
     * transport context and the configured owner id only. Never a channel name,
     * never the reply text.
     */
    const persistent = this.persists?.(event) ?? false;
    try {
      await interaction.deferReply(persistent ? {} : { flags: EPHEMERAL_FLAG });
    } catch {
      return; // already acknowledged or expired; nothing safe to do
    }
    const reply = (await this.route(event)) ?? { content: 'Done.', ephemeral: true };
    const payload = toDiscordPayload(reply);
    // Visibility was fixed at the deferral above; an edit must not restate it.
    delete payload.flags;
    try {
      await interaction.editReply(payload);
    } catch {
      /* the interaction token expired; the owner can re-run the command */
    }
  }

  /**
   * A button either opens a modal or replies. A modal MUST be the first
   * response to its interaction, so that branch is decided before deferring.
   */
  private async handleComponent(
    interaction: import('discord.js').ButtonInteraction,
  ): Promise<void> {
    const modal = MODAL_BUTTONS.find((m) => interaction.customId.includes(`:${m.kind}:`));
    if (modal) {
      try {
        await interaction.showModal(
          toModalPayload(interaction.customId, modal.title, modal.fields) as never,
        );
      } catch {
        /* the interaction expired */
      }
      return;
    }

    try {
      await interaction.deferReply({ flags: EPHEMERAL_FLAG });
    } catch {
      return;
    }
    const reply =
      (await this.route({
        kind: 'component',
        customId: interaction.customId,
        userId: interaction.user.id,
      })) ?? { content: 'Done.', ephemeral: true };
    const payload = toDiscordPayload(reply);
    delete payload.flags;
    try {
      await interaction.editReply(payload);
    } catch {
      /* expired */
    }
  }
}


/**
 * Discord's own code for "that message already has a thread".
 *
 * Recovered rather than treated as a failure, by the documented identity: a
 * thread started from a message IS that message's id. So a retry after a crash
 * between the API call and the database write rejoins the first thread instead
 * of opening a second beside it.
 */
const MESSAGE_ALREADY_HAS_THREAD = 160004;

/**
 * Discord's code for a channel that is not there any more.
 *
 * The only failure that means a thread is GONE rather than temporarily
 * unreachable, which is why it is the only one that closes a mapping.
 */
const UNKNOWN_CHANNEL = 10003;

/** Discord REST codes that mean a permission is missing rather than a bug. */
const MISSING_PERMISSION_CODES = new Set([50001, 50013]);

function threadFailureFrom(err: unknown, messageId: string | undefined): ThreadStartOutcome {
  const e = err as { code?: unknown; status?: unknown };
  const code = typeof e?.code === 'number' ? e.code : undefined;
  const status = typeof e?.status === 'number' ? e.status : undefined;

  if (code === MESSAGE_ALREADY_HAS_THREAD && messageId !== undefined) {
    return { ok: false, alreadyExists: true, threadId: messageId };
  }
  if (code !== undefined && MISSING_PERMISSION_CODES.has(code)) {
    return { ok: false, failure: 'forbidden' };
  }
  if (status === 429) return { ok: false, failure: 'rate_limited' };
  if (status === 403) return { ok: false, failure: 'forbidden' };
  return { ok: false, failure: 'unavailable' };
}

/**
 * Who sent a message, as narrowly as discord.js can say.
 *
 * `unknown` rather than a guess when neither flag is readable, because the
 * thread policy treats unknown exactly like a bot -- a notification feed must
 * not be able to carpet a configured channel with threads because one field
 * was missing.
 */
function authorKindOf(message: import('discord.js').Message): IncomingAuthorKind {
  const m = message as unknown as {
    webhookId?: string | null;
    author?: { bot?: boolean } | undefined;
  };
  if (m.webhookId) return 'webhook';
  if (m.author?.bot === true) return 'bot';
  if (m.author?.bot === false) return 'user';
  return 'unknown';
}

/** The channel a thread hangs under, or undefined for a top-level channel. */
function parentChannelIdOf(message: import('discord.js').Message): string | undefined {
  const channel = message.channel as unknown as {
    isThread?: () => boolean;
    parentId?: string | null;
  };
  if (typeof channel?.isThread !== 'function' || !channel.isThread()) return undefined;
  return channel.parentId ?? undefined;
}

/**
 * The message this one replies to, as metadata.
 *
 * Entirely untrusted and resolved later: the router refuses a reference from
 * another thread and labels an unreadable one unavailable, rather than
 * importing either. `referencedMessage` is populated by discord.js only when
 * it is already cached, which is why the text is optional here.
 */
function referenceOf(
  message: import('discord.js').Message,
): { messageId: string; channelId?: string; text?: string; authorId?: string } | undefined {
  const ref = message.reference as { messageId?: string | null; channelId?: string | null } | null;
  if (!ref?.messageId) return undefined;
  const cached = (message as unknown as {
    referencedMessage?: { content?: string; author?: { id?: string } } | null;
  }).referencedMessage;
  return {
    messageId: ref.messageId,
    ...(ref.channelId ? { channelId: ref.channelId } : {}),
    ...(cached?.content ? { text: cached.content } : {}),
    ...(cached?.author?.id ? { authorId: cached.author.id } : {}),
  };
}

/**
 * Reads the text inputs out of a modal submission. discord.js models several
 * component kinds here, so anything without a plain string value is skipped
 * rather than coerced.
 */
function modalValues(
  interaction: import('discord.js').ModalSubmitInteraction,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const field of interaction.fields.fields.values()) {
    const candidate = field as { customId?: unknown; value?: unknown };
    if (typeof candidate.customId === 'string' && typeof candidate.value === 'string') {
      out[candidate.customId] = candidate.value;
    }
  }
  return out;
}

/**
 * Buttons that open a modal instead of replying directly. The modal reuses the
 * button's signed custom id, so the submission is verified exactly like any
 * other interaction.
 */
const MODAL_BUTTONS = [
  {
    kind: 'job_answer',
    title: 'Answer the question',
    fields: [
      { customId: 'answer', label: 'Your answer', paragraph: true, maxLength: 2000 },
    ],
  },
  {
    kind: 'sched_edit',
    title: 'Correct the schedule',
    fields: [
      {
        customId: 'entries',
        label: 'One entry per line',
        paragraph: true,
        maxLength: 4000,
      },
    ],
  },
] as const;
