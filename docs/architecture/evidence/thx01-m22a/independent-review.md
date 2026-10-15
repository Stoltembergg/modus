# Independent read-only review — Marco 2.2a

Two bounded independent passes: pre-patch boundary investigation and one candidate review. Neither reviewer edited files or ran inference/tests.

The boundary investigation confirmed verify/reopen gaps in the Node executable path and the Rust tokenizer, graph, external data and dynamic-library paths. Root ownership and an opened descriptor do not establish immutability against an authorized in-place updater. An AppImage cannot establish its own application trust anchor merely through root-looking FUSE metadata.

Candidate review found one concrete issue: the development example canonicalized fixture destinations and later used `fs::write`, permitting a symlink substitution to truncate an external writable file. It found no concrete reachable production bypass in the reviewed source. Verified vectors, external-initializer ownership and held sealed-library/system-library descriptors were consistent with their consumers. A second Engine in one process would be denied by ORT global initialization, but current production callers instantiate one Engine.

The example issue was corrected using a held directory FD, exclusive no-follow temporary creation and same-directory `renameat`: replacement affects the directory entry rather than following its target. A dedicated synthetic test substitutes a symlink to a sentinel and checks that its contents survive. This correction was tested by the implementer; no second candidate review was requested.

The reviewer explicitly cautioned that this is not a complete functional desktop fix: `openTrustedExecutable` closes the descriptor and denies all production bootstrap. Both deb and AppImage remain unavailable; legitimate desktop inference cannot pass that gate. No complete deployment or enforcement guarantee is claimed.
