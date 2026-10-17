/**
 * Entry of the tool-filter model process (Electron utilityProcess; also runs
 * under a plain Node child_process.fork in tests). It owns onnxruntime-node, the
 * tokenizer and the RERANK-03 session, so their memory (~550 MB) and any native
 * crash stay out of the main process. One request at a time is the main side's
 * contract; this side still answers every message it gets.
 */
import { cosine, type LocalEmbedder, loadLocalEmbedder } from "./embedder";
import { LocalModelError, localModelFailureOf } from "./errors";
import { RERANK03_MODEL } from "./manifest";
import { loadOnnxRuntime } from "./onnx-runtime";
import {
  type MainToWorker,
  tinyAddModel,
  type WorkerDoc,
  type WorkerToMain,
} from "./worker-protocol";

type Port = {
  post(message: WorkerToMain): void;
  listen(handler: (message: MainToWorker) => void): void;
};

function resolvePort(): Port {
  const parentPort = (
    process as NodeJS.Process & {
      parentPort?: {
        postMessage(message: unknown): void;
        on(event: "message", handler: (event: { data: unknown }) => void): void;
      };
    }
  ).parentPort;
  if (parentPort) {
    return {
      post: (message) => parentPort.postMessage(message),
      listen: (handler) => parentPort.on("message", (event) => handler(event.data as MainToWorker)),
    };
  }
  if (process.send) {
    const send = process.send.bind(process);
    return {
      post: (message) => send(message),
      listen: (handler) => process.on("message", (message) => handler(message as MainToWorker)),
    };
  }
  throw new Error("tool-filter-worker must run as a utility or forked process");
}

export function createWorkerHandler(post: (message: WorkerToMain) => void) {
  let embedder: LocalEmbedder | null = null;
  const docVectors = new Map<string, Float32Array>();
  const rss = () => process.memoryUsage().rss;

  async function embedDocs(docs: readonly WorkerDoc[]): Promise<number> {
    const model = embedder;
    if (!model) throw new LocalModelError("not-ready", "Model not loaded");
    let added = 0;
    for (const { doc } of docs) {
      if (docVectors.has(doc)) continue;
      docVectors.set(doc, await model.embed(doc, RERANK03_MODEL.docMaxLength));
      added++;
    }
    return added;
  }

  return async function handle(message: MainToWorker): Promise<void> {
    try {
      switch (message.type) {
        case "ping":
          post({ type: "pong", id: message.id });
          return;
        case "stats":
          post({ type: "ok", id: message.id, rssBytes: rss() });
          return;
        case "probe": {
          const ort = await loadOnnxRuntime();
          let session: Awaited<ReturnType<typeof ort.InferenceSession.create>>;
          try {
            session = await ort.InferenceSession.create(tinyAddModel(), {
              executionProviders: ["cpu"],
            });
          } catch (error) {
            throw new LocalModelError("load-failed", "onnxruntime probe session failed", {
              cause: error,
            });
          }
          const out = await session.run({
            x: new ort.Tensor("float32", Float32Array.from([1.5, -2]), [1, 2]),
          });
          await session.release();
          const y = Array.from((out.y?.data ?? []) as Float32Array);
          if (y[0] !== 3 || y[1] !== -4) {
            throw new LocalModelError("load-failed", `probe graph returned ${JSON.stringify(y)}`);
          }
          post({ type: "ok", id: message.id, rssBytes: rss() });
          return;
        }
        case "load": {
          const started = performance.now();
          if (!embedder) {
            const ort = await loadOnnxRuntime();
            try {
              embedder = await loadLocalEmbedder(ort, message.dir);
            } catch (error) {
              throw error instanceof LocalModelError
                ? error
                : new LocalModelError("load-failed", "RERANK-03 failed to load", { cause: error });
            }
            await embedder.embed("warm-up: list the files in src", RERANK03_MODEL.queryMaxLength);
          }
          post({
            type: "ok",
            id: message.id,
            rssBytes: rss(),
            loadMs: Math.round(performance.now() - started),
          });
          return;
        }
        case "warm":
          await embedDocs(message.docs);
          post({ type: "ok", id: message.id, rssBytes: rss() });
          return;
        case "select": {
          const started = performance.now();
          const model = embedder;
          if (!model) throw new LocalModelError("not-ready", "Model not loaded");
          const missing = message.docs.filter(({ doc }) => !docVectors.has(doc));
          if (missing.length > 0) {
            post({
              type: "select",
              id: message.id,
              status: "not-ready",
              inProcessMs: performance.now() - started,
              rssBytes: rss(),
            });
            // Embed them now (outside any selection), so the next request is filtered.
            await embedDocs(missing).catch(() => undefined);
            return;
          }
          const query = await model.embed(message.query, RERANK03_MODEL.queryMaxLength);
          const ranked = message.docs
            .map(({ name, doc }, index) => ({
              name,
              index,
              score: cosine(query, docVectors.get(doc) as Float32Array),
            }))
            .sort((a, b) => b.score - a.score || a.index - b.index)
            .slice(0, Math.max(0, message.k));
          const inProcessMs = performance.now() - started;
          post(
            inProcessMs > message.budgetMs
              ? { type: "select", id: message.id, status: "timeout", inProcessMs, rssBytes: rss() }
              : {
                  type: "select",
                  id: message.id,
                  status: "ok",
                  names: ranked.map(({ name }) => name),
                  inProcessMs,
                  rssBytes: rss(),
                },
          );
          return;
        }
      }
    } catch (error) {
      post({
        type: "error",
        id: message.id,
        code: localModelFailureOf(error),
        message: error instanceof Error ? error.message : String(error),
      });
    }
  };
}

if (process.env.MODUS_TOOL_FILTER_WORKER === "1") {
  const port = resolvePort();
  const handle = createWorkerHandler(port.post);
  port.listen((message) => {
    void handle(message);
  });
}
