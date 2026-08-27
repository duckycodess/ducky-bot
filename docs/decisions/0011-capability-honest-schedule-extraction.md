# 0011. Capability-honest schedule extraction

**Status:** Accepted

## Context

`/schedule` was meant to accept a photo or a PDF of a timetable. No provider on
this host can read those bytes: OpenClaw is not installed, and shipping an image
or PDF decoder would add a substantial parsing attack surface for untrusted
uploads.

An earlier design accepted such uploads and passed them to a mock, which would
have shown the owner a preview derived from nothing.

## Decision

Providers declare `supportsBinary`. The Phase 1 deterministic extractor reports
`false`, and binary extraction is additionally gated behind an environment flag
that defaults off. **Both** must be true for an image or PDF to be accepted.

So today those uploads are **refused at the metadata check, before any network
request**, with a message that says what to send instead. No download, no
temporary file, no decoder in the codebase at all.

A preview renders only from candidates a provider actually produced. Zero
candidates yields "No schedule entries found" — never an invented draft.

Separately, and for the same honesty reason: **nothing is persisted before
confirmation.** Pending drafts live in an in-memory TTL store; there is no
table that could hold schedule content pre-confirmation, and a test dumps every
table to prove it. A restart therefore loses pending previews by design, and
confirming an unknown draft reports that it expired rather than reconstructing
anything.

## Alternatives considered

- **Accept and mock.** A fabricated preview the owner might confirm.
- **Ship an OCR or PDF library.** A large parser on untrusted input, for a
  feature with no verified provider behind it.
- **Persist drafts.** Extracted personal data in the database before the owner
  has agreed to keep any of it.

## Consequences

Text and CSV work end to end. Image and PDF support is an explicit, documented
gap rather than a silent failure. Phase 1 ships no binary parsing surface.
Enabling it later requires a provider that genuinely reports `supportsBinary`
plus the environment flag.
