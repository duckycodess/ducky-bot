# Completion report wording

A completion report must not imply coverage that was never demonstrated. Use
**exactly one** of the two forms below. The phrase "Phase 1 end-to-end" is never
used unqualified.

## (A) Live Herdr integration verified

> Phase 1 is complete end-to-end against mock Discord, mock OpenClaw and mock Pi
> providers. The real Herdr/Pi orchestrator is **verified** against recorded live
> fixtures (`pnpm probe:herdr` run on `<date>`), covering `<commands>`.
> `<commands not exercised>` were not exercised.

## (B) Live Herdr integration not verified

> Phase 1 is complete end-to-end against mock providers. The real Herdr/Pi
> orchestrator is **EXPERIMENTAL and unverified** — `pnpm probe:herdr` could not
> be run (`<reason>`), so no live Herdr integration is claimed.

## Always state

- Which providers were mocked (conversation is always mocked in Phase 1)
- That approved actions are recorded and **not executed**
- That document and image schedule extraction is **unsupported**
- The exact commands run and their results — never a check that was not run
