import { join } from "node:path";
import { LocalModelError } from "./errors";
import { createOnnxSession, type OnnxRuntime, type OnnxSession } from "./onnx-runtime";
import { type LocalTokenizer, loadLocalTokenizer } from "./tokenizer";

/**
 * Bi-encoder embeddings (granite-r3): one text per run, CLS pooling (the first
 * token of `last_hidden_state`), L2-normalised, no query/doc prefixes. Same
 * recipe as the RERANK-03 PoC (thx01-poc/rerank/node/eval_r3.mjs).
 */
export type LocalEmbedder = {
  embed(text: string, maxLength: number): Promise<Float32Array>;
  release(): Promise<void>;
};

export function createLocalEmbedder(
  ort: OnnxRuntime,
  session: OnnxSession,
  tokenizer: LocalTokenizer,
): LocalEmbedder {
  return {
    async embed(text, maxLength) {
      const ids = tokenizer.encode(text, maxLength);
      const inputIds = BigInt64Array.from(ids, (id) => BigInt(id));
      const mask = new BigInt64Array(ids.length).fill(1n);
      let output: Record<string, { dims: readonly number[]; data: unknown }>;
      try {
        output = (await session.run({
          input_ids: new ort.Tensor("int64", inputIds, [1, ids.length]),
          attention_mask: new ort.Tensor("int64", mask, [1, ids.length]),
        })) as typeof output;
      } catch (error) {
        throw new LocalModelError("inference-failed", "Embedding run failed", { cause: error });
      }
      const hidden = output.last_hidden_state;
      const width = hidden?.dims[2];
      if (!hidden || !width || !(hidden.data instanceof Float32Array)) {
        throw new LocalModelError("inference-failed", "Model output has no last_hidden_state");
      }
      const vector = hidden.data.slice(0, width);
      let norm = 0;
      for (const value of vector) norm += value * value;
      norm = Math.sqrt(norm) || 1;
      for (let index = 0; index < vector.length; index++) vector[index] = (vector[index] ?? 0) / norm;
      return vector;
    },
    release: () => session.release(),
  };
}

export async function loadLocalEmbedder(ort: OnnxRuntime, dir: string): Promise<LocalEmbedder> {
  const [session, tokenizer] = await Promise.all([
    createOnnxSession(ort, join(dir, "model.onnx")),
    loadLocalTokenizer(dir),
  ]);
  return createLocalEmbedder(ort, session, tokenizer);
}

export function cosine(a: Float32Array, b: Float32Array): number {
  let total = 0;
  for (let index = 0; index < a.length; index++) total += (a[index] ?? 0) * (b[index] ?? 0);
  return total;
}
