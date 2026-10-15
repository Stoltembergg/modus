# Targeted checks — Marco2.1

## rust-red.log

```text
    Updating crates.io index
     Locking 88 packages to highest Rust 1.99.1 compatible versions
      Adding ahash v0.8.12
      Adding aho-corasick v1.1.5
      Adding autocfg v1.5.1
      Adding base64 v0.13.1
      Adding block-buffer v0.10.4
      Adding castaway v0.2.4
      Adding cc v1.8.0
      Adding compact_str v0.9.1
      Adding cpufeatures v0.2.17
      Adding crossbeam-deque v0.8.8
      Adding crossbeam-epoch v0.9.21
      Adding crossbeam-utils v0.8.23
      Adding crypto-common v0.1.7
      Adding darling v0.20.11
      Adding darling_core v0.20.11
      Adding darling_macro v0.20.11
      Adding dary_heap v0.3.9
      Adding derive_builder v0.20.2
      Adding derive_builder_core v0.20.2
      Adding derive_builder_macro v0.20.2
      Adding digest v0.10.7
      Adding either v1.19.0
      Adding esaxx-rs v0.1.10
      Adding find-msvc-tools v0.1.14
      Adding fnv v1.0.7
      Adding generic-array v0.14.7 (available: v0.14.9)
      Adding getrandom v0.3.4
      Adding ident_case v1.0.1
      Adding itertools v0.14.0
      Adding libloading v0.8.9
      Adding macro_rules_attribute v0.2.3
      Adding macro_rules_attribute-proc_macro v0.2.3
      Adding matrixmultiply v0.3.11
      Adding minimal-lexical v0.2.1
      Adding monostate v0.1.18
      Adding monostate-impl v0.1.18
      Adding ndarray v0.16.1
      Adding nom v7.1.3
      Adding num-complex v0.4.6
      Adding num-integer v0.1.47
      Adding num-traits v0.2.19
      Adding once_cell v1.21.4
      Adding onig v6.5.3
      Adding onig_sys v69.9.3
      Adding ort v2.0.0-rc.10 (available: v2.0.0-rc.14)
      Adding ort-sys v2.0.0-rc.10 (available: v2.0.0-rc.14)
      Adding paste v1.0.15
      Adding pastey v0.2.3
      Adding pin-project-lite v0.2.17
      Adding pkg-config v0.3.34
      Adding portable-atomic v1.15.0
      Adding portable-atomic-util v0.2.8
      Adding ppv-lite86 v0.2.21
      Adding r-efi v5.3.0
      Adding rand v0.9.5
      Adding rand_chacha v0.9.0
      Adding rand_core v0.9.5
      Adding rawpointer v0.2.1
      Adding rayon v1.12.0
      Adding rayon-cond v0.4.0
      Adding rayon-core v1.13.0
      Adding regex v1.13.1
      Adding regex-automata v0.4.18
      Adding regex-syntax v0.8.11
      Adding rustversion v1.0.23
      Adding ryu v1.0.23
      Adding sha2 v0.10.9 (available: v0.11.1)
      Adding shlex v2.0.1
      Adding smallvec v1.16.3
      Adding smallvec v2.0.0-alpha.10 (available: v2.0.0-beta.2)
      Adding spm_precompiled v0.1.4
      Adding static_assertions v1.1.0
      Adding strsim v0.11.1
      Adding syn v3.0.9
      Adding thiserror v2.0.21
      Adding thiserror-impl v2.0.21
      Adding tokenizers v0.22.2 (available: v0.23.2)
      Adding tracing v0.1.44
      Adding tracing-core v0.1.36
      Adding typenum v1.20.1
      Adding unicode-normalization-alignments v0.1.12
      Adding unicode-segmentation v1.13.3
      Adding unicode_categories v0.1.1
      Adding version_check v0.9.5
      Adding wasip2 v1.0.4+wasi-0.2.12
      Adding wit-bindgen v0.57.1
      Adding zerocopy v0.8.63
      Adding zerocopy-derive v0.8.63
 Downloading crates ...
  Downloaded bitflags v2.11.1
  Downloaded log v0.4.30
  Downloaded cfg-if v1.0.4
   Compiling proc-macro2 v1.0.106
   Compiling unicode-ident v1.0.24
   Compiling quote v1.0.45
   Compiling cfg-if v1.0.4
   Compiling serde_core v1.0.228
   Compiling syn v2.0.117
   Compiling libc v0.2.186
   Compiling serde v1.0.228
   Compiling memchr v2.8.1
   Compiling darling_core v0.20.11
   Compiling serde_derive v1.0.228
   Compiling darling_macro v0.20.11
   Compiling darling v0.20.11
   Compiling zmij v1.0.21
   Compiling getrandom v0.3.4
   Compiling derive_builder_core v0.20.2
   Compiling rand_core v0.9.5
   Compiling aho-corasick v1.1.5
   Compiling syn v3.0.9
   Compiling serde_json v1.0.150
   Compiling regex-automata v0.4.18
   Compiling nom v7.1.3
   Compiling thiserror-impl v2.0.21
   Compiling derive_builder_macro v0.20.2
   Compiling rand_chacha v0.9.0
   Compiling monostate-impl v0.1.18
   Compiling bitflags v2.11.1
   Compiling spm_precompiled v0.1.4
   Compiling compact_str v0.9.1
   Compiling onig v6.5.3
   Compiling monostate v0.1.18
   Compiling ndarray v0.16.1
   Compiling rand v0.9.5
   Compiling derive_builder v0.20.2
   Compiling thiserror v2.0.21
   Compiling ahash v0.8.12
   Compiling regex v1.13.1
   Compiling dary_heap v0.3.9
   Compiling libloading v0.8.9
   Compiling log v0.4.30
   Compiling tokenizers v0.22.2
   Compiling sha2 v0.10.9
   Compiling ort v2.0.0-rc.10
   Compiling modus-decision-runtime v0.1.0 (/workspace/modus-pr191/crates/decision-runtime)
error[E0432]: unresolved import `modus_decision_runtime::protocol`
 --> crates/decision-runtime/tests/protocol.rs:1:29
  |
1 | use modus_decision_runtime::protocol::{parse_request, read_frame, MAX_REQUEST_BYTES};
  |                             ^^^^^^^^ could not find `protocol` in `modus_decision_runtime`

For more information about this error, try `rustc --explain E0432`.
error: could not compile `modus-decision-runtime` (test "protocol") due to 1 previous error
warning: build failed, waiting for other jobs to finish...
```

