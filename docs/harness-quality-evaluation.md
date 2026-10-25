# Harness real-inference quality evaluation

This opt-in suite runs seven fixed tasks through `PiSdkRuntime`, the actual Pi SDK,
and actual provider inference. Three tasks are English and four are Portuguese.
The tasks cover grounded answers, configuration repair, CSV aggregation,
Portuguese release notes, consistent edits across two files, and a parent task
that must start and collect a real child session, plus a real repository code repair.
Independent code checks file contents and preserves inputs; the model does not
grade itself. The coding task also executes independent behavioral checks.

The original seven-task set is corpus `v1` and remains unchanged. A separate
two-task extension `v2` covers an iterative repair with a host-owned feedback
tool and English recall from the real local project-memory store/context planner.
The recall case seeds a current-workspace decision and a same-topic decoy in a
different workspace, passes only the planner's digest to the model, and checks
that the selected IDs exclude the decoy. The extension has its own fixture hash
and report; do not combine its scores with `v1` or call either set a quality
gain without a comparable live run.

## Run

Choose the exact provider/model with the user before invoking this suite. Calls
incur the selected provider's normal inference costs. Supply credentials through
that provider's normal environment configuration. The suite creates fresh app
data and home directories and never reads the installed app's auth files. It
does not download models, start the local tool filter, or refresh remote catalogs.
Providers that require the running desktop authentication service may be
unavailable in this isolated runner; the suite does not substitute another model.
Google Vertex and Amazon Bedrock are explicitly unsupported because their SDK
authentication can discover credential files or ambient identity services. The
real registry's availability checks are narrowed to the chosen provider before
enumerating models, preventing discovery checks for unrelated providers.

From the repository root, after dependencies are already installed:

```sh
MODUS_HARNESS_QUALITY_LIVE=1 \
MODUS_HARNESS_QUALITY_CORPUS=v1 \
MODUS_HARNESS_QUALITY_MODEL='USER_CHOSEN_PROVIDER/USER_CHOSEN_MODEL' \
MODUS_HARNESS_QUALITY_THINKING=off \
MODUS_HARNESS_QUALITY_REVISION='REVISION_BEING_EVALUATED' \
MODUS_HARNESS_QUALITY_REPORT='/absolute/path/harness-quality-report.json' \
node_modules/.bin/vitest run apps/desktop/src/main/agent/harness/harness-quality.live.test.ts
```

`MODUS_HARNESS_QUALITY_MODEL` is mandatory when enabled. Model names may contain
slashes after the provider. The model is explicit at session creation and every
parent prompt. Child creation is checked against the same provider/model before
the real SDK runs. Thinking defaults to `off`; supported inputs are `off`,
`minimal`, `low`, `medium`, `high`, `xhigh`, and `max`. The product's normal model
capability mapping still applies. Record the source revision and keep the report
with the evaluated patch. Keep all model, thinking, fixture, and flag settings
fixed when comparing runs. Inference remains stochastic; these seven examples do
not support broad statistical quality claims.

Run only the extension corpus by setting `MODUS_HARNESS_QUALITY_CORPUS=v2`. It
sends two normal inference requests and incurs the selected provider's usual
cost. The repair verifier accepts no arguments, reads only the approved
`command-line.ts`, returns a boolean and fixed failure IDs, and is capped at four
calls. The candidate is evaluated by the same independent behavioral verifier
as `v1`. The memory fixture uses the production SQLite retrieval and context
planner against the isolated evaluation database; the model never receives the
cross-workspace decoy. Both corpora remain opt-in and use the exact
user-selected provider/model.

Without `MODUS_HARNESS_QUALITY_LIVE=1`, all live cases are skipped before model
lookup or temporary app setup. An enabled run with a missing/unavailable model
or missing credentials fails configuration and writes `configuration_error`;
it cannot report passed tasks. Provider failures after setup are failed tasks.

Local verifier, scope, and reporter checks make no inference requests:

```sh
node_modules/.bin/vitest run apps/desktop/scripts/harness-quality/quality.test.ts apps/desktop/scripts/harness-quality/code-repair.test.ts
```

The extension's local verifier and workspace-scope checks also run without
provider access:

```sh
node_modules/.bin/vitest run \
  apps/desktop/scripts/harness-quality/iterative-repair.test.ts \
  apps/desktop/scripts/harness-quality/scoped-recall.test.ts \
  apps/desktop/scripts/harness-quality/scope.test.ts
```

## First repository coding task and baseline

`repair-command-line-pt` uses exact snapshots of the real
`apps/desktop/src/shared/command-line.ts` and its existing tests at revision
`ba6ca5e56d4393316653b6542a9311be08008295`. This is an existing bug, not a seeded
mutation: `splitCommandLine(joinCommandLine(['a"b']))` returns `['a\\b']`.
The existing six unit tests pass despite this failure. The task asks for an
encoder repair that preserves the splitter's literal-backslash, no-shell-expansion
contract. Production source is deliberately unchanged by this evaluation patch.

