# Agent Profile Avatar Replacement Implementation Plan

> **For agentic workers:** Follow this plan with the project's TDD and verification skills. The approved design is in the conversation that requested this implementation.

**Goal:** Replace the Modus SVG avatar renderer with `@tryopenbot/agent-avatar` across every existing `AgentAvatar` use.

**Architecture:** Keep `AgentAvatar` as the stable adapter used by the renderer, mapping persisted colors, shapes, and states to the package. Preserve the existing profile data, contracts, database schema, and accessible label behavior; legacy faces remain stored but are no longer drawn.

**Tech Stack:** React 19, TypeScript, Vite/Electron, Vitest, npm workspaces, `@tryopenbot/agent-avatar@0.2.0`.

**Spec:** Approved in-chat design (current session).

## Global Constraints

- Add the dependency to `apps/desktop`, not the repository root.
- Do not change persisted profile/avatar fields, shared contracts, IPC, or database schema.
- Map all existing avatar colors using their current hex fill values; explicitly map all legacy shapes to supported package shapes.
- Keep `AgentAvatar` props and all current call sites compatible.
- Preserve accessible labels, decorative semantics, archived appearance, paused animation, and reduced-motion behavior.
- Follow TDD; validate the focused Vitest test, desktop typecheck, and desktop build.

---

### Task 1: Replace the shared avatar renderer

**Files:**
- Modify: `apps/desktop/package.json`
- Modify: `package-lock.json`
- Modify: `apps/desktop/src/renderer/src/features/agents/AgentAvatar.tsx`
- Modify: `apps/desktop/src/renderer/src/features/agents/agentAvatarModel.ts`
- Modify: `apps/desktop/src/renderer/src/features/agents/AgentAvatar.test.tsx`
- Inspect/modify only if required for package utility CSS: `apps/desktop/src/renderer/src/styles/app.css` and Tailwind/Vite configuration.

**Interfaces:**
- Preserve the existing exported `AgentAvatar` component and `AgentAvatarProps` call-site contract.
- Add a typed, exhaustive legacy-shape-to-package-shape mapping in `agentAvatarModel.ts`.
- Preserve legacy colors by passing `AGENT_AVATAR_FILL[color]`; use the archived fill for archived agents.
- Map `idle`, `working`, and `waiting` to package states; represent `archived` as gray and paused.
- Convert `animated={false}` to the package's `paused` prop. The package handles reduced motion itself; verify this behavior.

- [ ] **Step 1: Add the dependency**

Run `npm install --workspace @modus/desktop @tryopenbot/agent-avatar@0.2.0` from the repository root. Confirm only the desktop manifest and root lockfile change for dependency resolution.

- [ ] **Step 2: Write/update failing tests first**

In `AgentAvatar.test.tsx`, assert every Modus color passes its existing fill, every persisted shape maps to a recognized package shape, all four Modus states map correctly (including archived gray/paused), `animated={false}` pauses the package component, and accessible labels/decorative semantics remain intact. Remove assertions tied to the old hand-drawn facial SVG and CSS keyframes.

- [ ] **Step 3: Run the focused tests and observe expected failures**

Run `npm exec --workspace @modus/desktop -- vitest run --root ../.. apps/desktop/src/renderer/src/features/agents/AgentAvatar.test.tsx` from the repository root. Confirm the new adapter expectations fail before implementation.

- [ ] **Step 4: Implement the minimal adapter**

Replace the hand-drawn SVG implementation with the package component, preserving the existing wrapper API, class sizing, ARIA behavior, current color fills, explicit shape mapping, state/archived behavior, and paused animation. Remove obsolete avatar-only CSS only if no remaining call sites use it. Ensure the package's utility styles are included in the renderer build if necessary.

- [ ] **Step 5: Run focused tests, desktop typecheck, and desktop build**

Run `npm exec --workspace @modus/desktop -- vitest run --root ../.. apps/desktop/src/renderer/src/features/agents/AgentAvatar.test.tsx`, `npm --workspace @modus/desktop run typecheck`, and `npm --workspace @modus/desktop run build` from the repository root. Resolve failures without changing contracts or persisted data.