## ts-red.log

```text

 RUN  v5.0.3 /workspace/modus-pr191

 ❯ apps/desktop/src/main/agent/decision/decision-runtime.test.ts (0 test)

⎯⎯⎯⎯⎯⎯ Failed Suites 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  apps/desktop/src/main/agent/decision/decision-runtime.test.ts [ apps/desktop/src/main/agent/decision/decision-runtime.test.ts ]
Error: Cannot find module '/apps/desktop/src/main/agent/decision/decision-runtime' imported from /workspace/modus-pr191/apps/desktop/src/main/agent/decision/decision-runtime.test.ts
 ❯ apps/desktop/src/main/agent/decision/decision-runtime.test.ts:10:1
      8| const spawnMock = vi.hoisted(() => vi.fn());
      9| vi.mock("node:child_process", () => ({ spawn: spawnMock }));
     10| import { DecisionRuntime, type DecisionRuntimeConfig } from "./decisio…
       | ^
     11|
     12| const input = { question: "Synthetic context?", state: "synthetic", op…

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯


 Test Files  1 failed (1)
      Tests  no tests
   Start at  21:42:09
   Duration  493ms (worker 97%, environment 3%)

npm notice
npm notice New major version of npm available! 11.9.0 -> 12.2.0
npm notice Changelog: https://github.com/npm/cli/releases/tag/v12.2.0
npm notice To update run: npm install -g npm@12.2.0
npm notice
```

## rust-green.log

```text
   Compiling modus-decision-runtime v0.1.0 (/workspace/modus-pr191/crates/decision-runtime)
    Finished `release` profile [optimized] target(s) in 11.17s
     Running unittests src/lib.rs (/workspace/scratch/thx01-m13/target/release/deps/modus_decision_runtime-c72fd2ebdce96ca9)

running 6 tests
test inference::tests::bounds_do_not_truncate ... ok
test inference::tests::calibration_uniform_distribution ... ok
test inference::tests::logits_outside_tolerance_rejected ... ok
test inference::tests::nonfinite_values_rejected ... ok
test inference::tests::ties_preserve_first_alternative ... ok
test inference::tests::artifact_change_is_rejected ... ok

test result: ok. 6 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s

     Running unittests src/main.rs (/workspace/scratch/thx01-m13/target/release/deps/modus_decision_runtime-311ff9dc109b41b0)

running 0 tests

test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s

     Running tests/protocol.rs (/workspace/scratch/thx01-m13/target/release/deps/protocol-5348876ef8f22d21)

running 6 tests
test preserves_complete_frames_across_stream_reads ... ok
test rejects_observations_without_input_and_commands_with_extra_input ... ok
test rejects_oversize_frame_without_reading_unbounded_input ... ok
test rejects_partial_frames_and_invalid_utf8 ... ok
test requires_protocol_version_generation_and_bounded_identifiers ... ok
test does_not_load_dependencies_from_an_uncovered_manifest ... ok

test result: ok. 6 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s

   Doc-tests modus_decision_runtime

running 0 tests

test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s

```

