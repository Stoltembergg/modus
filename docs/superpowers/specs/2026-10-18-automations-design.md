# Modus Automations — initial local design

Status: proposed for written-spec review. No product implementation authorized by this document alone.

## Intent and agreed scope

Let the user schedule prompts for the existing Modus agent runtime. The user requested
an Automations destination immediately above Settings, a minimal list of existing
automations, and a detail page showing the task and its execution history.

The initial release executes only while Modus is open, including a minimized window.
It introduces no daemon, cloud executor, login-item installation, or OS task scheduling.
Closing Modus stops admission of scheduled work. A suspended computer cannot execute work.

Keep the existing transparent surfaces, restrained typography, reduced-motion support,
sidebar pin/hover behavior, and supported application languages. Do not add dashboards,
technical metrics, nested cards, or new information to the Composer.

## Architecture choice

Use a host-owned scheduler in the Electron main process, persisted in the existing SQLite
database. It calls the existing AgentRuntime and observes its lifecycle events. Renderer
reloads or navigation do not own scheduling or execution state.

A calendar/cron package driving the same host service is a possible implementation detail;
it does not replace durable occurrence records. Delegating execution to OS schedulers would
add platform installation and lifecycle work without serving the agreed open-app scope.
Do not build a second Harness, model controller, or generic job framework.

Existing integration points:

- Navigation: `components/shell/AppSidebar.tsx`, `navigation-state.ts`, and `app/App.tsx`.
- Persistence and migrations: `src/main/db/database.ts` and existing store conventions.
- Runtime: `AgentRuntime.create`, `prompt`, `abort`, `onTurnSettled`, `onQuestionPending`.
- Notifications: the existing agent notification mechanism and conversation navigation.
- Startup/shutdown: `src/main/index.ts` and its bounded runtime shutdown.

Paths above are relative to `apps/desktop/src/renderer/src` for navigation, and to
`apps/desktop` for main-process paths.

The current runtime takes a BrowserWindow. Reuse the current, live application window,
including when minimized. Do not construct hidden windows or refactor the Harness into a
separate background runtime. On macOS, closing the last window pauses admission even if
the application process remains alive; opening the window resumes scheduling.
Closing the last window also cancels automation-owned sessions through the existing
runtime, so no execution continues with a destroyed interaction/approval owner.

## Minimal user experience

Automations is a primary destination directly above Settings, with an icon in the collapsed
rail. Selecting it opens a full content page and preserves the normal sidebar interaction.

The list contains a name, human-readable schedule, and enabled/paused state per row. A `+`
action opens creation. A single short empty-state action is sufficient.

Selecting a row opens its detail page in the same content area, with Back navigation:

- Name and task instruction.
- Schedule, next execution, selected project and Agent/model.
- Pause/resume and Run now; edit and delete in a discrete overflow menu.
- Execution history: date, outcome, and a link to its conversation when one exists.

The editor captures a name, instruction, existing project, explicitly selected Agent/model,
schedule and timezone. Initially support one-time, daily, and weekly schedules. Display
ordinary local dates and times rather than requiring cron expressions.

Creating through chat uses the same validated host service and a compact confirmation
containing the instruction, project, effective model, schedule and timezone before saving.
Treat the Agent's proposed arguments as untrusted input. The chat tool cannot enable a new
recurring task, change an existing task, or run one without the corresponding user action.
The list/editor path remains usable without making an inference call.

## Persistence and execution

Store the automation definition, enabled state, IANA timezone, calendar schedule,
next scheduled instant, revision, selected project/working directory, Agent identity,
effective model/provider choice, thinking configuration and timestamps.

Store execution records separately: automation revision, scheduled occurrence or manual
trigger ID, timestamps, session/run linkage, result and bounded error information. Snapshot
the execution configuration so later edits do not rewrite history. Use the existing session
and event stores for conversation contents instead of copying transcripts into another store.

Each execution creates its own normal agent conversation through the established session
creation flow. Keep it associated with its project and available through execution history.
Do not append scheduled prompts to a user's active chat or automatically pin result sessions.

