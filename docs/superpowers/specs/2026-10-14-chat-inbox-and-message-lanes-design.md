# Chats Inbox and Message Lanes

**Status:** Revised after review and approved in chat on 2026-10-15; implementation follows the plan.

## Goal

Keep assistant and user message cards in separate horizontal lanes, make those cards more vertically compact, and present workspace-less conversations in a dedicated Chats section instead of under Projects.

## Current Context

- The app already represents workspace-less conversations with the stable inbox workspace ID `CHATS_WORKSPACE_ID` and the `workspace.inbox` flag. Selecting an inbox session already clears the active project; this design does not introduce another persistence model.
- The sidebar currently renders every workspace in Projects, including the inbox workspace. Pins are rendered separately before Projects.
- `MessageBlock` renders user and assistant rows at full available width. Technical assistant output can force its bubble to `width: 100%`, and chat bubbles currently use `12px 16px` padding.

## Decisions

### 1. Sidebar organization

In the expanded sidebar, render `Chats` and `Projects` as sibling first-level disclosure sections in the same content list, below the global actions and Pins. Remove the standalone `Projects` nav row from `AppSidebar` so there is one `Projects` heading, at the same visual level as `Chats`. Each section controls its own list, both may remain expanded at once, and Chats appears before Projects. Keep the existing `direct-messages` destination; do not add a new `PrimaryDestination`, route, IPC endpoint, or persisted navigation model.

- `Chats` lists sessions from the stable inbox workspace (`workspace.inbox` / `CHATS_WORKSPACE_ID`), never by display-name matching or by treating every missing workspace as an inbox chat.
- `Projects` lists non-inbox workspaces and retains the existing workspace/session grouping. Sessions whose project is unavailable remain in the existing unavailable-project handling; they are not reclassified as Chats.
- Use independent UI expansion state for Chats and Projects, so expanding/collapsing one never changes the other. Preserve the collapsed-sidebar/hover behavior and provide a clear expanded affordance for each.
- Keep `Pinned` as a single global section, independent of either list, with no duplicate pinned sessions in Chats or Projects.
- Keep the `Open workspace` action on the Projects disclosure. Keep `New message` as the existing global action, which creates an inbox chat.
- Preserve inbox chat selection, active state, ordering, rename, pin/unpin, archive/restore, delete, and archived-chat access. Selecting an inbox session must retain the existing behavior of clearing the active project.
- Keep the Chats section wrapper a valid drag/drop workspace target by stable inbox ID even when its list is empty or collapsed, so project or pinned sessions can still be moved into the inbox.
- Opening Archived chats from collapsed Chats expands the section and exposes archived sessions; its control reports expanded state accessibly. Chats must not expose project-only actions such as rename/reveal/remove project.

### 2. Message-card layout

Use role-specific lanes within the conversation content width: assistant messages on the left, user messages on the right, with a central gutter. The combined avatar-plus-card content for each role must stay within its lane; no assistant card or nested technical content may extend into the user's lane, and vice versa.

- Keep the assistant avatar before its card and the user avatar after its card.
- Limit the card itself after accounting for its avatar and row gap, so the entire row—not only the bubble—fits its half of the conversation canvas.
- Remove or scope the existing full-width technical-output override so `pre`, code blocks, tables, and other structured content remain inside the message card. Long code and tables may scroll horizontally inside the card; they must not widen the card or create page-level overflow.
- Put horizontal scrolling on the inner table/code viewport, not on an outer wrapper that contains Streamdown's absolutely positioned copy/export menu. The menu must remain visible and operable while the table is scrolled.
- Reduce only the card's vertical padding from `12px` to `8px`; retain `16px` horizontal padding and existing inter-message spacing.
- At narrow widths, reduce the central gutter but retain separate role lanes. Text wraps; long technical content scrolls within its card.

## Alternatives Considered

- **Separate Chats route or persisted model:** rejected. The inbox already exists as a special workspace; sibling disclosures expose it without changing application routing or persistence.
- **Chats nested below the existing Projects nav row:** rejected. It does not make the two lists peers in the visible sidebar hierarchy.
- **A shared maximum bubble width without role lanes:** rejected. It does not guarantee that wide assistant/technical cards stay out of the user's side.

## Data Flow and Boundaries

The renderer separates the existing workspace and session collections using the inbox identity already supplied by the main process. It reuses the current selection and session-action callbacks and adds only renderer UI state for the two independent disclosure states. No database schema, shared contracts, IPC, release metadata, or workspace/session persistence changes are in scope.

For messages, role identity determines the lane in `MessageBlock`; nested Markdown/technical content is constrained by that lane. Existing message content, code/table rendering, avatars, editing, and compact preview behavior remain intact.

## Acceptance Criteria

1. Chats and Projects have peer first-level sidebar controls; each list expands/collapses independently, and both can remain open.
2. Inbox chats appear only in Chats; non-inbox workspace chats and unavailable-project sessions remain under Projects; neither list duplicates pinned chats.
3. Chats accepts a drop target with an empty/collapsed list. Archived inbox chats can be opened/restored from a collapsed Chats section, and project-only actions are absent there.
4. Selecting, renaming, pinning, archiving/restoring, and deleting inbox chats continues through existing handlers and preserves session IDs/state.
5. Assistant and user rows occupy separate lanes at desktop and narrow widths, including avatars; cards do not overflow into the opposite lane.
6. Code blocks/tables stay within their card and scroll internally as needed, while the Markdown/CSV/TSV table menu remains visible and operable.
7. Chat-card vertical padding is `8px`; horizontal padding remains `16px`; inter-message spacing is unchanged.
8. The app requires no migration and preserves current workspace and chat behavior outside the inbox presentation.

## Verification

- Extend `MessageBlock.cards.test.tsx` and real computed-style tests to cover role lanes, compact vertical padding, genuinely wide technical content, internal scrolling, table-menu visibility, and narrow-layout rules.
- Extend `Sidebar.navigation.test.tsx` (which exercises `AppSidebar` and `Sidebar` together) to verify peer disclosures, independent expansion, inbox-only Chats contents, Projects exclusion, global pins, empty/collapsed drop target, archived-chat access, and session operations.
- Run the focused tests, desktop typecheck, desktop build, and the full project test command; inspect the changed views at desktop and narrow widths.