## vitest-final.log

```text

 RUN  v5.0.3 /workspace/modus-pr191


 Test Files  2 passed (2)
      Tests  25 passed (25)
   Start at  22:00:56
   Duration  940ms (tests 56%, transform 26%, import 16%, worker 2%)

```

## typecheck.log

```text

> @modus/desktop@0.1.10 typecheck
> tsc -p tsconfig.json --noEmit

```

## biome.log

```text
Checked 5 files in 74ms. Fixed 1 file.
```

## cargo-check.log

```text
    Checking cfg-if v1.0.4
    Checking serde_core v1.0.228
    Checking memchr v2.8.1
    Checking libc v0.2.186
    Checking crossbeam-utils v0.8.23
    Checking serde v1.0.228
    Checking crossbeam-epoch v0.9.21
    Checking getrandom v0.3.4
    Checking zerocopy v0.8.63
    Checking typenum v1.20.1
    Checking generic-array v0.14.7
    Checking num-traits v0.2.19
    Checking crossbeam-deque v0.8.8
    Checking either v1.19.0
    Checking rayon-core v1.13.0
    Checking rand_core v0.9.5
    Checking aho-corasick v1.1.5
    Checking rawpointer v0.2.1
    Checking regex-syntax v0.8.11
    Checking ppv-lite86 v0.2.21
    Checking once_cell v1.21.4
    Checking itoa v1.0.18
    Checking minimal-lexical v0.2.1
    Checking nom v7.1.3
    Checking regex-automata v0.4.18
    Checking rand_chacha v0.9.0
    Checking matrixmultiply v0.3.11
    Checking castaway v0.2.4
    Checking rayon v1.12.0
    Checking onig_sys v69.9.3
    Checking zmij v1.0.21
    Checking itertools v0.14.0
    Checking num-complex v0.4.6
    Checking num-integer v0.1.47
    Checking block-buffer v0.10.4
    Checking crypto-common v0.1.7
    Checking bitflags v2.11.1
    Checking base64 v0.13.1
    Checking smallvec v1.16.3
    Checking static_assertions v1.1.0
    Checking ryu v1.0.23
    Checking unicode-segmentation v1.13.3
    Checking compact_str v0.9.1
    Checking spm_precompiled v0.1.4
    Checking macro_rules_attribute v0.2.3
    Checking unicode-normalization-alignments v0.1.12
    Checking onig v6.5.3
    Checking digest v0.10.7
    Checking monostate v0.1.18
    Checking ndarray v0.16.1
    Checking rayon-cond v0.4.0
    Checking serde_json v1.0.150
    Checking derive_builder v0.20.2
    Checking ort-sys v2.0.0-rc.10
    Checking ahash v0.8.12
    Checking thiserror v2.0.21
    Checking rand v0.9.5
    Checking esaxx-rs v0.1.10
    Checking regex v1.13.1
    Checking dary_heap v0.3.9
    Checking libloading v0.8.9
    Checking smallvec v2.0.0-alpha.10
    Checking cpufeatures v0.2.17
    Checking unicode_categories v0.1.1
    Checking log v0.4.30
    Checking ort v2.0.0-rc.10
    Checking tokenizers v0.22.2
    Checking sha2 v0.10.9
    Checking modus-decision-runtime v0.1.0 (/workspace/modus-pr191/crates/decision-runtime)
    Finished `release` profile [optimized] target(s) in 37.81s
```

## build.log

```text
    Finished `release` profile [optimized] target(s) in 0.11s
```

## validator-build.log

```text
   Compiling modus-decision-runtime v0.1.0 (/workspace/modus-pr191/crates/decision-runtime)
   Compiling thx01-equivalence v0.1.0 (/workspace/modus-pr191/scripts/thx01/equivalence)
    Finished `release` profile [optimized] target(s) in 16.66s
```

## shared-equivalence.log

```text
{"event": "ready", "startup_from_main_ms": 5151.31936, "external_elapsed_ms": 5170.6582000006165}
{"event": "completed", "fixtures": 24, "peak_rss_kib": 865916, "external_elapsed_ms": 17544.8384170013}
```

## biome-final.log

```text
Checked 5 files in 39ms. No fixes applied.
```

## typecheck-final.log

```text

> @modus/desktop@0.1.10 typecheck
> tsc -p tsconfig.json --noEmit

```
