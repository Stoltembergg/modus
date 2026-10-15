# THX-01 Marco2.2a — Native Artifact Trust

User-authorized security patch to the existing loader/supervisor, preserving inference, private IPC, concurrency and five-second deadline. Native artifact identity is compiled into the application, not taken from a sidecar manifest. No package, feature, model, Guardian or PiSDK work.

- [x] RED: demonstrate same-open snapshot integrity and rejection of links/traversal/changes; test host root-anchor and descriptor execution rather than path reopening.
- [x] Native fix: six fixed artifact identities; bounded descriptor reads; parse verified buffers; explicit external ONNX buffer; sealed memfd ORT library; trusted OS dependency contract.
- [x] Host containment: application-pinned binary, root-layout/descriptor checks and symlink/FUSE/usernamespace rejection implemented. **Full immutable executable bootstrap is blocked.** No updater immutability contract is assumed: both deb and AppImage admission unconditionally deny. Descriptor execution is only a tested primitive.
- [x] GREEN: native/unit/supervisor tests, actual offline Linux inference with unchanged reference, measured resource delta, failure cases and scoped Rust/TypeScript checks.
- [x] One independent candidate review, evidence/report, validated commit/push. Stop after2.2a. Actual installed deb/update security is not presumed from synthetic filesystem tests.

Outcome: six authenticated native consumers validated; seven-component trust criterion remains BLOCKED by executable immutability. Both Linux distribution modes deny. Native initialization peak exceeds the earlier proposed memory budget; no policy/enforcement work is authorized here. See `docs/architecture/thx01-native-artifact-trust.md`.
