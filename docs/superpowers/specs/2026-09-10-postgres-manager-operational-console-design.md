# PostgreSQL Manager Operational Console Design

**Date:** 2026-09-10
**Status:** Approved

## Summary

The manager already includes Tailwind CSS 4 and a lightly styled dashboard, but
its surrounding loading, connection, permission, error, and destructive-action
experiences are visually disconnected. Its single `busy` flag also presents
ordinary installation and teardown progress as recovery failure.

This change creates a cohesive light operational console using the existing
Tailwind toolchain. It introduces explicit lifecycle action states, shared
visual primitives, and an accessible teardown confirmation without adding a UI
framework or changing provisioning semantics.

## Goals

- Give every root and child view a consistent PostgreSQL manager identity.
- Clearly distinguish healthy progress, readiness, recovery, and fatal failure.
- Present each error once with one safe next action.
- Require confirmation before destructive teardown.
- Preserve and improve keyboard, focus, screen-reader, and reduced-motion
  behavior.
- Keep administrator and logical-database credentials out of rendered output.
- Work well at mobile and desktop widths.
- Resolve the React 19 ref lint failures in application and dialog rendering.

## Non-goals

- Dark mode, configurable themes, charts, navigation, or an activity history.
- A new component library, icon package, font download, or image asset.
- Displaying PostgreSQL credentials, connection strings, or runner output.
- Changing lifecycle, recovery, permission, or connection business rules.
- Typed destructive confirmation or multi-step installation wizards.
- Animations that are required to understand state.

## Visual Direction

The interface is a restrained light operational console:

- Slate page and panel surfaces establish hierarchy without visual noise.
- PostgreSQL blue and indigo identify the product and primary actions.
- Emerald communicates ready/success, amber communicates attention or
  recovery, and rose is reserved for failures and destructive actions.
- Rounded panels, quiet borders, compact shadows, and deliberate whitespace
  create depth.
- Standard system fonts remain in use.
- Small inline SVG icons may reinforce status, but never replace text.

Tailwind 4 utilities remain the primary styling mechanism. Global CSS is
limited to root sizing, base colors, font rendering, and shared focus behavior.
No Tailwind configuration file is required.

## Shared Presentation Components

Create small, single-purpose presentation units rather than expanding `App` or
duplicating long class strings:

- `ManagerShell` owns the page background, maximum width, product header, and
  responsive content region.
- `StatusPanel` owns semantic tone, icon treatment, title, description, and an
  optional action area.
- `ActionButton` provides primary, secondary, and danger variants with a common
  focus, disabled, and progress treatment.
- `ConfirmDialog` provides the teardown confirmation surface.
- A shared dialog-focus helper provides initial focus, focus trapping, Escape
  handling, and focus restoration for `ConfirmDialog` and `PermissionDialog`.

These components contain no provisioning logic. They receive text, tone, busy
state, and callbacks through explicit props.

## Application States

The application shell covers all root and child states:

- **Loading:** Identifies PostgreSQL and announces that manager state is being
  loaded.
- **Storage failure:** Explains that manager storage could not be initialized
  and offers Retry.
- **Not installed:** Summarizes the private persistent service and offers
  Install PostgreSQL.
- **Installing:** Announces installation progress and disables competing
  actions. It never uses recovery wording.
- **Ready:** Shows a Ready badge, non-secret resource ID, connection-approval
  state, and grouped management actions.
- **Tearing down:** Announces removal progress and disables competing actions.
  It never uses recovery wording.
- **Legacy:** Explains why teardown and reinstall are required.
- **Ambiguous:** Explains that multiple exact resources were found and offers
  only recovery retry.
- **Recovery required:** Explains that durable state is incomplete or an
  operation remains active and offers the appropriate retry action.
- **Teardown failed:** Offers Retry teardown rather than a generic recovery
  retry.
- **Connection preparation:** Uses the shell and a progress panel until it can
  close the child wire or request permission.

`App` tracks the active user action explicitly as `"install"`, `"teardown"`,
or `null`. `ManagerDashboard` uses that value instead of treating any `busy`
boolean as recovery. Boot recovery remains represented by the existing view
state and fixed errors.

