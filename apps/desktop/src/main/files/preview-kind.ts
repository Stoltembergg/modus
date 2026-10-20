/**
 * Authoritative preview-kind detection from file bytes (magic / OOXML part peek).
 * Filename never participates in the decision.
 */

import { open } from "node:fs/promises";
import { relative, resolve } from "node:path";
import type { PreviewKind, PreviewReadResult } from "../../shared/contracts";
import { resolveWithin } from "./path-within";

/** Default cap for in-app preview payloads (50 MiB). */
export const DEFAULT_PREVIEW_MAX_BYTES = 50 * 1024 * 1024;

const SNIFF = 16_384;
const PREVIEW_READ_CHUNK_BYTES = 64 * 1024;

type PreviewReadHandle = {
  read(
    buffer: Buffer,
    offset: number,
    length: number,
    position: number,
  ): Promise<{ bytesRead: number }>;
};

const MIME_BY_KIND: Record<PreviewKind, string> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  image: "application/octet-stream",
  unsupported: "application/octet-stream",
};

function startsWith(buf: Buffer, bytes: number[]): boolean {
  if (buf.length < bytes.length) return false;
  return bytes.every((b, i) => buf[i] === b);
}

function asciiIncludes(buf: Buffer, needle: string, limit = SNIFF): boolean {
  const slice = buf.subarray(0, Math.min(buf.length, limit)).toString("latin1");
  return slice.includes(needle);
}

function imageMime(buf: Buffer): string {
  if (startsWith(buf, [0x89, 0x50, 0x4e, 0x47])) return "image/png";
  if (startsWith(buf, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith(buf, [0x47, 0x49, 0x46, 0x38])) return "image/gif";
  if (
    startsWith(buf, [0x52, 0x49, 0x46, 0x46]) &&
    buf.length >= 12 &&
    buf[8] === 0x57 &&
    buf[9] === 0x45 &&
    buf[10] === 0x42 &&
    buf[11] === 0x50
  ) {
    return "image/webp";
  }
  if (startsWith(buf, [0x42, 0x4d])) return "image/bmp";
  return "application/octet-stream";
}

/** Classify bytes for preview routing (magic / OOXML part peek only). */
export function detectPreviewKind(buffer: Buffer): PreviewKind {
  if (buffer.length >= 5 && buffer.subarray(0, 5).toString("ascii") === "%PDF-") {
    return "pdf";
  }
  if (imageMime(buffer) !== "application/octet-stream") {
    return "image";
  }
  // Legacy OLE Compound File (old .doc / .ppt / some .xls) — no high-fidelity free viewer.
  if (startsWith(buffer, [0xd0, 0xcf, 0x11, 0xe0])) {
    return "unsupported";
  }
  // OOXML packages are ZIPs; part names appear as plain strings in local headers.
  if (
    startsWith(buffer, [0x50, 0x4b, 0x03, 0x04]) ||
    startsWith(buffer, [0x50, 0x4b, 0x05, 0x06])
  ) {
    if (asciiIncludes(buffer, "word/")) return "docx";
    if (asciiIncludes(buffer, "xl/")) return "xlsx";
    if (asciiIncludes(buffer, "ppt/")) return "pptx";
    return "unsupported";
  }
  return "unsupported";
}

export function mimeForPreview(kind: PreviewKind, buffer: Buffer): string {
  if (kind === "image") return imageMime(buffer);
  return MIME_BY_KIND[kind];
}

export type ReadPreviewOptions = {
  maxBytes?: number;
};

/** Read from one already-open file, honoring short reads and enforcing the cap while reading. */
export async function readPreviewBytesFromHandle(
  handle: PreviewReadHandle,
  maxBytes: number,
): Promise<Buffer> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes >= Number.MAX_SAFE_INTEGER) {
    throw new Error("Invalid in-app preview size limit.");
  }

  const chunks: Buffer[] = [];
  let totalBytes = 0;
  while (true) {
    // Read one byte beyond the cap so growth after fstat cannot escape the limit.
    const buffer = Buffer.alloc(Math.min(PREVIEW_READ_CHUNK_BYTES, maxBytes + 1 - totalBytes));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, totalBytes);
    if (bytesRead === 0) break;
    totalBytes += bytesRead;
    if (totalBytes > maxBytes) {
      throw new Error(`File too large for in-app preview (limit ${maxBytes} bytes).`);
    }
    chunks.push(buffer.subarray(0, bytesRead));
  }
  return Buffer.concat(chunks, totalBytes);
}

/** Read workspace file bytes for in-app preview (separate from text `files.read`). */
export async function readWorkspacePreview(
  root: string,
  path: string,
  options: ReadPreviewOptions = {},
): Promise<PreviewReadResult> {
  const maxBytes = options.maxBytes ?? DEFAULT_PREVIEW_MAX_BYTES;
  const abs = resolveWithin(root, path);
  const handle = await open(abs, "r");
  let bytes: Buffer;
  try {
    const fileStat = await handle.stat();
    if (fileStat.isDirectory()) {
      throw new Error("Path is a directory, not a file.");
    }
    if (fileStat.size > maxBytes) {
      throw new Error(`File too large for in-app preview (limit ${maxBytes} bytes).`);
    }
    bytes = await readPreviewBytesFromHandle(handle, maxBytes);
  } finally {
    await handle.close();
  }

  const previewKind = detectPreviewKind(bytes);
  const relativePath = relative(resolve(root), abs).split(/[/\\]/).join("/");
  return {
    path: abs,
    relativePath,
    size: bytes.length,
    previewKind,
    mime: mimeForPreview(previewKind, bytes),
    bytes: new Uint8Array(bytes),
  };
}
