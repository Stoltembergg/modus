---
name: define-goal
description: Help the user define a concrete, measurable goal before starting work, especially when they ask to use the goal tool, create a goal, set an objective, clarify success criteria, or turn a fuzzy intention into a quantitative outcome. Use this skill for goal creation and goal refinement only; it does not manage durable snapshots, decision logs, or long-running execution artifacts.
---

<!-- Adapted from openai/skills (skills/.curated/define-goal, commit 49f948fa), Apache-2.0; modified for Modus: adds complete_goal and the one-goal-per-session model -->

# Define Goal

## Overview

Shape the user's intent into an objective an agent can pursue honestly. Prefer measurable outcomes, explicit evidence, and bounded scope over activity descriptions.

In Modus a session holds at most one goal. The goal tools are `get_goal`, `create_goal` and `complete_goal`; they become available from the turn after this skill is used and stay for the rest of the session.

This skill covers goal definition, goal-tool creation and honest goal completion only. Do not create intermediate planning artifacts, durable snapshots, ledgers, decision logs, or resume files from this skill.

## Workflow

1. Confirm that goal definition is actually needed.
   - Use this skill when the user asks for `$define-goal`, asks to create or set a goal, asks for the goal tool, or wants help turning an intention into a clear objective.
   - If the user only asks for ordinary implementation work, do the work directly instead of forcing goal creation.

2. Restate the likely goal in concrete terms.
   A usable goal names:
   - the specific outcome that will be true
   - the main artifact, system, repo, environment, or user-facing behavior involved
   - how completion will be verified
   - what is in scope
   - what is out of scope when ambiguity would matter
   - the stop condition for asking the user instead of grinding

3. Make it quantitative when the domain supports it.
   Prefer numbers that represent real success, not decorative precision:
   - pass/fail validators: exact tests, checks, CI jobs, evals, commands, or acceptance criteria
   - quality thresholds: latency, error rate, cost, accuracy, recall, precision, coverage, flake rate, bundle size, memory, uptime, completion rate, or manual review criteria
   - artifact constraints: file paths, affected modules, allowed commands, output formats, target environments, deadlines, or maximum blast radius
   - evidence counts: number of reproduced failures, successful reruns, reviewed examples, migrated records, addressed comments, or verified cases

4. Repair weak goals before setting them.
   - Rewrite vague goals into measurable objectives when local context makes the rewrite safe.
   - Ask one concise clarification question when the missing detail changes the intended outcome or validation.
   - Reject pure activity goals such as "make progress," "keep investigating," "improve things," or "work on X" unless they are sharpened into a verifiable outcome.

5. Check active goal state before creating a goal.
   - Call `get_goal`.
   - If there is no active goal and the objective meets the quality bar, call `create_goal`.
   - If there is an active goal that still matches the user's intent, continue using it instead of creating a duplicate.
   - If there is an active goal that conflicts with the new request, ask whether to finish the current goal, mark it complete if done, or start a separate goal in a new session (one session holds one goal).
   - If `get_goal` is not available yet, it appears from your next turn; shape the goal with the user in the meantime.

6. Create the goal only after it passes the quality bar.
   - Use a single concise objective string.
   - Include the verification evidence in the objective itself, and repeat it in `done_when`.
   - Put scope bounds that constrain the work in `out_of_scope`, and the conditions that should stop you and make you ask in `stop_and_ask`.
   - Modus goals have no token-budget field; mention a budget in the objective only when the user explicitly requested one.
   - Do not call `create_goal` for an ordinary multi-step task unless the user explicitly asked for goal-backed work.

7. Check the goal before claiming it is done.
   - Before you tell the user the goal's work is finished, call `get_goal` and compare what you did against its `done_when` criteria.
   - Call `complete_goal` only when every criterion is met, with `evidence` that shows it (commands run and their results, test or CI output, links, measured numbers) and a short `summary`.
   - If a criterion is not met, say which one and keep working or ask; do not complete the goal on partial evidence.

## Goal Quality Bar

Before `create_goal`, the objective should answer:

- What concrete thing will be true when this is done?
- What evidence will prove it?
- What quantitative or binary threshold defines success?
- What scope boundaries matter?
- What should cause the agent to stop and ask?

Good:

> Reduce checkout API p95 latency below 250 ms for the documented slow path by making the smallest safe server-side change, then verify with `npm run test:checkout` and the existing local latency benchmark showing p95 under 250 ms across 3 consecutive runs.

Good:

> Resolve the open review comments on PR 123 that request code changes, update only the affected auth files and tests, and verify with the targeted auth test command plus `gh pr view 123` showing no unresolved change-request threads.

Weak:

> Make checkout faster.

Weak:

> Keep investigating the PR comments.

## Quantification Heuristics

- For bugs, define success as reproduction first, fix second, and a failing-then-passing validator when possible.
- For tests, name the exact command and required pass condition.
- For performance, name the metric, target threshold, measurement method, and number of runs.
- For quality work, define an observable acceptance bar such as reviewed examples, lint/typecheck/test pass, or user-approved artifact.
- For research, define the decision the research must enable, the sources or systems in scope, and the evidence standard.
- For operations, define healthy state, monitoring window, failure threshold, and rollback or escalation trigger.

## Clarifying Questions

Ask only when a reasonable rewrite would risk pursuing the wrong outcome. Keep the question short and oriented around the missing validator or scope boundary.

Useful question shapes:

- "What metric should define success here: latency, cost, accuracy, or user-visible behavior?"
- "Which environment should I verify against: local, staging, or production?"
- "What is the minimum evidence you want before I mark this goal complete?"

If the user cannot provide a metric, propose the most honest binary validator available and ask for confirmation.
