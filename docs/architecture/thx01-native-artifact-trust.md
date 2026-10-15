# THX-01 Marco 2.2a — Native Artifact Trust (Linux x64)

**Partial implementation validated; complete bootstrap/distribution remains BLOCKED.** The six native assets now have authenticated consumers without source-path reopening. The seventh component, the executable itself, lacks a proven immutable application bootstrap. Desktop admission therefore unconditionally denies for **both deb and AppImage**. This is not approval to distribute or integrate the experimental service.

## Root cause and delivered chain

Marco 2.1 hashed paths, then reopened them for spawn, tokenization, ONNX graph/external data and dynamic-library loading. A replacement between those operations could change the consumed bytes. A locator's own hashes also cannot independently authorize the files beside it.

The new trust authorities are application source, independent of the local locator:

- `native-trust-root.ts` pins the experimental executable, the prospective versioned deb directory and the application anchor. No plugin, prompt or model supplies these identities.
- `crates/decision-runtime/artifact-trust-root.json`, compiled into the native binary, pins graph, external data, tokenizer, tokenizer configuration, calibration and ORT library, including exact sizes, checkpoint and ORT version.
- The locator remains a bounded, authenticated **locator**, not a trust root. Unknown fields, missing/duplicate/extra identities, unauthorized external data and wrong versions are rejected.

Rust walks source components using directory descriptors and `O_NOFOLLOW`. Reads are bounded and check file identity/size/timestamps before and after reading. SHA-256 authenticates the resulting owned bytes. Subsequent replacement or in-place changes to source files cannot change those owned buffers. A changed read cannot be accepted unless its resulting bytes satisfy the application pin.

Tokenizer/configuration/calibration parse authenticated buffers. ORT receives the graph and the one pinned external-initializer file in memory, using its existing API without graph rewriting. ORT's shared-library bytes are copied to a memfd, sealed against write/grow/shrink/further seal changes, then **rehashed from the sealed descriptor**. The descriptor stays alive through native inference. This second hash catches a same-UID writer racing the pre-seal copy.

The approved ORT binary's dependencies are OS libraries. The loader rejects `LD_*`, `ORT_DYLIB_PATH`, noninitial user namespaces and untrusted dependency locations. It opens root-controlled x86_64 system libraries and keeps their descriptors and loader handles alive; this also avoids glibc confusing reused `/proc/self/fd/N` names. The kernel, OS loader, root-managed system libraries and the already trusted application process are explicit trusted computing base. This does not claim protection from arbitrary privileged code or ptrace into that trusted process.

Inference/tokenization/calibration, protocol, one-active/four-queued limit, generation invalidation, cancellation and five-second inference deadline are unchanged. No remote/Python fallback or runtime download exists.

## Executable bootstrap and Linux distribution status

The host validates a prospective `/usr/lib/modus/resources/app.asar` anchor and a pinned executable under `/usr/lib/modus/decision/<digest>/bin/modus-decision-runtime`, using held descriptors and checks for root ownership, writable ancestors, symlinks, namespace and FUSE. Descriptor-based execution is wired as `/proc/self/fd/3` with an inherited FD instead of reopening the original executable pathname.

**These checks do not prove executable immutability during an update.** An opened FD protects against pathname replacement, but a privileged updater could still rewrite that inode after hashing. Node alone has no validated sealed-executable bootstrap here. A requirement that updates never rewrite generations would be an assumption, not an implemented protection. Consequently `openTrustedExecutable` closes the FD and throws `decision_runtime:artifact_bootstrap_immutability_unproven`, even if all preceding deb checks pass. No environment/configuration bypass is provided. The supervisor maps rejection to its existing artifact failure and does not spawn.

| Format | Current availability | Remaining requirement |
| --- | --- | --- |
| Root-managed deb | Denied | Proven immutable executable/bootstrap plus actual installation/update validation and artifact pin generation. Root-only mode bits alone are insufficient. |
| AppImage, mounted or extracted | Denied | An independent trustworthy bootstrap; user-writable image/extraction and root-looking FUSE metadata cannot attest themselves. |
| Developer validation executable | Explicit trusted developer launch only | Exercises production native consumers, not installed application trust. Not a distributed service or supported installation. |

No packaging, signing/update mechanism or public release was implemented. No Linux distribution mode is approved by this milestone. Windows/macOS were untouched.

## Targeted evidence

See [evidence](evidence/thx01-m22a/) and [independent review](evidence/thx01-m22a/independent-review.md). JSON is losslessly gzipped to preserve generated arrays without formatter exclusions.

