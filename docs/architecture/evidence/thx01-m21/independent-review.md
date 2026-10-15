# Independent read-only review — Marco2.1

Reviewer: separate agent `/root/thx_m21_review`, 2026-10-15 UTC. Read source, spec and existing real/synthetic outputs; no tests, inference, export or edits performed by reviewer.

**No concrete blocker for experimental Marco2.1.** Explicit single-flight startup, process generations, bounded queues, cancellation without early slot reuse, 5s timeout, stale-result invalidation and confirmed-exit shutdown preserved. No PiSDK integration, automatic activation, Python fallback, plugin or Guardian changes found.

Limitations incorporated into the report:

- Hash verification followed by reopening paths does not protect against a concurrent writer with the same local access. Distribution requires protected host-owned immutable storage.
- Rust tests cover parsing/frames/manifests/arithmetic. Service lifecycle/queue/cancel are primarily covered by TS tests and actual supervised smoke, not isolated service.rs unit tests.
- RSS is VmHWM, not an OS-enforced cap.
- One initial1024-token request timed out; a later directed run passed. This proves fail-closed handling and variability, not latency guarantees.
