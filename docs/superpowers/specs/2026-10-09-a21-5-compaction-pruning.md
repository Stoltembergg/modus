# A21.5 — Compaction Pruning Production Integration

## Status

Design approved by the user: integrate pruning only through the Pi SDK `context` hook, with the safe pruning rule and native-compaction ownership described below.

## Problem

`pi-compaction-extension.ts` contains a context hook and a `session_before_compact` hook, but `PiSdkRuntime` does not currently register that extension. The dormant context path can replace arbitrary tool output with a tombstone claiming the raw result remains in session storage. The dormant compact hook can cancel automatic compaction. Neither behavior proves the content remains available to the model, and cancellation can interfere with Pi SDK's native manual, threshold, or overflow compaction.

The existing pruner treats broad tool output as eligible and can mistake an assistant message containing a tool name for tool output. Its estimated token savings also do not establish the byte reduction actually sent to the model.

## Intended behavior

1. Register the Modus compaction extension in the productive `PiSdkRuntime` extension loader only when the effective `MODUS_COMPACTION_PRUNING` flag is enabled. The flag remains false by default and must continue to obey its dependency on `MODUS_USE_KERNEL`.
2. Register only a Pi SDK `context` hook. Do not register `session_before_compact` or alter Pi SDK's manual, threshold, automatic, or overflow compaction lifecycle. Pi SDK remains responsible for native summarization and compaction.
3. On each context callback, verify the owning runtime session and lifecycle token are still current and the feature flag remains enabled. Work only on the callback's model-bound message copy. Never mutate stored session history, durable QA evidence, Task State, or another session's data.
4. Prune an earlier tool result only when all of these conditions hold:
   - The message is a Pi SDK `toolResult` with a valid tool name and a non-error result.
   - The tool is on a deny-by-default allowlist of informational, read-only tools.
   - The result is exactly one textual content block; no image, structured, or other multimodal content is present.
   - The result is not QA/build/check evidence, a verifier decision, a spill reference, or content marked as necessary/preserved by the existing evidence rules.
   - A later result from the same tool in this same context has byte-identical text. That later result remains intact in the returned model context.
5. Preserve the earlier tool-result envelope and all unselected messages. Replace only the eligible earlier text with a short marker that identifies the retained identical later result; do not claim hidden storage or external recovery. If matching, eligibility, or message structure is uncertain, return the original context unchanged.
6. Use the actual selected model context window from Pi SDK when supplied. Existing fallback policy may be used only when the SDK supplies no valid window. Do not change the selected model, provider, thinking configuration, or SDK compaction settings. Apply pruning only when existing context-load policy says the context needs preventive headroom; exact duplicate matching remains the sole content eligibility rule.
7. Measure the exact serialized-context byte delta for the text fields replaced, preserving every message envelope byte. Record that as measured context bytes removed. Any token count derived from those bytes remains explicitly labeled an estimate and must not be described as provider-reported usage or realized token savings.
8. Reuse the existing HarnessObserver and runtime lifecycle mechanisms. Observer events must be attributable to the active session/run, contain no tool-result content, and be suppressed for stale callbacks. No new global store or durable copy of tool output is introduced.
9. A pruning error, missing model/context information, unavailable observer, cancellation, stale lifecycle token, or disabled flag must leave the original context intact and allow the Pi SDK's normal request/compaction flow to continue.

## Explicit exclusions

- No pruning of user, system, assistant, QA, build/check, verification, error, failure, plan, permission, decision, or confirmation messages.
- No pruning of command execution, mutation, spill, recovery, or arbitrary/unknown tool results.
- No pruning of multimodal or mixed-content messages.
- No replacement with a tombstone that depends on inaccessible storage.
- No `session_before_compact` interception, native compaction cancellation, custom summary, or summary replacement.
- No model selection, provider routing, thinking, permission, Verifier-First, isolation, Guardian, quota, or external-plugin changes.
- No A21.6 work.

## Validation and acceptance

The specification and implementation plan are approved. Tests must be written first and demonstrate RED before the implementation commit and GREEN after it.

Required tests include:

- Flag off by default and no effect when disabled; productive runtime registration and effect when enabled.
- Productive Pi SDK execution using an offline stream, with the exact `context` hook contract of the installed SDK.
- Identical eligible read-only result: earlier text reduced, later identical text retained, tool-result envelope preserved, and measured serialized byte delta positive.
- Different tool, different text, no later duplicate, small/under-policy context, and stale session token: context unchanged.
- Errors, QA/build/check output, verifier evidence, spill references, mixed/multimodal results, and unknown or mutating tools: context unchanged.
- Manual, automatic/threshold, and overflow compaction remain owned by Pi SDK; the extension neither cancels nor replaces them.
- Actual model context windows are honored without changing model/provider/configuration.
- Session/run, simultaneous session, Agent Group/subagent, cancellation, restart/recreation, and late-callback isolation.
- Extension/observer failure falls back to the unchanged original context.
- Metrics distinguish measured serialized bytes from estimated tokens and provider-reported usage; telemetry contains no tool content.
- A17 durable QA/Task State evidence and A21.4 spill authorization and recovery behavior remain unchanged.

The complete authorized remote Vitest, Biome, TypeScript, and applicable CI checks must be run with the existing security filters intact. No probes or enforcement scenarios may run. Request independent review before publishing task-specific commits. Keep PR #191 Draft and stop after A21.5.

## Completion evidence

The final report must state the root cause, files changed, RED/GREEN evidence, productive Pi SDK behavior, remote check results, independent review findings, commits on PR #191, and residual risks. A21.5 is not complete if safe eligibility, intact native compaction, lifecycle isolation, or positive measured byte reduction cannot be demonstrated; in that case, keep pruning disabled and report the blocker.