The model gets a tiny flat workspace containing the source, existing tests, and
a README. Only the source is writable. Neither the reference repair nor the
independent checks are copied into its workspace. Sixteen behavioral checks
cover the existing commands and formatting, both quote kinds, empty tokens,
Windows paths, backslashes, Unicode, whitespace and empty argument lists. These
are behavioral checks, not a source-text comparison or model self-assessment.
The host runs them after the model finishes; the model cannot run a test command
or observe test feedback during its turn. This is a small repository-derived
repair, not yet full-repository debugging or an iterative edit/test loop.

The checked-in [local baseline](evaluations/harness-quality-code-repair-baseline.json)
is explicitly **offline verifier calibration**, not an agent/model score. It
records the base revision, fixture/source hashes, Node version and per-check
results for the original source (rejected) and a reference repair (accepted).
The reference is a human-authored positive control, not a model output. No live
inference was run to produce it; provider, model, tokens, latency and cost are
therefore not measured. There is no live quality baseline yet.

Reproduce or refresh the local record from the repository root:

```sh
MODUS_HARNESS_QUALITY_LIVE=0 \
MODUS_HARNESS_QUALITY_BASELINE=docs/evaluations/harness-quality-code-repair-baseline.json \
node_modules/.bin/vitest run \
  apps/desktop/scripts/harness-quality/code-repair.test.ts \
  apps/desktop/scripts/harness-quality/quality.test.ts \
  apps/desktop/src/shared/command-line.test.ts \
  apps/desktop/src/main/agent/harness/harness-quality.live.test.ts
```

This runs local checks and skips all seven live tasks. It needs the already
installed dependencies, no provider credentials. Without the baseline variable,
tests check the stored hashes/results without rewriting the record. Changes to
hashed harness files require an explicit refresh. To create the actual live
baseline, first choose the exact provider/model, then use the opt-in command above
with fixed thinking/flags and a report path. Do not compare scores from the old
six-task fixture set directly with this seven-task set.

## Measurements

The JSON report records selected model, requested thinking, effective Harness
flags, fixture and source-file hashes, optional source revision, independent checks, runtime
outcome, timeouts, denied tools, and observed tool errors. A task passes only
when its independent checks pass and its observed runs complete successfully.

Parent and child usage come from the runtime's actual terminal events. Unique
session/run pairs are counted once, including failed and cancelled runs. Each
partition contains `reportedUsage`, `missingUsageRunIds`, and `totalUsage`.
`totalUsage` is null when any observed run lacks valid provider usage, or when
the partition has no observed runs. A zero in `reportedUsage` is not evidence
that a missing measurement consumed no tokens. Run elapsed times use monotonic
event-observation timestamps; task wall time includes runtime setup, inference,
tools, children, and independent verification. Child times may overlap and must
not be summed into wall time. Dollar costs are not estimated.

## Boundaries and limits

Only desktop transport, app-data location, app home discovery, SDK resource
discovery/loading, provider availability, and tool availability are adapted by the test. SDK
package discovery returns an empty inventory and refuses external resource
sources, since the SDK otherwise enumerates the real home even when resource
loading is disabled. The SDK session factory
wrapper checks model/workspace bounds and then calls the actual factory. The
real resource loader prepends a deny-by-default `tool_call` extension before
the normal permission extension, and removes external tools from the real SDK
registry. The retained tools are `read`, `edit`, `write`, `task`, `wait`, and
`todo_write`. Paths must resolve to pre-created regular files explicitly listed
by the fixture, without symlink traversal; writes have a narrower allowlist.
Permitted file approvals use the real broker with `allow-once`. Delegation is
limited to one built-in read-only `explore` child in the delegation case.

No shell, browser, network, process, MCP, group, or generated-code execution
tool is allowed to the agent. The provider inference request itself uses the
network. For the coding task only, the host verifier transpiles the edited pure
TypeScript and executes it in a fresh Node subprocess with an empty environment
(no provider credentials or inherited `NODE_OPTIONS`). Each check uses a fresh
VM context without injected host objects, `require`, or `process`; dynamic code
generation is disabled. Limits are 64 KiB source/output, 100 ms per VM check,
3 seconds per subprocess, and 64 MiB V8 old-space. Errors and limits fail checks.
This introduces host-side candidate-code execution, not an agent execution tool.

Node VM and these resource limits are **not a security sandbox**, nor is the V8
limit a total OS memory cap. Host runtime setup and storage still run on the host.
Use only these trusted fixed tasks, never untrusted repositories or adversarial
code; do not generalize this verifier into arbitrary code execution. The file
checks, tool guard, bug reproduction and verifier failure paths have local tests.
Live end-to-end enforcement remains unverified until the suite is run with an
explicitly chosen and configured model.

Each task requests cancellation after 90 seconds; provider cancellation is
cooperative, and Vitest has a 120-second case timeout. This is not a provider
spending limit. The suite exercises data/documentation and one small code repair
with a restricted tool set. It does not establish general coding, shell, browser, large-context,
compaction, or general autonomous-agent quality. Existing synthetic Harness
benchmarks remain component checks and are not included as real-task results.