Persist and claim each scheduled occurrence transactionally with a unique occurrence key
before invoking the runtime. Start with at most one active automation execution globally;
normal user chats retain their existing concurrency behavior. Run now also respects this
limit and reports busy rather than silently queueing repeated requests.

Recheck enabled state and revision before admission. A later occurrence that arrives while
an automation execution occupies the slot is recorded as skipped, without backlog replay.
Pausing prevents new starts; an active execution keeps a separate Stop action. Deleting an
active automation is blocked until it settles. Edits apply only to future executions.
Deleting a settled definition hides it from the active list while retaining execution
history and linked conversations; it does not cascade-delete session evidence.

## Calendar, interruption and recovery

Calculate daily and weekly occurrences in the saved IANA timezone using calendar semantics,
not 24-hour intervals. A nonexistent daylight-saving local time is skipped; an ambiguous
local time runs only at its first occurrence. Editing the timezone is explicit.

At startup, window reopening, or wake from sleep, record a compact missed-interval entry for
overdue occurrences and advance to the next future occurrence. Do not infer that a missed
task ran, and do not replay overdue work automatically. A missed one-time task needs an
explicit Run now or reschedule action. Clock adjustments must not duplicate a claimed occurrence.

On shutdown, stop the scheduler, prevent new claims and cancel owned runtime sessions
through the existing shutdown flow. On restart, reconcile unresolved execution records as
interrupted; do not retry them automatically because external effects may already exist.
Durable occurrence claims prevent duplicate admission, not exactly-once external effects.

## Runtime guarantees and resource policy

Use the same Harness, tool dispatcher, approvals, permissions and Verifier-First behavior as
normal conversations. User interaction requests remain visible in the existing conversation;
the history state becomes Waiting for you. An unattended task never grants itself approval.

Pin the model/provider selected at creation or an explicit edit. If it becomes unavailable,
fail that execution with an actionable result instead of choosing another model. Validate
the project and Agent availability at admission, and never substitute another working directory.

Apply a ten-minute automation deadline, including time waiting for user interaction. On expiry,
request runtime cancellation and retain the concurrency slot until termination is confirmed.
Record success/failure/cancellation from actual runtime settlement; a timer firing is not
proof of termination. If cleanup cannot be confirmed, deny further automation admission
until reconciliation. Preserve existing runtime limits; do not claim a new hard financial cap.

Reuse completion, failure and permission notifications, avoiding duplicates from a second
notification publisher. Clicking a notification or execution opens the associated conversation.
Keep content and credentials out of generic logs; expose user-facing errors through existing
error handling and access controls.

## Acceptance evidence

Use deterministic clocks and synthetic runtime fixtures for scheduling and failure coverage,
plus an integration test through the real runtime entry points with provider transport mocked.
No paid model calls or real external side effects are required to validate the initial wiring.

Required checks:

1. Sidebar placement, list/detail navigation, editing, pausing, Run now and history links work
   with collapsed/pinned sidebar states, keyboard navigation, all existing locales and reduced motion.
2. Creating in the UI and confirming a chat proposal persist through the same host service.
   Unconfirmed or malformed proposals cannot enable automation or invoke the runtime.
3. One-time/daily/weekly schedules handle timezones, daylight saving and clock changes.
4. Renderer reload, repeated scheduler wakeups and competing claims do not duplicate admission.
5. Restart, sleep/wake and window closure follow the documented missed/interrupted policy.
6. The actual runtime receives the saved prompt, project, Agent and explicit model configuration.
   User-selected models, permissions and normal foreground chats remain authoritative.
7. Pending approval, unavailable resources, timeout, cancellation, failed cleanup and shutdown
   produce truthful states and release concurrency only after confirmed settlement.
8. Completed and failed executions link to persisted conversations after application restart;
   visual results use the existing conversation renderer.
9. Relevant tests, Typecheck and Biome pass. Report synthetic validation separately from a
   manual open/minimized desktop smoke test; do not claim platform behavior never exercised.

## Deferred work

Execution with Modus closed, cloud scheduling, OS daemons, event/webhook triggers, cron
expression editing, shared automations, automatic retries, parallel automation execution,
and hard billing budgets are outside this initial scope.
