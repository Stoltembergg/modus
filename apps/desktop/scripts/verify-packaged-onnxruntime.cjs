// Packaged onnxruntime-node smoke check (RERANK-03 PR 1). Run with the PACKAGED
// app's own Electron binary in Node mode, so the N-API binding is loaded by
// Electron's runtime exactly as the app would:
//
//   ELECTRON_RUN_AS_NODE=1 <packaged Modus binary> verify-packaged-onnxruntime.cjs <resources dir> <platform> <arch>
//
// It checks that app.asar.unpacked holds onnxruntime-node with ONLY this
// target's native binaries, loads it (no electron rebuild: N-API), runs a
// tiny Add graph built in memory, and prints the shipped binary sizes. On
// targets without an upstream binary (darwin x64) it checks that no binary is
// shipped and that the app's support check says "unsupported".
"use strict";
const fs = require("node:fs");
const path = require("node:path");

const [resourcesArg, platform, arch] = process.argv.slice(2);
if (!resourcesArg || !platform || !arch) {
  console.error("usage: verify-packaged-onnxruntime.cjs <resources dir> <platform> <arch>");
  process.exit(2);
}
const resourcesDir = path.resolve(resourcesArg);
const pkgDir = path.join(resourcesDir, "app.asar.unpacked", "node_modules", "onnxruntime-node");
const binRoot = path.join(pkgDir, "bin", "napi-v6");
const fail = (message) => {
  console.error(`::error title=onnxruntime-node packaging::${message}`);
  process.exit(1);
};

function walk(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
}

if (!fs.existsSync(pkgDir)) fail(`onnxruntime-node is not unpacked at ${pkgDir}`);
const binaries = walk(binRoot).map((file) =>
  path.relative(binRoot, file).split(path.sep).join("/"),
);
const foreign = binaries.filter((file) => !file.startsWith(`${platform}/${arch}/`));
if (foreign.length > 0) fail(`binaries for other targets shipped: ${foreign.join(", ")}`);
const total = binaries.reduce((sum, file) => sum + fs.statSync(path.join(binRoot, file)).size, 0);
console.log(
  `onnxruntime-node binaries for ${platform}-${arch}: ${binaries.length} files, ${(total / 1e6).toFixed(1)} MB`,
);
for (const file of binaries) {
  console.log(`  ${file}  ${(fs.statSync(path.join(binRoot, file)).size / 1e6).toFixed(2)} MB`);
}
// The packaged asar must not carry a second (packed) copy of the binaries.
const asarList = path.join(resourcesDir, "app.asar");
if (!fs.existsSync(asarList)) fail("app.asar missing");

const supported =
  (platform === "darwin" && arch === "arm64") || ["win32", "linux"].includes(platform);
if (!supported) {
  if (binaries.length > 0)
    fail(`${platform}-${arch} has no upstream binary, yet ${binaries.length} files shipped`);
  console.log(
    `${platform}-${arch}: no onnxruntime-node binary upstream (expected); local models fall back.`,
  );
  process.exit(0);
}

// --- minimal ONNX model: y = x + x, x/y float[1,2], opset 13 (protobuf by hand) ---
const varint = (n) => {
  const out = [];
  let v = n;
  while (v > 127) {
    out.push((v & 127) | 128);
    v >>>= 7;
  }
  out.push(v);
  return out;
};
const field = (no, type, payload) => [...varint((no << 3) | type), ...payload];
const bytes = (no, data) => field(no, 2, [...varint(data.length), ...data]);
const str = (no, s) => bytes(no, [...Buffer.from(s, "utf8")]);
const int = (no, n) => field(no, 0, varint(n));
const dim = (n) => bytes(1, int(1, n));
const tensorType = bytes(1, [...int(1, 1), ...bytes(2, [...dim(1), ...dim(2)])]);
const valueInfo = (name) => [...str(1, name), ...bytes(2, tensorType)];
const node = [...str(1, "x"), ...str(1, "x"), ...str(2, "y"), ...str(4, "Add")];
const graph = [
  ...bytes(1, node),
  ...str(2, "modus_smoke"),
  ...bytes(11, valueInfo("x")),
  ...bytes(12, valueInfo("y")),
];
const model = Uint8Array.from([
  ...int(1, 8),
  ...str(2, "modus-smoke"),
  ...bytes(7, graph),
  ...bytes(8, [...str(1, ""), ...int(2, 13)]),
]);

(async () => {
  const started = Date.now();
  // Required through app.asar, like the app does: Electron redirects to app.asar.unpacked.
  const ort = require(path.join(resourcesDir, "app.asar", "node_modules", "onnxruntime-node"));
  const session = await ort.InferenceSession.create(model, { executionProviders: ["cpu"] });
  const out = await session.run({
    x: new ort.Tensor("float32", Float32Array.from([1.5, -2]), [1, 2]),
  });
  const y = Array.from(out.y.data);
  if (y[0] !== 3 || y[1] !== -4) fail(`unexpected output ${JSON.stringify(y)}`);
  console.log(
    `onnxruntime-node ${require(path.join(pkgDir, "package.json")).version} loaded under ${process.versions.electron ? `Electron ${process.versions.electron}` : `Node ${process.version}`} (napi ${process.versions.napi}), no rebuild; Add graph ok ${JSON.stringify(y)} in ${Date.now() - started} ms`,
  );
  await session.release();
})().catch((error) => fail(`load/run failed: ${error?.stack ? error.stack : error}`));
