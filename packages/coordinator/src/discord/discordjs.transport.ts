import { sanitizeOutbound } from './sanitize-outbound.js';
import { EPHEMERAL_FLAG, toDiscordPayload, toModalPayload } from './payload.js';
import type { OutboundMessage, SendTarget } from './message.js';
import type { DiscordSink, DiscordTransport, Incoming, IncomingHandler } from './transport.js';

/**
 * The ONLY module allowed to import discord.js (asserted by a test).
 *
 * discord.js is loaded lazily, so a token-less local run never pulls it in.
 * Everything sent is sanitized here, at the boundary, before any client sees
 * it, and converted structurally so embeds, action rows and buttons survive.
 */
export class DiscordJsTransport implements DiscordTransport {
  readonly kind = 'real';
  #handler: IncomingHandler | undefined;
  #client: unknown;

  constructor(
    private readonly token: string,
    private readonly sinkFactory: (client: unknown) => DiscordSink,
    private readonly sink?: DiscordSink,
  ) {}

  async start(handler: IncomingHandler): Promise<void> {
    this.#handler = handler;
    if (this.sink) return; // injected sink: nothing to connect

    const discord = (await import('discord.js')) as typeof import('discord.js');
    const { Client, GatewayIntentBits, Partials, Events } = discord;
    const client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.DirectMessages,
        // Privileged: must be enabled in the Discord developer portal, or DMs
        // arrive with empty content.
        GatewayIntentBits.MessageContent,
      ],
      partials: [Partials.Channel, Partials.Message],
    });
    this.#client = client;

    client.on(Events.MessageCreate, (message) => {
      if (message.author.bot) return;
      void this.route({
        kind: 'message',
        userId: message.author.id,
        text: message.content,
        threadKey: message.channelId,
      }).then(async (reply) => {
        if (reply) await message.reply(toDiscordPayload({ ...reply, ephemeral: false }));
      });
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
    try {
      await interaction.deferReply({ flags: EPHEMERAL_FLAG });
    } catch {
      return; // already acknowledged or expired; nothing safe to do
    }
    const reply = (await this.route(event)) ?? { content: 'Done.', ephemeral: true };
    const payload = toDiscordPayload(reply);
    // The deferral already set ephemeral; an edit must not repeat the flag.
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
