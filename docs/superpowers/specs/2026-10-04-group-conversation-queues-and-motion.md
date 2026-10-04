# Group queues, conversational replies, and motion

## Goal

Make Group Activity and the room timeline feel clear and conversational while preserving work already in progress when users send follow-up messages.

## Decisions

### Work queues and user follow-ups

- Reuse the existing persisted `GroupTask` records and per-session FIFO of persisted `group_jobs`; do not add a second queue or queue table.
- A member has at most one running group turn. Additional task dispatches and user follow-ups remain queued for that member and run after its current turn settles.
- A user message routed by explicit mention, reply-to-author, or the default Lead/coordinator intake must be preserved and queued when that selected member is in a running Group turn. It must not cancel, steer, or replace the active prompt.
- FIFO follow-ups stay persisted as `group_jobs`; queueing one must not replace the execution identity bound to the currently running member turn. Bind an execution only when its wake starts, and restore the binding when a recovered wake starts. Cleanup must be guarded by a unique wake identity, since two queued wakes can share one execution ID.
- Keep existing handling for question-gated / `awaiting_user` members: a new message may supersede that stale gate and route a fresh wake. The new FIFO guarantee applies to running turns.
- Keep the existing global concurrency limit and task routing rules. Existing task-tool dispatches continue to validate task ownership, capabilities, dependencies, and authorization.
- When a member finishes its current work, it processes the queued user follow-up in FIFO order. A member that contributed to a shared task should provide a concise result; the Lead gives the user one consolidated response when several agents contributed.
- Explicit Stop/cancel behavior remains the way to interrupt work.
- A queued card must not receive the live tools/presence snapshot belonging to the running card for the same member. Resolve live-card ownership from the unfiltered transcript so execution/search filters cannot transfer live metadata to a visible queued card; keep it attached to the running/writing/awaiting card.

### Conversation style

- Match the user's language and sound like a capable, warm teammate: natural, direct, and concise.
- Default to one short paragraph or 1–3 sentences. Add detail when the user asks or the result requires it.
- Do not publish internal reasoning, tool narration, repetitive acknowledgements, or multiple cards for fragments of one thought.
- Give one concise public response per turn; send progress only when it communicates a separate handoff or result.
- After meaningful peer work, thank the teammate briefly and add specific feedback when it helps the next step. Avoid generic praise and numerical ratings; requested or required task reviews still use the existing Group review workflow.
- For coordinated work, specialists report their contribution briefly and the Lead avoids duplicate final summaries.
- Shared wake instructions and the coordinator snapshot must reinforce the same concise, natural style; neither should impose a fixed four-field response template.

### Activity checklist

- Render no checklist or empty-state placeholder while the group has no tasks.
- When tasks first become available, insert the checklist at the top of Activity.
- Reveal it with a short height expansion, fade, and upward-to-rest motion so the Activity sections below move down naturally.
- Respect `prefers-reduced-motion`.

### Message entry

- Newly appended message cards enter with a brief fade and upward motion.
- Do not animate the initially loaded transcript, older history added by pagination, or previously seen cards remounted by virtualization.
- Consume entry IDs outside virtualized row components so a card's entry animation is one-shot across remounts, filter changes, room navigation, and threshold changes.
- Respect `prefers-reduced-motion`.

## Constraints

- Keep persisted task state and queued job state as the source of truth.
- Do not change the task schema or add dependencies for this work.
- Preserve one running turn per member, the current global concurrency limit, task authorization, and queue recovery behavior.
- Keep Activity details below the checklist and retain the existing panel and message-card semantics.
