# THX-01 development evidence

JSON reports are losslessly gzip-archived (`mtime=0`), preserving the original raw bytes, numeric outputs and digests. Read with `gzip -dc path.json.gz`. To restore a historical raw report path, decompress its archive into the `.json` path named in that milestone inventory. Archives are evidence, not distributed model bundles.

Frozen fixtures remain uncompressed and byte-identical in `scripts/thx01/equivalence/fixtures.json`; SHA256 `88cae7fb314e6367cab697a677680616002788fb4eb462f9ff326ede6e8a9810`. Large ONNX/data/library binaries and local build outputs are not in Git. Earlier source-code digests describe the code at the time of those experiments; Marco2.1 records the promoted/shared implementation and its fresh equivalence regression.
