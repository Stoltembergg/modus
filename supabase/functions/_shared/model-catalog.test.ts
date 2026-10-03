import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  groupRatioFor,
  MODEL_CATALOG,
  newApiPrice,
  PRICING_SNAPSHOT,
  SERVER_ONLY_MODELS,
  SNAPSHOT_GROUP_RATIOS,
} from "./model-catalog.ts";

const root = new URL("../../../", import.meta.url);
type NativeModel = {
  id: string;
  contextWindow: number;
  maxTokens: number;
  cost?: { tiers?: { inputTokensAbove: number }[] };
};
const catalog = JSON.parse(await Deno.readTextFile(new URL("catalog/models.json", root))) as {
  providers: Record<string, NativeModel[]>;
};

function native(id: string): NativeModel | undefined {
  const slash = id.indexOf("/");
  return catalog.providers[id.slice(0, slash)]?.find((m) => m.id === id.slice(slash + 1));
}

/** The Free (and any other) allowed_models arrays as the migrations leave them. */
async function seededAllowedModels(): Promise<string[]> {
  const dir = new URL("supabase/migrations/", root);
  const files = [...Deno.readDirSync(dir)]
    .map((e) => e.name)
    .filter((n) => n.endsWith(".sql"))
    .sort();
  const latest = new Map<string, string[]>();
  for (const name of files) {
    const sql = await Deno.readTextFile(new URL(name, dir));
    // B1 seed: ('free', 'Free', ..., array['a', 'b'], 0)
    for (const m of sql.matchAll(/\('([a-z_]+)',\s*'[^']*',[^\n]*\n?\s*array\[([^\]]*)\]/g)) {
      latest.set(
        m[1],
        [...m[2].matchAll(/'([^']+)'/g)].map((x) => x[1]),
      );
    }
    // Later migrations: update public.plans set allowed_models = array[...] where plan = 'x'
    for (const m of sql.matchAll(
      /set allowed_models = array\[([^\]]*)\]\s*where plan = '([a-z_]+)'/g,
    )) {
      latest.set(
        m[2],
        [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]),
      );
    }
  }
  return [...latest.values()].flat();
}

Deno.test("model table: ids, context and tiers match the native catalog/models.json entries", () => {
  for (const model of MODEL_CATALOG) {
    assertEquals(model.id, `${model.provider}/${model.id.slice(model.provider.length + 1)}`);
    if (SERVER_ONLY_MODELS.includes(model.id)) continue;
    const entry = native(model.id);
    assert(entry, `${model.id} has no native entry in catalog/models.json`);
    assertEquals(model.contextWindow, entry.contextWindow, `${model.id} contextWindow`);
    assertEquals(model.maxTokens, entry.maxTokens, `${model.id} maxTokens`);
    assertEquals(
      model.tier?.inputTokensAbove,
      entry.cost?.tiers?.[0]?.inputTokensAbove,
      `${model.id} tier threshold`,
    );
  }
});

Deno.test("SERVER_ONLY_MODELS: an entry that appears in catalog/models.json fails", () => {
  for (const id of SERVER_ONLY_MODELS) {
    assertEquals(
      native(id),
      undefined,
      `${id} is in catalog/models.json: remove it from SERVER_ONLY_MODELS`,
    );
    assert(
      MODEL_CATALOG.some((m) => m.id === id),
      `${id} is not in the model table`,
    );
  }
});

Deno.test("every seeded plans.allowed_models id is in the model table with a price", async () => {
  const seeded = await seededAllowedModels();
  assertEquals(seeded.sort(), ["deepseek/deepseek-flash", "zai/glm-5.3-flash"]);
  for (const id of seeded) {
    const model = MODEL_CATALOG.find((m) => m.id === id);
    assert(model, `${id} missing from the model table`);
    assert(model.cost.input > 0 && model.cost.output > 0, `${id} has no price`);
  }
});

Deno.test("groupRatio: pinned per model, >= 1.0, = max(1, highest ratio of enable_groups)", () => {
  const pinned: Record<string, number> = {
    "deepseek/deepseek-flash": 1.0,
    "zai/glm-5.3-flash": 1.0,
  };
  assertEquals(Object.fromEntries(MODEL_CATALOG.map((m) => [m.id, m.groupRatio])), pinned);
  for (const model of MODEL_CATALOG) {
    assert(model.groupRatio >= 1.0, `${model.id} groupRatio below 1.0`);
    assert(Number.isFinite(model.groupRatio), `${model.id} has a group missing from the snapshot`);
    assert(model.enableGroups.length > 0, `${model.id} has no enable_groups`);
    assertEquals(model.groupRatio, groupRatioFor(model.enableGroups), model.id);
  }
  assertEquals(SNAPSHOT_GROUP_RATIOS["model - china"], 0.8);
  assertEquals(groupRatioFor(["model - china"]), 1);
  assertEquals(groupRatioFor(["image - 4k", "auto"]), 5.5);
  assertEquals(
    groupRatioFor(["unknown group"]),
    Infinity,
    "an unknown group never prices below cost",
  );
});

Deno.test("prices: the vibi 2026-10-03 snapshot derived with the New API premise", () => {
  assertEquals(PRICING_SNAPSHOT.version, "vibi-2026-10-03");
  const byId = Object.fromEntries(MODEL_CATALOG.map((m) => [m.id, m]));
  assertEquals(byId["deepseek/deepseek-flash"].upstreamId, "deepseek-v4.1-flash");
  assertEquals(byId["deepseek/deepseek-flash"].cost, { input: 2.2, output: 8.5, cacheRead: 0.3 });
  assertEquals(byId["zai/glm-5.3-flash"].upstreamId, "glm-5.3-flash");
  assertEquals(byId["zai/glm-5.3-flash"].cost, { input: 1.2, output: 3.975, cacheRead: 0.4 });
  assertEquals(newApiPrice({ modelRatio: 1, completionRatio: 1, cacheRatio: 0.1, groupRatio: 1 }), {
    input: 2,
    output: 2,
    cacheRead: 0.2,
  });
  assertEquals(
    newApiPrice({ modelRatio: 1, completionRatio: 2, cacheRatio: 0.1, groupRatio: 1.5 }),
    { input: 3, output: 6, cacheRead: 0.3 },
  );
  assertEquals(MODEL_CATALOG.map((m) => m.id).sort(), [
    "deepseek/deepseek-flash",
    "zai/glm-5.3-flash",
  ]);
});

Deno.test("the router never fetches pricing at runtime", async () => {
  const dir = new URL("../model-router/", import.meta.url);
  const sources = [...Deno.readDirSync(dir)]
    .map((e) => e.name)
    .filter((n) => n.endsWith(".ts") && !n.includes(".test.") && !n.includes(".integration."));
  assert(sources.length >= 4);
  for (const name of [...sources.map((n) => `../model-router/${n}`), "./router-db.ts"]) {
    const code = await Deno.readTextFile(new URL(name, import.meta.url));
    assert(
      !/api\/pricing|pricing\.json|\/api\/status/i.test(code),
      `${name} references live pricing`,
    );
  }
  const table = await Deno.readTextFile(new URL("./model-catalog.ts", import.meta.url));
  assert(
    !/\bfetch\s*\(|Deno\.readTextFile|import\(/.test(table),
    "model-catalog.ts must be static data",
  );
});
