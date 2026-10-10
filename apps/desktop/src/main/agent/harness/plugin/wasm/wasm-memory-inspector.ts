/**
 * Reads the core WebAssembly binary sections needed to account for linear memory.
 * Compilation is still performed by the WebAssembly engine; unsupported memory
 * encodings are rejected here so the host never instantiates an unaccounted memory.
 */

export interface WasmMemoryDeclaration {
  initialPages: number;
  maximumPages?: number;
  imported: boolean;
  importModule?: string;
  importName?: string;
  exportName?: string;
}

class BinaryReader {
  private offset = 0;

  constructor(private readonly bytes: Uint8Array) {}

  public get remaining(): number {
    return this.bytes.length - this.offset;
  }

  public readByte(): number {
    if (this.offset >= this.bytes.length) {
      throw new Error("Unexpected end of WebAssembly binary");
    }
    return this.bytes[this.offset++] ?? 0;
  }

  public readU32(): number {
    let value = 0;
    for (let index = 0; index < 5; index += 1) {
      const byte = this.readByte();
      if (index === 4 && (byte & 0xf0) !== 0) {
        throw new Error("WebAssembly integer exceeds the supported 32-bit encoding");
      }
      value |= (byte & 0x7f) << (index * 7);
      if ((byte & 0x80) === 0) {
        return value >>> 0;
      }
    }
    throw new Error("Invalid WebAssembly integer encoding");
  }

  public readName(): string {
    const length = this.readU32();
    if (length > this.remaining) {
      throw new Error("Invalid WebAssembly name length");
    }
    const name = new TextDecoder("utf-8", { fatal: true }).decode(
      this.bytes.subarray(this.offset, this.offset + length),
    );
    this.offset += length;
    return name;
  }

  public readSubReader(length: number): BinaryReader {
    if (length > this.remaining) {
      throw new Error("Invalid WebAssembly section length");
    }
    const reader = new BinaryReader(this.bytes.subarray(this.offset, this.offset + length));
    this.offset += length;
    return reader;
  }

  public skip(length: number): void {
    if (!Number.isSafeInteger(length) || length < 0 || length > this.remaining) {
      throw new Error("Invalid WebAssembly field length");
    }
    this.offset += length;
  }
}

function readLimits(reader: BinaryReader): { initialPages: number; maximumPages?: number } {
  const flags = reader.readU32();
  if (flags !== 0 && flags !== 1) {
    throw new Error("Shared and memory64 linear memories are not supported by this host");
  }
  const initialPages = reader.readU32();
  if (flags === 0) {
    return { initialPages };
  }
  return { initialPages, maximumPages: reader.readU32() };
}

function skipValueType(reader: BinaryReader): void {
  const valueType = reader.readByte();
  if (
    valueType === 0x7f ||
    valueType === 0x7e ||
    valueType === 0x7d ||
    valueType === 0x7c ||
    valueType === 0x7b ||
    valueType === 0x70 ||
    valueType === 0x6f
  ) {
    return;
  }
  throw new Error("Unsupported WebAssembly reference type in import section");
}

function parseImportSection(reader: BinaryReader, memories: WasmMemoryDeclaration[]): void {
  const importCount = reader.readU32();
  if (importCount > 100_000) {
    throw new Error("WebAssembly import count exceeds host inspection limits");
  }

  for (let index = 0; index < importCount; index += 1) {
    const moduleName = reader.readName();
    const importName = reader.readName();
    const kind = reader.readByte();

    switch (kind) {
      case 0:
        reader.readU32();
        break;
      case 1:
        skipValueType(reader);
        readLimits(reader);
        break;
      case 2: {
        const limits = readLimits(reader);
        memories.push({ ...limits, imported: true, importModule: moduleName, importName });
        break;
      }
      case 3:
        skipValueType(reader);
        reader.readByte();
        break;
      case 4:
        reader.readByte();
        reader.readU32();
        break;
      default:
        throw new Error(`Unsupported WebAssembly import kind: ${kind}`);
    }
  }
  if (reader.remaining !== 0) {
    throw new Error("Invalid trailing bytes in WebAssembly import section");
  }
}

function parseMemorySection(reader: BinaryReader, memories: WasmMemoryDeclaration[]): void {
  const memoryCount = reader.readU32();
  if (memoryCount > 100_000) {
    throw new Error("WebAssembly memory count exceeds host inspection limits");
  }
  for (let index = 0; index < memoryCount; index += 1) {
    memories.push({ ...readLimits(reader), imported: false });
  }
  if (reader.remaining !== 0) {
    throw new Error("Invalid trailing bytes in WebAssembly memory section");
  }
}

function parseExportSection(reader: BinaryReader, memories: WasmMemoryDeclaration[]): void {
  const exportCount = reader.readU32();
  if (exportCount > 100_000) {
    throw new Error("WebAssembly export count exceeds host inspection limits");
  }
  for (let index = 0; index < exportCount; index += 1) {
    const name = reader.readName();
    const kind = reader.readByte();
    const itemIndex = reader.readU32();
    const memory = memories[itemIndex];
    if (kind === 2 && memory && memory.exportName === undefined) {
      memory.exportName = name;
    }
  }
  if (reader.remaining !== 0) {
    throw new Error("Invalid trailing bytes in WebAssembly export section");
  }
}

export function inspectWasmMemories(wasmBytes: Uint8Array): WasmMemoryDeclaration[] {
  if (
    wasmBytes.length < 8 ||
    wasmBytes[0] !== 0x00 ||
    wasmBytes[1] !== 0x61 ||
    wasmBytes[2] !== 0x73 ||
    wasmBytes[3] !== 0x6d ||
    wasmBytes[4] !== 0x01 ||
    wasmBytes[5] !== 0x00 ||
    wasmBytes[6] !== 0x00 ||
    wasmBytes[7] !== 0x00
  ) {
    throw new Error("Invalid core WebAssembly module header");
  }

  const reader = new BinaryReader(wasmBytes.subarray(8));
  const memories: WasmMemoryDeclaration[] = [];
  while (reader.remaining > 0) {
    const sectionId = reader.readByte();
    const section = reader.readSubReader(reader.readU32());
    if (sectionId === 2) {
      parseImportSection(section, memories);
    } else if (sectionId === 5) {
      parseMemorySection(section, memories);
    } else if (sectionId === 7) {
      parseExportSection(section, memories);
    }
  }
  return memories;
}
