# Conversation presentation

## ADDED Requirements

### Requirement: Plain, usable conversational output
Chat output SHALL use short plain Markdown paragraphs without decorative headings, habitual heavy bold, middle-dot separators or gratuitous em dashes. Actionable controls SHALL be actual Discord buttons rather than unclickable action text.

#### Scenario: Actionable reply
- **WHEN** a conversation turn offers Branch or Compact
- **THEN** the client renders real controls and concise readable text.

### Requirement: No implicit workflow dispatch
This build SHALL NOT add a competing repository workflow dispatcher for `$grill-me`, `$ticket`, or `$agentize`. If a later supported integration adds those workflows, only an initial unquoted first token may trigger one; quoted/code/bot/notification text is data. Any grilling copy already supported by this build SHALL ask all currently unblocked numbered questions with concise recommendations and expand when needed.

#### Scenario: Quoted workflow word
- **WHEN** a user quotes `$ticket` within an ordinary answer
- **THEN** no ticket workflow starts.

### Requirement: Deadline presentation
Configured local deadlines SHALL appear without a Manila/timezone suffix and without a `Reminder: 1 hour before` line. Timezone and reminder scheduling remain internal.

#### Scenario: Deadline card
- **WHEN** a configured local deadline is displayed
- **THEN** neither suffix nor reminder line appears.