Only the main state panel renders an error description. A duplicate alert
banner is not rendered above the same panel.

## Ready Dashboard

The ready view contains:

- Product/service identity and a prominent Ready badge.
- A concise statement that logical database connections can be created.
- The non-secret resource ID in a wrapping monospace treatment.
- The current installation-wide connection approval state.
- A secondary action to clear remembered approval when one exists.
- A visually separated danger zone containing Teardown PostgreSQL.

No administrative username, password, logical username, database name, host,
port, or connection string is displayed.

## Teardown Confirmation

Selecting Teardown PostgreSQL opens a modal dialog that states that the shared
PostgreSQL service and its logical databases will be removed. It does not
require typed confirmation.

The dialog requirements are:

- `role="dialog"`, `aria-modal="true"`, labelled title, and descriptive text.
- Initial focus inside the dialog.
- Tab and Shift+Tab focus trapping.
- Escape and Cancel close the dialog before submission.
- Focus returns to the teardown trigger after cancellation.
- Cancel uses the safer secondary emphasis; Confirm teardown is rose/danger.
- Confirmation becomes single-shot immediately, disables dismissal during the
  handoff, and transitions to the global Tearing down state.
- An already-active teardown cannot be submitted again.

## Permission Dialog

The existing permission semantics remain unchanged. The redesigned dialog:

- Clearly identifies the untrusted calling manager in a wrapping monospace
  block.
- Retains the explicit installation-wide consequence of remembering approval.
- Uses the shared dialog behavior and action buttons.
- Announces request progress and disables all controls while busy.
- Supports Escape only while cancellation is safe.
- Restores prior focus when dismissed.

The current render-time assignments to `busyRef.current` and
`cancelRef.current` are replaced with effect-safe callback/state handling. No
ref is read or mutated during render.

## Responsive and Accessible Behavior

- The application supports a minimum 320-pixel viewport without horizontal
  page overflow.
- Header, status details, and action groups stack at narrow widths and align
  horizontally when space allows.
- Long manager and resource IDs wrap instead of expanding their containers.
- Every icon has adjacent text or is hidden from assistive technology.
- Status changes use polite live regions; failures use alerts where immediate
  announcement is appropriate.
- Buttons expose visible focus, disabled state, and adequate touch targets.
- Motion is limited to optional color/opacity transitions and respects reduced
  motion preferences.
- Color is never the only indicator of meaning.

## Testing

### Dashboard and shell tests

- Assert the heading, status text, semantic role, and available action for every
  application state.
- Assert installing and tearing down never render recovery language.
- Assert a supplied error appears once.
- Assert active work disables competing actions.
- Assert long identifiers use a wrapping presentation class.
- Assert credential fixtures never appear in rendered output.

### Teardown confirmation tests

- Clicking teardown opens the confirmation and does not call teardown yet.
- Cancel and Escape dismiss without calling teardown.
- Confirm calls teardown exactly once.
- Focus starts inside, remains trapped, and returns to the trigger on cancel.
- Controls become unavailable after confirmation.

### Permission and connection tests

- Preserve all existing permission decision and wire-close behavior.
- Preserve focus trapping, Escape rules, and focus restoration.
- Assert the caller identity and installation-wide warning remain visible.
- Assert connection preparation uses the shared shell and a live status.

### Verification

- Run the complete Vitest suite.
- Run ESLint with zero warnings or errors.
- Run TypeScript and the Vite production build.
- Run `git diff --check`.
- Manually inspect narrow and desktop layouts, focus traversal, long IDs, and
  every major state.

## Acceptance Criteria

- The manager presents one coherent operational-console experience in root and
  child modes.
- Normal lifecycle progress is not described as recovery.
- Each error is presented once and provides the correct next action.
- Teardown cannot start without explicit confirmation.
- Both dialogs meet the specified keyboard and focus behavior.
- No secret-bearing state is rendered or logged.
- The interface remains usable at 320-pixel and desktop widths.
- No new UI runtime dependency or remote visual asset is introduced.
- All tests, ESLint, TypeScript, the production build, and
  `git diff --check` pass.
