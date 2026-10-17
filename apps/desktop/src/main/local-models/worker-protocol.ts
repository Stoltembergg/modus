/**
 * Messages between main and the tool-filter model process (an Electron
 * utilityProcess running tool-filter-worker.ts). Plain structured-clone data.
 */
import type { LocalModelFailure } from "./errors";

export type WorkerDoc = { name: string; doc: string };

export type MainToWorker =
  /** Load onnxruntime-node and run a tiny in-memory graph: the real availability probe. */
  | { type: "probe"; id: number }
  | { type: "load"; id: number; dir: string }
  /** Embed tool docs ahead of time so a selection only embeds the query. */
  | { type: "warm"; id: number; docs: WorkerDoc[] }
  /**
   * Rank `docs` for `query`; reply with the top `k` names (ties keep input order).
   * `budgetMs` is measured inside the model process: over budget = "timeout".
   */
  | { type: "select"; id: number; query: string; docs: WorkerDoc[]; k: number; budgetMs: number }
  | { type: "ping"; id: number }
  | { type: "stats"; id: number };

export type SelectReply =
  | { status: "ok"; names: string[]; inProcessMs: number }
  /** Some doc was not embedded yet: the worker embeds it now, the caller falls back. */
  | { status: "not-ready"; inProcessMs: number }
  | { status: "timeout"; inProcessMs: number };

export type WorkerToMain =
  | { type: "ok"; id: number; rssBytes: number; loadMs?: number }
  | ({ type: "select"; id: number; rssBytes: number } & SelectReply)
  | { type: "pong"; id: number }
  | { type: "error"; id: number; code: LocalModelFailure; message: string };

/** Minimal ONNX model (y = x + x, float[1,2], opset 13) encoded by hand: no file needed. */
export function tinyAddModel(): Uint8Array {
  const varint = (n: number): number[] => {
    const out: number[] = [];
    let v = n;
    while (v > 127) {
      out.push((v & 127) | 128);
      v >>>= 7;
    }
    out.push(v);
    return out;
  };
  const bytes = (field: number, data: number[]): number[] => [
    (field << 3) | 2,
    ...varint(data.length),
    ...data,
  ];
  const str = (field: number, text: string): number[] => bytes(field, [...Buffer.from(text)]);
  const int = (field: number, value: number): number[] => [field << 3, ...varint(value)];
  const dim = (value: number): number[] => bytes(1, int(1, value));
  const valueInfo = (name: string): number[] => [
    ...str(1, name),
    ...bytes(2, bytes(1, [...int(1, 1), ...bytes(2, [...dim(1), ...dim(2)])])),
  ];
  const node = [...str(1, "x"), ...str(1, "x"), ...str(2, "y"), ...str(4, "Add")];
  const graph = [
    ...bytes(1, node),
    ...str(2, "g"),
    ...bytes(11, valueInfo("x")),
    ...bytes(12, valueInfo("y")),
  ];
  return Uint8Array.from([
    ...int(1, 7),
    ...str(2, "modus-probe"),
    ...bytes(7, graph),
    ...bytes(8, [...str(1, ""), ...int(2, 13)]),
  ]);
}
