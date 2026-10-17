import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cosine, loadLocalEmbedder } from "./embedder";
import { RERANK03_MODEL } from "./manifest";
import { verifyModelFiles } from "./model-download";
import { loadOnnxRuntime } from "./onnx-runtime";
import { loadLocalTokenizer } from "./tokenizer";

/**
 * Parity with the RERANK-03 PoC (thx01-poc/rerank, r3_final through
 * @huggingface/transformers + onnxruntime-node). The reference vectors are
 * committed; the 390 MB weights are not, so this runs only when
 * MODUS_RERANK03_DIR points at a directory holding the release files.
 */
const dir = process.env.MODUS_RERANK03_DIR;
const reference = JSON.parse(
  readFileSync(
    join(__dirname, "../../../test-support/local-models/rerank03-poc-reference.json"),
    "utf8",
  ),
) as { dims: number; samples: { text: string; maxLen: number; ids: number[]; vector: number[] }[] };

describe.skipIf(!dir)("RERANK-03 embedding parity with the PoC", () => {
  it("the ONNX file + tokenizer files are enough, and match the PoC", async () => {
    const modelDir = dir as string;
    await verifyModelFiles(RERANK03_MODEL, modelDir);
    const tokenizer = await loadLocalTokenizer(modelDir);
    const embedder = await loadLocalEmbedder(await loadOnnxRuntime(), modelDir);
    const report: { tokens: number; cosine: number; maxAbs: number }[] = [];
    for (const sample of reference.samples) {
      expect(tokenizer.encode(sample.text, sample.maxLen)).toEqual(sample.ids);
      const vector = await embedder.embed(sample.text, sample.maxLen);
      expect(vector.length).toBe(reference.dims);
      const expected = Float32Array.from(sample.vector);
      let maxAbs = 0;
      for (let index = 0; index < vector.length; index++) {
        maxAbs = Math.max(maxAbs, Math.abs((vector[index] ?? 0) - (expected[index] ?? 0)));
      }
      report.push({ tokens: sample.ids.length, cosine: cosine(vector, expected), maxAbs });
      expect(maxAbs).toBeLessThan(1e-5);
    }
    console.log("[rerank03 parity]", JSON.stringify(report));
    await embedder.release();
  }, 120_000);
});
