# Independent review — THX-01 Marco 1.3

Reviewer: separate agent `/root/thx_m13_review`, 2026-10-15 UTC. Read-only review of the implementation, pinned original source, manifest and actual reference/native outputs; no additional model runs, exports or tests.

**GO for the tested Linux x64 technical equivalence; no blocking findings.**

- Native construction preserves tokenization, option order, markers, masks and padding. All five tensors exactly match across all 24 fixtures.
- Postprocessing preserves temperature 2.55, softmax, normalized entropy confidence and first-alternative tie behavior.
- 24/24 identical choices, including both 1024-token and both explicitly padded cases.
- Maximum observed errors: logits 3.2425e-5; probabilities 1.7882e-6; confidence 1.9669e-6. Within approved tolerances.
- Manifest contains approved graph/external-data digests; checked before and after native inference.
- Native exit code zero under denied socket creation; trace shows no network calls.

Limits: no retrieval-as-winner case; one process/one warmup/one forward per fixture under strace; native RSS excludes Python; startup includes hash/reference/tokenizer work; trusted development manifest is not a production authentication boundary. No claim of classification accuracy, packaged distribution, Windows/macOS support or future-service security. Marco 2 remains unauthorized.
