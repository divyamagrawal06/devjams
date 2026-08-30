# Design System

## Product Scene

An owner checks a live workload from a laptop or phone while players and users may already be
connected. The interface should feel like a familiar game launcher, but every operational state
must read with the precision of a control room.

## Visual Direction

The product uses a restrained, warm palette over a cherry-blossom panorama. Minecraft references
belong in framing, texture, and occasional Monocraft display text. Forms, status, data, and
controls use familiar product-interface patterns and a system sans-serif stack.

The desktop is playful. Authority boundaries, errors, confirmations, and recovery copy are calm
and literal. Decoration never makes an unavailable connector look active.

## Color Tokens

All authored colors use OKLCH. Components consume semantic variables rather than new literals.

| Token | Role |
|---|---|
| `--ink` | Primary text on paper surfaces |
| `--ink-soft` | Secondary text and metadata |
| `--paper` | Main window surface |
| `--paper-raised` | Inputs and raised controls |
| `--paper-sunken` | Inset and selected neutral surfaces |
| `--line` | Strong boundaries |
| `--line-soft` | Dividers and quiet boundaries |
| `--earth` | Window chrome and secondary dark surfaces |
| `--earth-deep` | Desktop ground and strongest neutral |
| `--moss` | Success and healthy state |
| `--moss-deep` | Success text on light surfaces |
| `--amber` | Warning and pending state |
| `--clay` | Destructive action and error emphasis |
| `--clay-deep` | Error text on light surfaces |
| `--focus` | Keyboard focus indicator, at least 3:1 against adjacent surfaces |
| `--sky-ink` | Primary text on dark or image-backed chrome |
| `--sky-muted` | Secondary text on dark or image-backed chrome |
| `--shadow` | Pixel-window elevation |

Status must never rely on color alone. Pair every color state with text, an icon, or both.

## Typography

- Interface text: `Inter`, then the native system sans-serif stack.
- Display accent: `Monocraft`, limited to product identity and compact window chrome.
- Body copy: 0.875 to 1rem with a maximum line length of 70 characters.
- Labels: sentence case, compact, and direct.
- Data and identifiers: system monospace where exact copying matters.
- Headings use a clear fixed scale with at least a 1.25 size or weight contrast between levels.

## Spacing and Layout

- Base spacing unit: 4px.
- Control gaps: 8px to 12px.
- Window padding: 16px on compact surfaces, 20px to 24px on primary task surfaces.
- Minimum interactive target: 44 by 44px.
- Desktop windows use predictable title bars, foreground ordering, and visible boundaries.
- Mobile presents one foreground task at a time. Avoid desktop-style overlapping windows below
  the tablet breakpoint.
- Short-height and landscape layouts keep navigation and the primary action visible.

## Components

Every interactive component provides default, hover, focus, active, disabled, loading, success,
and error behavior when those states apply.

### Buttons

- Primary actions use the product accent only when they are the current next step.
- Destructive actions include impact copy before confirmation.
- Disabled actions explain the missing prerequisite nearby.
- Loading labels describe the operation, such as `Starting workload`, rather than `Loading`.

### Windows

- Opening a window moves keyboard focus to its heading or first task control.
- Closing restores focus to the launcher that opened it.
- Escape closes the foreground dismissible window.
- Pointer and keyboard focus both raise a window.
- Window controls have accessible names and 44px targets.

### Forms

- Every field has a persistent label.
- Validation appears beside the field and in an announced summary when submission fails.
- Structured creation is the primary path. Allay may fill the same structure, but does not own a
  separate capability catalogue.

### Operational State

- Show observed state, desired state, last successful refresh, and stale status separately.
- Cached data remains labelled as cached when the live connector fails.
- Mutations show pending, accepted, completed, refused, and recoverable-failure states.
- Approval surfaces show the exact principal, operation, target, digest, expiry, and redemption
  status.

### Operator Home and Onboarding

- Operator Home is the first-workload and daily-control surface. It reports the last successful
  observation separately from connection health and disables power controls when that observation
  is stale.
- Workload creation reads the backend capability catalogue. Unavailable dedicated-game, Node, and
  bounded-container connectors remain visible but cannot be selected.
- Before creation, show the account-wide projected workload, CPU, memory, and storage totals. A
  failed workload still owns capacity until it is deleted.
- Start, stop, and restart requests use a stable browser request key and return a durable receipt.
  A transport error keeps the key for safe retry.
- Maintenance windows are planning records only. Scheduling one never executes or approves an
  operation. Notification preferences are in-app only until an external delivery connector exists.

### Recovery and Billing

- Recovery Center names snapshot restore and rule rollback as separate systems. Snapshot restore
  replaces world data and requires an explicit data-loss acknowledgement; rule rollback follows
  the reviewed deployment ledger.
- Billing state changes only from a verified provider webhook. Checkout return URLs are status
  hints, never entitlement authority.
- Billing surfaces distinguish active, bounded grace, starter, over-quota, and reconciliation
  states. Downgrades preserve existing workloads and block only new allocation until usage fits.
- An uncertain checkout remains visible and reuses its request key. Never offer a second invisible
  checkout while the first provider outcome is unknown.

### Review and Trust Surfaces

- Rule Forge creates a bounded Minecraft rule draft and never deploys it.
- Every Change Envelope shows its immutable content digest, artifact digest, runtime version, and
  provenance before review.
- Approval requires a deliberate human confirmation against the exact artifact digest. Rejection
  requires a reason and leaves no deployment controls active.
- The Trust Ledger replays durable operational receipts from the last acknowledged event ID.
  Reconnect states stay visible, and duplicate receipts are suppressed by their durable IDs.
- A deployment timeline reports review and control-plane evidence only. It never implies player,
  chat, or world telemetry that the product has not collected.

### Empty and Unavailable States

- Empty states teach the first useful action.
- Unavailable connectors say what is missing and do not render active-looking controls.
- Fixture data is allowed only in explicitly labelled development or test surfaces.

## Motion

- State transitions last 150 to 250ms and use ease-out quart, quint, or expo curves.
- Animate opacity and transforms, not layout properties or background position.
- Motion communicates state change or focus. It is not decorative choreography.
- `prefers-reduced-motion` disables nonessential movement.

## Accessibility

- Target WCAG 2.2 AA.
- Focus indicators maintain at least 3:1 contrast against every adjacent surface.
- Text maintains at least 4.5:1 contrast at normal sizes.
- Live connection, stale data, mutation results, and errors are announced without depending on
  visual icons.
- Composite widgets either implement the expected keyboard model or use a simpler semantic group.
- Destructive inline disclosures use `aria-expanded`, `aria-controls`, and deliberate focus
  movement.

## Copy Rules

- Use specific nouns and verbs: `Stop Valheim server`, not `Confirm action`.
- State player or user impact before a destructive operation.
- Never claim that a change is instant, invisible, or complete before live evidence confirms it.
- Separate rule rollback from snapshot restore and state the data-loss boundary.
- Avoid vague AI language. Describe what Allay read, drafted, or requested.
- Do not use em dashes.
