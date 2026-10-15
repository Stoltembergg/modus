# Chats Inbox and Message Lanes Implementation Plan

> **For implementers:** Follow the orchestrator's specialist scheduler. @designer owns the UI implementation. Use test-driven-development and verification-before-completion; do not change persistence or IPC.

**Goal:** Keep assistant and user message cards in separate, non-overlapping lanes with tighter vertical padding, and list inbox chats in a dedicated Chats section beside Projects.

**Architecture:** Keep message width and overflow rules in the existing renderer message components/styles. Split the existing workspace list using the stable inbox identity already in the shared contract; reuse the existing session handlers and persistence, with no new route or data model.

**Tech Stack:** React, TypeScript, Tailwind v4, Vitest, Electron/Vite.

**Spec:** `docs/superpowers/specs/2026-10-14-chat-inbox-and-message-lanes-design.md`

## Global Constraints

- Chats and Projects are peer, first-level disclosures in the sidebar content; remove the standalone Projects nav row from `AppSidebar` so the sidebar shows one Projects heading.
- Keep the current `direct-messages` primary destination; do not add route, IPC, or persisted navigation state.
- Keep separate Chats and Projects expansion state; both lists may be open together and their states survive toggling Settings.
- Identify Chats only through `workspace.inbox` / `CHATS_WORKSPACE_ID`, not workspace display names or missing workspace references.
- Keep Pinned global and ensure a session appears in only one list.
- Preserve session selection, ordering, rename, pin/unpin, archive/restore, delete, and active-project clearing for inbox chats.
- Keep the Chats section as a valid drag/drop workspace target when empty or collapsed; opening Archived chats expands it and reports `aria-expanded`.
- Keep assistant and user rows within separate half-width lanes, including their avatars; technical content cannot widen a lane.
- Keep the Streamdown table copy/export menu visible: horizontal overflow belongs on the inner table scroller, not its menu-containing wrapper.
- Set chat-card vertical padding to `8px`; preserve `16px` horizontal padding and existing inter-message spacing.
- No database, shared-contract, IPC, or primary-route changes.

---

### Task 1: Constrain message cards to role lanes

**Files:**
- Modify: `apps/desktop/src/renderer/src/features/agent/MessageBlock.tsx`
- Modify: `apps/desktop/src/renderer/src/styles/app.css`
- Test: `apps/desktop/src/renderer/src/features/agent/MessageBlock.cards.test.tsx`
- Test: `apps/desktop/src/renderer/src/styles/glassComputedStyle.test.ts`

**Interfaces:**
- Preserve `MessageBlock` props and the `data-message-role` markers consumed by tests/styles.
- Keep `data-message-row="assistant"` and add the corresponding `data-message-row="user"` marker to the user row.
- Assistant row stays left-aligned with its avatar; user row stays right-aligned with its badge.
- Each role's combined avatar, gap, and card fits its lane. Nested `pre`, code blocks, and tables remain within the card and may scroll internally.

- [ ] **Step 1: Add failing layout and density assertions**

Extend `MessageBlock.cards.test.tsx` with assistant/user rows containing long content and a genuinely wide Markdown table. Open the real copy/export menu and assert it remains visible and actionable while the table scrolls. In `glassComputedStyle.test.ts`, add 600px and 360px fixtures and expose `paddingTop`, `paddingBottom`, `paddingLeft`, and `paddingRight` in the existing `Probe`/`MEASURE` values. Measure the real rendered card/avatar edges and assert the role split and padding:

```ts
const split = main.innerLeft + main.innerWidth / 2;
const assistant = m["[data-assistant-card]"] as Probe;
const technical = m["[data-technical-card]"] as Probe;
const user = m["[data-message-card]"] as Probe;
const assistantAvatar = m["[data-assistant-avatar]"] as Probe;
const userAvatar = m["[data-user-avatar]"] as Probe;

expect(assistantAvatar.left).toBeCloseTo(main.innerLeft, 0);
expect(assistant.right).toBeLessThanOrEqual(split);
expect(technical.right).toBeLessThanOrEqual(split);
expect(user.left).toBeGreaterThanOrEqual(split);
expect(userAvatar.right).toBeCloseTo(main.innerRight, 0);
expect(user.left - assistant.right).toBeGreaterThanOrEqual(8);
expect(assistant.paddingTop).toBe(8);
expect(assistant.paddingBottom).toBe(8);
expect(assistant.paddingLeft).toBe(16);
```

Keep the user avatar at the right edge and the assistant avatar at the left edge in both viewport widths.

- [ ] **Step 2: Run the focused tests and confirm the new assertions fail**

Run from the repository root:

```bash
npm exec --workspace @modus/desktop -- vitest run --root ../.. apps/desktop/src/renderer/src/features/agent/MessageBlock.cards.test.tsx apps/desktop/src/renderer/src/styles/glassComputedStyle.test.ts --maxWorkers=2
```

Expected: the table-menu regression fails because the current outer wrapper scrolls/clips Streamdown's absolute copy/export menu; the role-lane and padding assertions remain green.

- [ ] **Step 3: Implement role-lane sizing and compact vertical padding**

