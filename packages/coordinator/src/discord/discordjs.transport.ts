import { sanitizeOutbound } from './sanitize-outbound.js';
import type { OutboundMessage, SendTarget } from './message.js';
import type { DiscordSink, DiscordTransport, Incoming, IncomingHandler } from './transport.js';

/**
 * The ONLY module allowed to touch discord.js (asserted by an architecture
 * test). The client is reached through a small sink so the sanitization
 * boundary can be exercised with a fake in tests.
 *
 * discord.js is imported lazily: a token-less local run never loads it.
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
        // Privileged: must be enabled in the Discord developer portal.
        GatewayIntentBits.MessageContent,
      ],
      partials: [Partials.Channel, Partials.Message],
    });
    this.#client = client;

    client.on(Events.MessageCreate, (message) => {
      if (message.author.bot) return;
      void this.dispatch({
        kind: 'message',
        userId: message.author.id,
        text: message.content,
        threadKey: message.channelId,
      }, async (reply) => {
        await message.reply(renderPlain(reply));
      });
    });

    client.on(Events.InteractionCreate, (interaction) => {
      if (interaction.isChatInputCommand()) {
        const options: Record<string, string | number | boolean | undefined> = {};
        for (const opt of interaction.options.data) {
          if (opt.value !== undefined) options[opt.name] = opt.value as string | number | boolean;
          for (const sub of opt.options ?? []) {
            if (sub.value !== undefined) options[sub.name] = sub.value as string | number | boolean;
          }
        }
        const attachmentOption = interaction.options.getAttachment?.('file') ?? null;
        void this.dispatch(
          {
            kind: 'command',
            name: interaction.commandName,
            subcommand: interaction.options.getSubcommand(false) ?? undefined,
            userId: interaction.user.id,
            options,
            attachment: attachmentOption
              ? {
                  filename: attachmentOption.name,
                  contentType: attachmentOption.contentType ?? null,
                  size: attachmentOption.size,
                  url: attachmentOption.url,
                }
              : undefined,
          },
          async (reply) => {
            await interaction.reply({ ...renderPlain(reply), ephemeral: reply.ephemeral !== false });
          },
        );
        return;
      }
      if (interaction.isButton()) {
        void this.dispatch(
          { kind: 'component', customId: interaction.customId, userId: interaction.user.id },
          async (reply) => {
            await interaction.reply({ ...renderPlain(reply), ephemeral: true });
          },
        );
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

  private async dispatch(
    event: Incoming,
    respond: (message: OutboundMessage) => Promise<void>,
  ): Promise<void> {
    if (!this.#handler) return;
    const reply = await this.#handler(event);
    if (!reply) return;
    await respond(sanitizeOutbound(reply));
  }
}

/** Minimal rendering: content plus embed text. Keeps the surface small. */
function renderPlain(message: OutboundMessage): { content: string } {
  const parts: string[] = [];
  if (message.content) parts.push(message.content);
  for (const e of message.embeds ?? []) {
    if (e.title) parts.push(`**${e.title}**`);
    if (e.description) parts.push(e.description);
    for (const f of e.fields ?? []) parts.push(`**${f.name}**\n${f.value}`);
    if (e.footer) parts.push(`_${e.footer}_`);
  }
  return { content: parts.join('\n\n') || '(no content)' };
}
