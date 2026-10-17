import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Tokenizer } from "@huggingface/tokenizers";
import { LocalModelError } from "./errors";

/**
 * Tokenizer for the local embedding model, from tokenizer.json +
 * tokenizer_config.json alone (the RERANK-03 export has no config.json).
 *
 * Truncation matches the pipeline RERANK-03 was gated with (the PoC's
 * @huggingface/transformers.js `truncation: true`): the encoding WITH its
 * special tokens is cut to `maxLength`, so an over-long text loses its
 * trailing [SEP]. Python transformers would keep it; the eval numbers come
 * from the JS pipeline, so this follows the JS one (parity test).
 */
export type LocalTokenizer = {
  /** Token ids for one text, special tokens included, at most `maxLength` long. */
  encode(text: string, maxLength: number): number[];
};

export function createLocalTokenizer(tokenizerJson: unknown, tokenizerConfig: unknown): LocalTokenizer {
  const tokenizer = new Tokenizer(tokenizerJson as object, tokenizerConfig as object);
  return {
    encode(text, maxLength) {
      return tokenizer.encode(text, { add_special_tokens: true }).ids.slice(0, maxLength);
    },
  };
}

export async function loadLocalTokenizer(dir: string): Promise<LocalTokenizer> {
  try {
    const [json, config] = await Promise.all([
      readFile(join(dir, "tokenizer.json"), "utf8"),
      readFile(join(dir, "tokenizer_config.json"), "utf8"),
    ]);
    return createLocalTokenizer(JSON.parse(json), JSON.parse(config));
  } catch (error) {
    throw new LocalModelError("load-failed", "Unable to load the tokenizer", { cause: error });
  }
}