- **RED:** the recorded legacy reproduction verifies an original file then consumes replacement bytes; initial new integrity tests failed before the artifact module existed. This demonstrates the original verify/reopen defect; it is not an attack against an installed package.
- **Rust: 20 passed** across library, artifact, protocol and development-example tests. Coverage includes pinned bytes after replacement/in-place mutation, symlinks/ancestors/traversal/nonregular files, size/hash/locator rejection, unauthorized sidecar identities, sealed-FD write/truncate rejection, loader environment and the example's symlink-safe replacement.
- **TypeScript: 29 passed** across artifact trust, supervisor and runtime registry. Supervisor lifecycle tests mock the trust boundary and therefore do not prove installed bootstrap. Trust tests reject writable paths/AppImage; one harmless `/usr/bin/true` FD-execution test validates only the libuv/Linux descriptor primitive, not Modus package trust.
- Targeted **Biome, Rustfmt, Cargo check/build and desktop Typecheck passed**. Initial Typecheck aborted at Node's approximately 2 GiB default heap; rerunning with `NODE_OPTIONS=--max-old-space-size=6144` passed. No repository configuration changed and no global CI was run.
- Independent candidate review found a development-helper destination-write race. The correction uses a held directory FD, exclusive no-follow temporary creation and same-directory `renameat`; a substituted destination symlink leaves a sentinel unchanged. No repeated candidate review was requested. The review found no concrete reachable production bypass but explicitly identified the unavailable desktop bootstrap.

### Real offline inference after source substitution

A development-only Rust example calls `Bundle::load`, atomically replaces **all six source files and the locator**, then invokes the actual `Engine::from_verified_bundle` and IPC service. It does not inject an alternative model consumer. Only disposable copies are modified; the approved original digests were checked again afterward.

The final run used Linux x64 CPU, Rust 1.99.1, `ort` 2.0.0-rc.10, ORT 1.22.0 and tokenizers 0.22.2, two intra-op threads/one inter-op thread. Process-local `strace` socket denial was active; the trace contains no network syscalls. Native exit was zero.

| Frozen fixture | Tokens | Native inference ms | Choice matches PyTorch |
| --- | ---: | ---: | --- |
| equiv-pt-01 | 89 | 169.23 | Yes |
| equiv-en-01 | 86 | 140.11 | Yes |
| equiv-pt-05 | 100 | 145.72 | Yes |
| equiv-en-05 | 95 | 138.43 | Yes |
| equiv-pt-11 | 1024 | 2650.73 | Yes |
| equiv-en-11 | 1024 | 2448.56 | Yes |

Maximum absolute logit difference was **1.76430e-5**; probability **1.01328e-6**; confidence **6.58090e-7**. All satisfy the existing tolerances (logits atol=1e-4/rtol=1e-3, probabilities/confidence absolute error<=1e-4) without a choice difference. This is six targeted regressions, **not** a rerun of the full 24-fixture equivalence or a decision-quality evaluation. Existing approved weights, graph, tokenizer, calibration and frozen fixtures were unchanged.

Final startup, including authentication/loading and replacement fixture work, was **6923.68 ms**. Native peak VmHWM was **3,754,500 KiB (3.58 GiB)**; an earlier run measured **3,842,396 KiB (3.66 GiB)**. These are process high-water marks, not steady-state RSS or performance promises. The new authenticated-buffer path exceeds the earlier proposed 1280 MiB budget during initialization. Resource policy/enforcement and memory optimization are outside this scope and remain distribution blockers. No memory policy was relaxed or replaced with monitoring.

## Reproduce and inspect

With the approved local artifacts and Rust/Cargo dependencies already available:

```bash
CARGO_TARGET_DIR=/workspace/scratch/thx01-m13/target ~/.cargo/bin/cargo test -p modus-decision-runtime --all-targets
CARGO_TARGET_DIR=/workspace/scratch/thx01-m13/target ~/.cargo/bin/cargo check --release --locked -p modus-decision-runtime
CARGO_TARGET_DIR=/workspace/scratch/thx01-m13/target ~/.cargo/bin/cargo build --release --locked -p modus-decision-runtime --example artifact-trust-smoke
~/.cargo/bin/cargo fmt -p modus-decision-runtime -- --check
npx vitest run apps/desktop/src/main/agent/decision/artifact-trust.test.ts apps/desktop/src/main/agent/decision/decision-runtime.test.ts apps/desktop/src/main/agent/runtime-registry.test.ts
NODE_OPTIONS=--max-old-space-size=6144 npm run typecheck --workspace @modus/desktop
python3 scripts/thx01/artifact_trust_smoke.py --binary /workspace/scratch/thx01-m13/target/release/examples/artifact-trust-smoke --manifest /workspace/scratch/thx01-m21/runtime-manifest.json --fixtures scripts/thx01/equivalence/fixtures.json --reference /workspace/scratch/thx01-m13/reference.json --output /tmp/thx22a-results
```

The Python driver uses only standard-library orchestration/comparison; native inference loads no Python. It is not a production component. The inventory records artifact sizes/digests and development executable hashes. The TypeScript binary pin is tied to this exact experimental build; release pin generation/reproducibility remains future work.

**Next prerequisite:** establish an independently trusted immutable executable bootstrap and validate update semantics before approving either Linux installation format. Then separately address native initialization memory limits. Neither task was started. No Pi SDK/Meta Controller, feature flags/UI, plugin supervisor, Guardian controls or checkpoints were changed. Stop after Marco 2.2a.
