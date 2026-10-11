import { describe, expect, it } from "vitest";
import { BUILT_IN_PLUGIN_ENTRIES, HostPluginCatalog } from "./plugin-catalog";
import { TestPluginCatalog } from "./plugin-test-catalog";
import { memoryPluginManifest } from "./plugins/memory-plugin";

describe("HostPluginCatalog", () => {
  it("exports built-in catalog entries as metadata-only descriptors", () => {
    expect(BUILT_IN_PLUGIN_ENTRIES.length).toBeGreaterThan(0);
    for (const entry of BUILT_IN_PLUGIN_ENTRIES) {
      expect(entry.manifest).not.toHaveProperty("lifecycle");
      for (const provision of entry.manifest.provides) {
        expect(provision).not.toHaveProperty("implementation");
      }
      expect(JSON.stringify(entry)).not.toContain("execute");
    }
  });

  it("authorizes only the exact manifest object", () => {
    const catalog = new HostPluginCatalog([
      { manifest: memoryPluginManifest, trustLevel: "official" },
    ]);
    expect(catalog.authorize(memoryPluginManifest)?.trustLevel).toBe("official");
    expect(catalog.authorize({ ...memoryPluginManifest })).toBeUndefined();
  });

  it("returns metadata-only entries from the public catalog methods", () => {
    const catalog = new HostPluginCatalog([
      { manifest: memoryPluginManifest, trustLevel: "official" },
    ]);

    for (const entry of [
      catalog.authorize(memoryPluginManifest),
      catalog.resolve(memoryPluginManifest.id, memoryPluginManifest.version),
      catalog.resolveById(memoryPluginManifest.id),
    ]) {
      expect(entry).toBeDefined();
      expect(entry).not.toHaveProperty("sourceManifest");
      expect(entry?.manifest).not.toHaveProperty("lifecycle");
      expect(entry?.manifest.provides[0]).not.toHaveProperty("implementation");
      expect(
        Object.values(entry?.manifest ?? {}).some((value) => typeof value === "function"),
      ).toBe(false);
    }
  });

  it("freezes the trusted manifest graph after the catalog captures its identity", () => {
    const sourceProvision = memoryPluginManifest.provides[0];
    if (!sourceProvision) throw new Error("Memory fixture has no capability provision");
    const sourceImplementation = sourceProvision.implementation;
    if (!sourceImplementation) throw new Error("Memory fixture has no implementation");
    const originalExecute = sourceImplementation.execute;
    const manifest = {
      ...memoryPluginManifest,
      id: "@test/frozen-catalog-manifest",
      provides: [
        {
          ...sourceProvision,
          capability: "catalog.fixture",
          implementation: { execute: originalExecute },
        },
      ],
    };
    const provision = manifest.provides[0];
    if (!provision?.implementation)
      throw new Error("Catalog fixture has no capability implementation");
    const implementation = provision.implementation;
    const catalog = new HostPluginCatalog([{ manifest, trustLevel: "core" }]);
    const replacement = () => "changed after authorization";

    expect("entries" in catalog).toBe(false);
    expect(Object.isFrozen(manifest)).toBe(true);
    expect(Object.isFrozen(manifest.provides)).toBe(true);
    expect(Object.isFrozen(implementation)).toBe(true);
    expect(() => {
      implementation.execute = replacement;
    }).toThrow();
    expect(implementation.execute).toBe(originalExecute);
    expect(catalog.authorize(manifest)?.manifest.provides[0]).not.toHaveProperty("implementation");
    expect(catalog.resolve(manifest.id, manifest.version)?.manifest).not.toHaveProperty(
      "lifecycle",
    );
  });

  it("resolves host-owned trust rather than serialized manifest trust", () => {
    const testCatalog = new TestPluginCatalog();
    testCatalog.add(memoryPluginManifest, "official");
    expect(
      testCatalog.resolve(memoryPluginManifest.id, memoryPluginManifest.version)?.trustLevel,
    ).toBe("official");
  });

  it("rejects duplicate id and version keys", () => {
    expect(
      () =>
        new HostPluginCatalog([
          { manifest: memoryPluginManifest, trustLevel: "core" },
          { manifest: memoryPluginManifest, trustLevel: "official" },
        ]),
    ).toThrow(/Duplicate host plugin catalog entry/);
  });
});
