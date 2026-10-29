const fs = require("node:fs");
const path = require("node:path");

const PLATFORM_ARCHS = Object.freeze({
  darwin: ["arm64", "x64"],
  linux: ["arm64", "x64"],
  win32: ["arm64", "x64"],
});

function machOArchitectures(bytes) {
  if (bytes.length < 8) return [];
  const magic = bytes.subarray(0, 4).toString("hex");
  if (["cffaedfe", "cefaedfe", "feedfacf", "feedface"].includes(magic)) {
    const littleEndian = magic.startsWith("cf") || magic.startsWith("ce");
    return [cpuTypeName(littleEndian ? bytes.readUInt32LE(4) : bytes.readUInt32BE(4))].filter(
      Boolean,
    );
  }

  const fatFormats = {
    cafebabe: { littleEndian: false, stride: 20 },
    bebafeca: { littleEndian: true, stride: 20 },
    cafebabf: { littleEndian: false, stride: 32 },
    bfbafeca: { littleEndian: true, stride: 32 },
  };
  const format = fatFormats[magic];
  if (!format) return [];
  const readUInt32 = format.littleEndian
    ? bytes.readUInt32LE.bind(bytes)
    : bytes.readUInt32BE.bind(bytes);
  const count = readUInt32(4);
  if (count > 64 || 8 + count * format.stride > bytes.length) return [];
  const archs = [];
  for (let index = 0; index < count; index++) {
    const cpuType = readUInt32(8 + index * format.stride);
    const name = cpuTypeName(cpuType);
    if (name) archs.push(name);
  }
  return [...new Set(archs)];
}

function cpuTypeName(cpuType) {
  if (cpuType === 0x01000007) return "x64";
  if (cpuType === 0x0100000c) return "arm64";
  return undefined;
}

function elfArchitecture(bytes) {
  if (bytes.length < 20 || bytes.subarray(0, 4).toString("hex") !== "7f454c46") return [];
  const littleEndian = bytes[5] === 1;
  if (!littleEndian && bytes[5] !== 2) return [];
  const machine = littleEndian ? bytes.readUInt16LE(18) : bytes.readUInt16BE(18);
  if (machine === 62) return ["x64"];
  if (machine === 183) return ["arm64"];
  return [];
}

function peArchitecture(bytes) {
  if (bytes.length < 0x40 || bytes.subarray(0, 2).toString("ascii") !== "MZ") return [];
  const peOffset = bytes.readUInt32LE(0x3c);
  if (
    peOffset + 6 > bytes.length ||
    bytes.subarray(peOffset, peOffset + 4).toString("hex") !== "50450000"
  ) {
    return [];
  }
  const machine = bytes.readUInt16LE(peOffset + 4);
  if (machine === 0x8664) return ["x64"];
  if (machine === 0xaa64) return ["arm64"];
  return [];
}

function inspectArchitecture(bytes, platform) {
  if (platform === "darwin") return machOArchitectures(bytes);
  if (platform === "linux") return elfArchitecture(bytes);
  if (platform === "win32") return peArchitecture(bytes);
  return [];
}

function sidecarNames(platform) {
  const extension = platform === "win32" ? ".exe" : "";
  const names = ["modus-pty-host", "modus-rea-process-supervisor"];
  if (platform === "linux") {
    names.push("modus-plugin-execution-supervisor", "modus-plugin-worker");
  }
  return names.map((name) => `${name}${extension}`);
}

function verifyPackagedSidecars(
  resourcesPath,
  platform,
  arch,
  { readFile = fs.readFileSync } = {},
) {
  if (!PLATFORM_ARCHS[platform])
    throw new Error(`Unsupported packaged platform ${JSON.stringify(platform)}`);
  if (!PLATFORM_ARCHS[platform].includes(arch)) {
    throw new Error(`Unsupported ${platform} package architecture ${JSON.stringify(arch)}`);
  }
  const binDirectory = path.join(resourcesPath, "bin");
  const verified = [];
  for (const name of sidecarNames(platform)) {
    const filePath = path.join(binDirectory, name);
    if (!fs.existsSync(filePath)) throw new Error(`Packaged sidecar is missing: ${filePath}`);
    const architectures = inspectArchitecture(readFile(filePath), platform);
    if (!architectures.includes(arch)) {
      throw new Error(
        `Packaged sidecar architecture mismatch: ${filePath} has ${architectures.join(", ") || "unknown"}; expected ${arch}`,
      );
    }
    verified.push({ path: filePath, architectures });
  }
  return verified;
}

module.exports = { inspectArchitecture, verifyPackagedSidecars };

if (require.main === module) {
  const [, , resourcesPath, platform, arch] = process.argv;
  if (!resourcesPath || !platform || !arch) {
    console.error("usage: node verify-packaged-sidecars.cjs <resources dir> <platform> <arch>");
    process.exit(2);
  }
  const verified = verifyPackagedSidecars(resourcesPath, platform, arch);
  console.log(`Verified ${verified.length} packaged sidecars: ${platform}/${arch}`);
}
