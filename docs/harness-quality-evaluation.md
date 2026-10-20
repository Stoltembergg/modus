# Harness real-inference quality evaluation

This opt-in suite runs six fixed tasks through `PiSdkRuntime`, the actual Pi SDK,
and actual provider inference. Three tasks are English and three are Portuguese.
The tasks cover grounded answers, configuration repair, CSV aggregation,
Portuguese release notes, consistent edits across two files, and a parent task
that must start and collect a real child session. Independent code checks file
contents and preserves inputs; the model does not grade itself.

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
fixed when comparing runs. Inference remains stochastic; these six examples do
not support broad statistical quality claims.

Without `MODUS_HARNESS_QUALITY_LIVE=1`, all live cases are skipped before model
lookup or temporary app setup. An enabled run with a missing/unavailable model
or missing credentials fails configuration and writes `configuration_error`;
it cannot report passed tasks. Provider failures after setup are failed tasks.

Pure verifier, scope, and reporter checks make no inference requests:

```sh
node_modules/.bin/vitest run apps/desktop/scripts/harness-quality/quality.test.ts
```

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
tool is allowed. The provider inference request itself uses the network. Host
runtime setup and storage still run on the host; this is not an OS sandbox or
an evaluation for untrusted repositories. The file checks and tool guard are
covered by local unit tests. Live end-to-end enforcement remains unverified
until this suite is run with an explicitly chosen and configured model.

Each task requests cancellation after 90 seconds; provider cancellation is
cooperative, and Vitest has a 120-second case timeout. This is not a provider
spending limit. The suite exercises data/documentation work with a restricted
tool set. It does not establish coding, shell, browser, large-context,
compaction, or general autonomous-agent quality. Existing synthetic Harness
benchmarks remain component checks and are not included as real-task results.