Constrain the entire assistant row (avatar plus bubble) to the left lane and the user row (bubble plus badge) to the right lane. Use `min-width: 0` at flex/grid boundaries, scope the technical-content width rule to the lane, and add internal horizontal scrolling for long code/tables. Keep the table wrapper overflow visible for its absolute toolbar; let only the inner frame that contains the actual table scroll horizontally. Change only vertical bubble padding from `12px` to `8px`.

- [ ] **Step 4: Run the focused tests and desktop typecheck**

Run the focused test command from Step 2, then:

```bash
npm --workspace @modus/desktop run typecheck
```

Expected: the focused layout/style assertions and desktop typecheck pass.

### Task 2: Move inbox chats into their own sidebar section

**Files:**
- Modify: `apps/desktop/src/renderer/src/app/App.tsx`
- Modify: `apps/desktop/src/renderer/src/components/shell/AppSidebar.tsx`
- Modify: `apps/desktop/src/renderer/src/components/Sidebar.tsx`
- Test: `apps/desktop/src/renderer/src/components/Sidebar.navigation.test.tsx`

**Interfaces:**
- Reuse `CHATS_WORKSPACE_ID`, `workspace.inbox`, and existing `onSelectSession`/session-action handlers.
- Render Chats and Projects as peer `SectionHeader` disclosures in `Sidebar`; remove the old Projects link from `AppSidebar` so there is one Projects heading.
- Preserve independent Chats/Projects expansion state across sidebar/settings visibility in renderer state, without adding `PrimaryDestination` or persisted state.
- Chats renders unpinned inbox sessions; Projects renders non-inbox workspaces plus the existing unavailable-project fallback.
- Pinned items remain in their current global slot and are not duplicated in either section.
- Expose the Chats list as `data-testid="sidebar-chats"`; keep Projects at `data-testid="sidebar-projects"` for integration tests.
- Mark the Chats wrapper with the inbox `data-workspace-drop` target even when the list is empty or collapsed.
- Clicking Archived chats expands Chats, updates the accessible expanded state, and shows archived session rows without project-only actions.
- Keep the pin slot before both disclosures; move the `Open workspace` action to the Projects section header.

- [ ] **Step 1: Add failing navigation tests**

Extend `Sidebar.navigation.test.tsx` (the integration fixture renders `AppSidebar` and `Sidebar`) with a `WorkspaceInfo` fixture whose `id` is `CHATS_WORKSPACE_ID` and `inbox` is `true`, plus sessions from both inbox and normal projects. Assert sibling section headers, the Projects header is inside its list rather than a standalone AppSidebar row, independent expansion, inbox sessions only beneath Chats, project/unavailable sessions only beneath Projects, global pins without duplication, a drop target on empty/collapsed Chats, and existing session/archived handlers:

```tsx
const chats = screen.getByTestId("sidebar-chats");
const projects = screen.getByTestId("sidebar-projects");
expect(within(chats).getByText("Inbox chat")).toBeTruthy();
expect(within(projects).queryByText("Inbox chat")).toBeNull();
expect(screen.getAllByText("Inbox chat")).toHaveLength(1);
```

- [ ] **Step 2: Run the focused navigation test and confirm it fails**

Run from the repository root:

```bash
npm exec --workspace @modus/desktop -- vitest run --root ../.. apps/desktop/src/renderer/src/components/Sidebar.navigation.test.tsx --maxWorkers=2
```

Expected: assertions fail because the current Projects disclosure is still in AppSidebar, the Chats wrapper is not a drop target when empty/collapsed, and opening Archived chats does not expand a collapsed Chats section.

- [ ] **Step 3: Split the inbox presentation from Projects**

Partition the supplied workspace collection by the stable inbox flag/ID. Move the Projects disclosure into the same sidebar content list as Chats and remove its duplicate standalone link from `AppSidebar`. Preserve Projects expansion in `App` and add independent Chats expansion there so both survive Settings unmounts. Render inbox sessions in a dedicated Chats section with the existing session actions and archived-chat access; preserve the global pinned slot. Add the inbox `data-workspace-drop` target around the Chats header/content even when empty/collapsed, and make Archived chats open Chats and expose its `aria-expanded` state. Leave unavailable non-inbox sessions in Projects.

- [ ] **Step 4: Run the focused navigation tests**

Run the focused command from Step 2. Expected: peer section hierarchy, independent expansion, inbox/project exclusivity, drop target, archived access, pinning, and action-preservation tests pass.

### Task 3: Verify integrated desktop behavior

**Files:** No additional files unless a failing verification identifies a scoped regression.

- [ ] **Step 1: Run the relevant test set**

```bash
npm exec --workspace @modus/desktop -- vitest run --root ../.. apps/desktop/src/renderer/src/features/agent/MessageBlock.cards.test.tsx apps/desktop/src/renderer/src/styles/glassComputedStyle.test.ts apps/desktop/src/renderer/src/components/Sidebar.navigation.test.tsx --maxWorkers=2
```

- [ ] **Step 2: Run the desktop typecheck and production build**

```bash
npm --workspace @modus/desktop run typecheck
npm --workspace @modus/desktop run build
```

- [ ] **Step 3: Run the project test command and inspect the desktop/narrow layouts**

```bash
npm test
```

Confirm the message cards stay in separate role lanes, technical content does not create horizontal overflow, the compact padding is visible, Chats contains only inbox conversations, and Projects retains workspace grouping. Record any unrelated platform-only test failures separately rather than changing unrelated behavior.
