# N5 — Clean room chrome + avatar identity

**Repo:** Stoltembergg/modus  
**Depends on:** N0–N2 on main; N3 (#94) optional parallel  
**Status:** Implemented on `cursor/natural-groups-n5-agents-ui-cb29`  
**Constraint:** Agents / Groups / Lead / Coordinator / models / permissions stay intact — presentation only.

## Goals

1. **No permanent agent lists** in sidebar or room header — only Group name, project badge, discrete activity, Stop/Activity/menu.
2. **Single “Agents” control** in the room header → anchored popover with members (Lead, status, role) + config actions (open 1:1, edit, lead, remove).
3. **Morphing Dialog** (Motion Primitives pattern) when editing: avatar/card expands to full form and morphs back on close.
4. **Avatar redesign:** shapes (circle, squircle, rounded-square, hexagon, capsule, blob, …), expanded palette with FG/BG contrast pairs, face/shape/color chosen separately, deterministic defaults, live animated preview; states idle/working/waiting/archived preserved.
5. Small avatars only in message authorship + live working strip — not duplicated in chrome.

## Approach

- Sidebar: stop nesting `MemberRow` under groups (collapse affordance becomes select-group only).
- Header: replace chip row with `Agents` popover + optional tiny activity dots (count of working/waiting).
- `MorphingDialog` local component under `components/ui` using `motion/react` `layoutId`.
- Schema: add `avatar_shape`; expand `avatar_color` CHECK via agents table rebuild; `agentAvatarForId` returns face+shape+color.

## Non-goals

- Changing wake/routing (N3/N4).
- Removing 1:1 chat capability.
- Reworking CreateGroupDialog multi-member flow beyond avatar pickers.
