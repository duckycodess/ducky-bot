# 0014. One configured owner timezone, applied as a projection

**Status:** Accepted

## Context

Phase 1 stored and displayed everything in UTC. That was survivable while the
only timestamps were job lifecycle instants nobody reads closely. It stops
being survivable the moment there is a *daily* assistant: "due today",
"tomorrow 09:00", a morning briefing and an evening one all depend on where the
owner is, and UTC gets the day boundary wrong for most of the world.

Two things then had to be decided: what a timezone actually changes, and what
happens to the schedule rows Phase 1 already wrote.

The existing `schedules.starts_at` column turned out to matter here. It does
**not** hold a UTC instant — it holds the wall-clock text the owner typed,
`2026-09-01 09:00`, exactly as the extractor parsed it. Reinterpreting those
rows as UTC would have silently moved every existing entry by the offset.

## Decision

**One configured owner timezone, `DUCKY_OWNER_TIMEZONE`, used only as a
projection.**

- **Storage is unchanged.** Every instant the assistant writes — task due
  dates, reminder cursors, occurrence times — is an ISO-8601 UTC string, the
  same as every other timestamp in the schema. The timezone is never stored on
  a row.
- **The zone decides two things and nothing else:** which civil day an instant
  falls in, and what instant a typed wall-clock time means. Changing the
  configured zone re-renders existing rows; it never rewrites them, and there
  is no migration to run.
- **Phase 1 schedule rows keep their wall-clock text**, and are read back as a
  wall clock *in the configured zone* — which is what they always meant, since
  the owner typed them. `parseStoredWallClock` does that reading, and a row it
  cannot parse is shown verbatim rather than converted into a guess. The
  briefing's day filter matches on the stored date prefix, so it needs no
  conversion at all.
- **Rendering prefers Discord timestamps** (`<t:…:f>` beside `<t:…:R>`).
  Discord renders those in each viewer's own zone and locale, so a delivered
  message stays correct as time passes without being re-sent. The text fallback
  is assembled from numeric parts by hand, never through `toLocaleString`, so a
  host with a different default locale cannot change what the owner reads.
- **The zone is validated at startup**, against the runtime's own ICU data
  rather than a regex, and reported in `/status` and the boot diagnostics. A
  typo fails at boot instead of silently shifting a day boundary months later.
- **It is not profile-scoped.** It describes the person, not the bot, and the
  two profiles are the same person's development and production assistants.

## Alternatives considered

**Per-record timezones.** Rejected for a single-owner assistant: it multiplies
the storage, the display and the test surface to solve a problem one person
does not have.

**Store local time instead of UTC.** Rejected. It makes every comparison and
every index ambiguous, and a zone change would corrupt history rather than
re-render it.

**Migrate `schedules.starts_at` to UTC instants.** Rejected. It is a lossy,
irreversible rewrite of the owner's own words, done on an assumption about what
they meant, to save a parse at read time.

**Format times ourselves in a fixed locale.** Rejected as the primary path. A
Discord timestamp is correct for every reader without us choosing a locale for
them, and stays correct in a message that was sent hours ago.

## Consequences

- The default is `UTC`, which is a no-op for an existing deployment. Setting
  `Asia/Manila` changes only what is *shown* and how "today" is computed.
- Day boundaries are DST-correct: the day-stepping helpers move through civil
  days rather than fixed 24-hour blocks, and are tested across a spring-forward
  in `Europe/London`.
- A wall-clock time that does not exist (the skipped hour on a spring-forward
  day) resolves deterministically to the instant the clock jumps to, and one
  that occurs twice resolves to the first. Neither can throw.
- Reminder and briefing tests inject a clock and a zone, so none of this
  depends on the host's own settings.

## Follow-up

If Ducky ever serves more than one person, the zone moves from configuration to
a per-owner record. Nothing here assumes it cannot: it is read through one
`OwnerClock` interface that every assistant service takes as a dependency.
