import { z } from 'zod';

/**
 * The reply envelope, pinned to what was actually observed.
 *
 * Recorded by `pnpm probe:openclaw` into `openclaw.fixtures/`, from a real
 * successful agent turn against a ChatGPT/Codex subscription OAuth profile. The
 * fixture holds the SHAPE only -- every leaf is a type, never a value -- because
 * the reply is a model's answer to a prompt and does not belong in a committed
 * file.
 *
 * Observed top level: exactly `payloads` and `meta`.
 *
 * ## What is required, and why so little of it
 *
 * Only `payloads[].text` is required, because it is the only thing Ducky
 * actually needs and the only thing whose absence means the turn produced
 * nothing usable. Everything else observed in `meta` -- and there is a lot of
 * it: `agentMeta`, `systemPromptReport`, `executionTrace`, usage counters --
 * is deliberately NOT modelled.
 *
 * That is not laziness. Three reasons, in order of weight:
 *
 * 1. **Most of it is somebody else's internals.** `systemPromptReport` carries
 *    a `workspaceDir`, file lists, tool names and prompt hashes. Ducky has no
 *    use for any of it, and a schema that named those fields would invite a
 *    later change to start reading them.
 * 2. **A strict schema here would be a fragile schema.** These are internal
 *    diagnostics of a tool that is not ours; they will change between versions,
 *    and a required field that disappears would turn a working reply into a
 *    parse failure.
 * 3. **`.passthrough()` is deliberate too.** An unknown key is normal and must
 *    not be an error, but nothing reads one.
 *
 * ## What is checked and NOT modelled as optional
 *
 * `deliveryStatus` appears at the top level only when `--deliver` was passed.
 * Ducky never passes it and the recorded envelope does not contain it, so it is
 * absent from this schema on purpose: if one ever appeared, something built an
 * argv nobody intended, and that should be visible rather than parsed happily.
 */
export const OpenClawPayloadSchema = z
  .object({
    /** The assistant's visible answer. The one field Ducky consumes. */
    text: z.string(),
    /**
     * Observed as `null`. An agent turn takes text only and returns text; this
     * is the outbound-media field a chat-channel send would use.
     *
     * Typed as nullable-and-optional rather than `z.null()`: refusing a reply
     * because a field Ducky ignores turned out non-null would be a bad trade.
     * Nothing reads it.
     */
    mediaUrl: z.string().nullable().optional(),
  })
  .passthrough();

export const OpenClawReplySchema = z
  .object({
    payloads: z.array(OpenClawPayloadSchema),
    /**
     * Present in every observed reply, and unmodelled beyond `durationMs`.
     * See the note above: the rest is the tool's own diagnostics.
     */
    meta: z
      .object({ durationMs: z.number().optional() })
      .passthrough()
      .optional(),
    /**
     * `in_flight` when a run for this session key is already active. Documented
     * by the CLI and NOT observed here, so it is optional -- but it is modelled,
     * because it is the one documented case where a well-formed envelope
     * carries no answer, and treating that as an empty reply would be wrong.
     */
    status: z.string().optional(),
  })
  .passthrough();

export type OpenClawReply = z.infer<typeof OpenClawReplySchema>;

/**
 * The assistant's text, or a reason there is none.
 *
 * Several payloads are joined rather than the first taken: the field is an
 * array, and silently dropping the rest would lose part of an answer the owner
 * asked for.
 */
export function replyTextFrom(reply: OpenClawReply): { text: string } | { refusal: string } {
  if (reply.status === 'in_flight') {
    return {
      refusal:
        'A reply to your previous message is still being generated. Wait for it rather than ' +
        'asking again.',
    };
  }
  const text = reply.payloads
    .map((p) => p.text.trim())
    .filter((t) => t !== '')
    .join('\n\n');
  if (text === '') {
    // A well-formed envelope with nothing in it. Reported as a failure rather
    // than answered with an empty message, which would read as Ducky ignoring
    // the owner.
    return { refusal: 'The assistant returned no text.' };
  }
  return { text };
}
