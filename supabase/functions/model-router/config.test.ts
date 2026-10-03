import { assert, assertEquals, assertThrows } from "jsr:@std/assert@1";
import { ConfigError } from "../_shared/config.ts";
import { UPSTREAM_GROUPS, type UpstreamGroup } from "../_shared/model-catalog.ts";
import { env } from "../_shared/test-helpers.ts";
import {
  DEFAULT_MAX_DURATION_MS,
  HEADERS_TIMEOUT_MS,
  loadUpstreamBaseUrl,
  loadUpstreamKey,
  parseMaxDuration,
  SETTLE_BACKOFF_TOTAL_MS,
  SETTLE_RETRIES,
  SETTLE_RETRY_DELAY_MS,
  WALL_CLOCK_LIMIT_MS,
  WALL_CLOCK_MARGIN_MS,
} from "./config.ts";

Deno.test("upstream base URL: https only, default vibi", () => {
  assertEquals(loadUpstreamBaseUrl(env({})), "https://vibi.top/v1");
  assertEquals(
    loadUpstreamBaseUrl(env({ MODUS_UPSTREAM_BASE_URL: "https://x.example/v1/" })),
    "https://x.example/v1",
  );
  for (const base of [
    "http://vibi.top/v1",
    "",
    "not a url",
    "https://u:p@x.example/v1",
    "https://x.example/v1?a=1",
  ]) {
    assertThrows(() => loadUpstreamBaseUrl(env({ MODUS_UPSTREAM_BASE_URL: base })), ConfigError);
  }
});

Deno.test("upstream key: exactly the key of the model's group, never another group's", () => {
  const all = env({
    MODUS_UPSTREAM_KEY_CHINA: "k-china",
    MODUS_UPSTREAM_KEY_CLAUDE: "k-claude",
    MODUS_UPSTREAM_KEY_CODEX_PLUS: "k-plus",
    MODUS_UPSTREAM_KEY_CODEX_PRO: "k-pro",
  });
  assertEquals(loadUpstreamKey(all, "model - china"), "k-china");
  assertEquals(loadUpstreamKey(all, "claude"), "k-claude");
  assertEquals(loadUpstreamKey(all, "codex plus"), "k-plus");
  assertEquals(loadUpstreamKey(all, "codex pro"), "k-pro");
  const groups = Object.keys(UPSTREAM_GROUPS) as UpstreamGroup[];
  for (const group of groups) {
    // Every OTHER key set, this one missing / blank -> error naming this group's env var.
    const others = Object.fromEntries(
      groups.filter((g) => g !== group).map((g) => [UPSTREAM_GROUPS[g].envKey, `k-${g}`]),
    );
    assertThrows(
      () => loadUpstreamKey(env(others), group),
      ConfigError,
      UPSTREAM_GROUPS[group].envKey,
    );
    assertThrows(
      () => loadUpstreamKey(env({ ...others, [UPSTREAM_GROUPS[group].envKey]: "  " }), group),
      ConfigError,
    );
  }
  assertThrows(() => loadUpstreamKey(all, "auto" as UpstreamGroup), ConfigError);
});

Deno.test("max duration: default 120 s, cap + settle retries + margin < 150 s wall clock", () => {
  assertEquals(DEFAULT_MAX_DURATION_MS, 120_000);
  assertEquals(WALL_CLOCK_LIMIT_MS, 150_000);
  assertEquals([SETTLE_RETRIES, SETTLE_RETRY_DELAY_MS, SETTLE_BACKOFF_TOTAL_MS], [2, 200, 600]);
  assert(
    DEFAULT_MAX_DURATION_MS + SETTLE_BACKOFF_TOTAL_MS + WALL_CLOCK_MARGIN_MS < 150_000,
    "default cap + settle backoff + margin must fit the 150 s Free-plan wall clock",
  );
  assertEquals(parseMaxDuration(env({})), { maxDurationMs: 120_000, headersTimeoutMs: 60_000 });
  assertEquals(HEADERS_TIMEOUT_MS, 60_000);
  assertEquals(parseMaxDuration(env({ MODUS_ROUTER_MAX_DURATION_MS: "30000" })), {
    maxDurationMs: 30_000,
    headersTimeoutMs: 30_000,
  });
  const largest = WALL_CLOCK_LIMIT_MS - SETTLE_BACKOFF_TOTAL_MS - WALL_CLOCK_MARGIN_MS - 1;
  assertEquals(
    parseMaxDuration(env({ MODUS_ROUTER_MAX_DURATION_MS: String(largest) })).maxDurationMs,
    largest,
  );
  for (const bad of [
    "",
    " ",
    "0",
    "-1",
    "1.5",
    "1e5",
    "abc",
    "Infinity",
    "NaN",
    " 1000",
    "0100",
    "600000",
    "150000",
    String(largest + 1),
  ]) {
    assertThrows(
      () => parseMaxDuration(env({ MODUS_ROUTER_MAX_DURATION_MS: bad })),
      ConfigError,
      undefined,
      JSON.stringify(bad),
    );
  }
});

Deno.test("no code references the old single upstream key", async () => {
  const old = ["MODUS", "UPSTREAM", "API", "KEY"].join("_");
  const root = new URL("../../", import.meta.url); // supabase/
  const hits: string[] = [];
  async function walk(dir: URL) {
    for await (const entry of Deno.readDir(dir)) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const url = new URL(entry.name + (entry.isDirectory ? "/" : ""), dir);
      if (entry.isDirectory) await walk(url);
      else if (/\.(ts|sql|sh|toml|json|md)$/.test(entry.name)) {
        if ((await Deno.readTextFile(url)).includes(old)) hits.push(url.pathname);
      }
    }
  }
  await walk(root);
  const workflows = new URL("../.github/workflows/", root);
  try {
    await walk(workflows);
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  assertEquals(hits, []);
});
