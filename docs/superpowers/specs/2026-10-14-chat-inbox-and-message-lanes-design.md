# Chats Inbox and Message Lanes

**Status:** Design approved in chat; implementation is not yet approved.

## Goal

Keep assistant and user message cards in separate horizontal lanes, make those cards more vertically compact, and present workspace-less conversations in a dedicated Chats section instead of under Projects.

## Current Context

- The app already represents workspace-less conversations with the stable inbox workspace ID `CHATS_WORKSPACE_ID` and the `workspace.inbox` flag. Selecting an inbox session already clears the active project; this design does not introduce another persistence model.
- The sidebar currently renders every workspace in Projects, including the inbox workspace. Pins are rendered separately before Projects.
- `MessageBlock` renders user and assistant rows at full available width. Technical assistant output can force its bubble to `width: 100%`, and chat bubbles currently use `12px 16px` padding.

## Decisions

### 1. Sidebar organization

Use sibling, independently collapsible `Chats` and `Projects` sections in the existing sidebar context. Do not add a new primary destination, route, IPC endpoint, or persisted navigation model.

- `Chats` lists sessions from the stable inbox workspace (`workspace.inbox` / `CHATS_WORKSPACE_ID`), never by display-name matching or by treating every missing workspace as an inbox chat.
- `Projects` lists non-inbox workspaces and retains the existing workspace/session grouping. Sessions whose project is unavailable remain in the existing unavailable-project handling; they are not reclassified as Chats.
- Keep `Pinned` as a single global section, independent of either list, with no duplicate pinned sessions in Chats or Projects.
- Keep the `Open workspace` action on Projects. Keep `New message` as the existing global action, which creates an inbox chat.
- Preserve inbox chat selection, active state, ordering, rename, pin/unpin, archive/restore, delete, and archived-chat access. Selecting an inbox session must retain the existing behavior of clearing the active project.

### 2. Message-card layout

Use role-specific lanes within the conversation content width: assistant messages on the left, user messages on the right, with a central gutter. The combined avatar-plus-card content for each role must stay within its lane; no assistant card or nested technical content may extend into the user's lane, and vice versa.

- Keep the assistant avatar before its card and the user avatar after its card.
- Limit the card itself after accounting for its avatar and row gap, so the entire row—not only the bubble—fits its half of the conversation canvas.
- Remove or scope the existing full-width technical-output override so `pre`, code blocks, tables, and other structured content remain inside the message card. Long code and tables may scroll horizontally inside the card; they must not widen the card or create page-level overflow.
- Reduce only the card's vertical padding from `12px` to `8px`; retain `16px` horizontal padding and existing inter-message spacing.
- At narrow widths, reduce the central gutter but retain separate role lanes. Text wraps; long technical content scrolls within its card.

## Alternatives Considered

- **Separate top-level Chats route:** rejected. The inbox already exists as a special workspace and the requested placement is a sibling sidebar section; adding route state would expand navigation unnecessarily.
- **A shared maximum bubble width without role lanes:** rejected. It does not guarantee that wide assistant/technical cards stay out of the user's side.

## Data Flow and Boundaries

The renderer separates the existing workspace and session collections using the inbox identity already supplied by the main process. It reuses the current selection and session-action callbacks. No database schema, shared contracts, IPC, release metadata, or workspace/session persistence changes are in scope.

For messages, role identity determines the lane in `MessageBlock`; nested Markdown/technical content is constrained by that lane. Existing message content, code/table rendering, avatars, editing, and compact preview behavior remain intact.

## Acceptance Criteria

1. Inbox chats appear only in Chats; non-inbox workspace chats remain grouped under Projects; neither list duplicates pinned chats.
2. Selecting, renaming, pinning, archiving/restoring, and deleting inbox chats continues through existing handlers and preserves session IDs/state.
3. Assistant and user rows occupy separate lanes at desktop and narrow widths, including rows with avatars; cards do not overflow into the opposite lane.
4. Code blocks and tables remain within their card and use internal horizontal scrolling when needed.
5. Chat-card vertical padding is `8px`; horizontal padding remains `16px`; inter-message spacing is unchanged.
6. The app requires no migration and preserves current workspace and chat behavior outside the inbox presentation.

## Verification

- Extend `MessageBlock.cards.test.tsx` and the existing style/computed-style tests to cover role lanes, compact vertical padding, technical-content containment, and narrow-layout rules.
- Extend `Sidebar.navigation.test.tsx` to verify inbox-only Chats contents, Projects exclusion, no duplicates, and preservation of pinned and session operations.
- Run the focused tests, desktop typecheck, desktop build, and the full project test command; inspect the changed views at desktop and narrow widths.
