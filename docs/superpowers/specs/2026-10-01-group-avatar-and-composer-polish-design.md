# Group Avatar and Composer Polish

**Status:** User reviewed and approved for planning
**Date:** 2026-10-01

## Problem

The Groups room header shows small, soft-looking agent avatars and plain status dots. A group can contain up to ten agents, so the header needs ten distinct geometric silhouettes that keep each agent recognizable in every place that agent appears. The Groups composer also uses the orange accent where the user expects the purple Modus brand, and its focus state adds a purple border the user has rejected. Message cards expose opaque execution IDs such as `#62c2…` that do not help the conversation.

## Goals

- Render ten clear, distinct vector avatar shapes and preserve one shape per agent throughout the app.
- Keep all ten group members visible and show the agent name on hover.
- Give each presence dot a clear, accessible activity meaning and motion only for active states.
- Match Groups composer actions to the Modus purple logo while keeping the composer focus treatment neutral.
- Hide raw execution IDs from message cards while retaining execution filtering.
- Keep runtime behavior, message contents, and execution identity unchanged.

## Non-goals

- Changing Group Runtime, execution ordering, or message persistence.
- Replacing the existing avatar editor or morphing popover.
- Adding a component dependency; the status-dot reference informs the local implementation.
- Changing avatar faces, palette choices, or other application surfaces beyond keeping the same stored shape wherever an agent avatar is rendered.

## Approved design decisions

1. The avatar shape is a persistent identity property. The same agent keeps the same geometric silhouette in the room header, message rows, group pickers, and agent editor.
2. A group has at most ten agents and has ten available silhouettes. Each group uses each silhouette at most once.
3. Existing shape assignments are preserved where they are already unique. The migration resolves only collisions, in stable membership order, by assigning the first unused shape.
4. New group agents receive an unused shape. The agent editor disables shapes used by other members, while the main-process store and SQLite uniqueness constraint enforce the rule for all callers.
5. The two new silhouettes are `triangle` and `pentagon`, bringing the shared shape list to ten.
6. Presence dots represent `idle`, `queued`, `working`, `waiting`, and `archived`. Working and waiting use restrained status-dot motion; idle and queued are static. Archived members remain visibly inactive.
7. Execution IDs are removed from message-card text. A small, labeled filter control preserves the existing ability to filter by execution.

## Architecture and data lifecycle

### Shared avatar model

Extend `AGENT_AVATAR_SHAPES` and the `AgentAvatarShape` contract with `triangle` and `pentagon`. Draw both in the existing SVG `AgentAvatar` using the same 48×48 vector coordinate system as the current silhouettes. Keep the shared avatar component as the only renderer for these shapes so all surfaces stay visually consistent.

Add a shared shape-allocation helper that accepts the group's current members and a preferred shape. It keeps the preferred shape when available and otherwise picks the first unused shape. Creation paths that add several members allocate sequentially; editing paths may choose any free shape. Ungrouped legacy agents retain their existing shape and are not subject to a group uniqueness rule.

### SQLite migration and enforcement

The `agents.avatar_shape` column has a SQLite `CHECK` constraint generated from the shared shape list. Rebuild the `agents` table transactionally so existing databases accept the two new values and grouped shapes are unique. Preserve foreign keys and existing agent fields. Before copying rows, resolve duplicate shapes per group in `agent_group_members.joined_at` order, with stable row/id tie-breakers; keep the first occurrence of each shape and assign an unused shape to each collision. Preserve all existing face, color, name, role, model, and timestamp values.

After the migration has normalized existing rows, add a unique index for `(group_id, avatar_shape)`. SQLite permits repeated values when `group_id` is `NULL`, so this does not impose a new policy on ungrouped legacy agents. Install the index in this migration rather than in the shared table body: older migration steps rebuild the agents table before this normalization runs. Keep the migration idempotent and validate it with both an existing-schema fixture and foreign-key checks.

The main-process create and update paths must enforce uniqueness before writing and translate collisions into a typed validation error. The database constraint remains the final guard. Group additions allocate a free shape even when a template's deterministic default is already used. When editing an existing group member, the shape picker receives the other members' shapes and disables those options; the current shape remains selectable. The new-group draft picker applies the same rule to shapes already assigned to draft members, and the create-group path allocates any remaining shapes before inserting the members.

### Group presence and status

Render the header row with all members at the current 24 px avatar size so the toolbar density stays unchanged. Refine the SVG geometry and edge treatment for clearer silhouettes without enlarging the avatars. Keep the stored shape, face, and color unchanged. Keep the existing morphing editor trigger and expose the member name in the hover tooltip and accessible label.

Replace the unlabelled status span with a local status-dot component inspired by the supplied 21st.dev reference. Place it below each avatar, remove the dark outline, and provide a visible tooltip plus screen-reader label for every state. Map the existing runtime member state to `working` and `waiting`; expose queued sessions as `queued`; archived members show `archived`. Animate only active states and honor `prefers-reduced-motion`.

### Composer and message metadata

Use the Modus logo purple semantic color for the Groups composer send action, selected execution-mode controls, and kickoff insert action that currently use orange accent styling. Remove the purple `focus-within` border and glow. Keep a subtle neutral focus indication and the existing keyboard-accessible focus on controls.

In `GroupMessageRow`, replace the visible execution-ID chip text with a small filter icon button with an accessible name and title. Keep its click handler wired to the same execution ID and retain timestamps and human-readable execution status.

## Validation and acceptance criteria

1. Avatar rendering tests cover all ten SVG silhouettes at compact and room-header sizes.
2. Shared allocation tests prove all ten members of a group get different shapes, requested unique shapes are preserved, duplicate preferred shapes get a free fallback, and a removed member's shape becomes available.
3. Database migration tests prove old duplicate assignments are normalized deterministically, unrelated agent fields are preserved, SQLite rejects a duplicate grouped shape, ungrouped duplicates remain allowed, and foreign keys remain valid.
4. Agent-store and IPC tests prove group creation, member addition, and updates preserve uniqueness; existing-group and new-group draft shape pickers prove occupied options are disabled and the current option remains enabled.
5. Group presence tests cover all ten members, unique `data-shape` values, agent-name tooltip/labels, every status mapping, and reduced-motion behavior.
6. Composer regression tests prove action buttons use the purple semantic token and focus does not add a purple border or glow.
7. Message-row regression tests prove no raw `#execution-id` text is shown while the accessible filter button still filters the correct execution.
8. Run focused tests, the desktop typecheck, Biome, and the relevant app build before updating the existing PR.

## External reference

- [21st.dev Status Dot](https://21st.dev/@edwinvakayil/components/status-dot) — reference for compact status indicators, state presets, and restrained pulse motion.
