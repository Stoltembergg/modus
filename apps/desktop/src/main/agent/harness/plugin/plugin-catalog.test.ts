import { describe, expect, it } from 'vitest';
import { HostPluginCatalog } from './plugin-catalog';
import { TestPluginCatalog } from './plugin-test-catalog';
import { memoryPluginManifest } from './plugins/memory-plugin';

describe('HostPluginCatalog', () => {
  it('authorizes only the exact manifest object', () => {
    const catalog = new HostPluginCatalog([{ manifest: memoryPluginManifest, trustLevel: 'official' }]);
    expect(catalog.authorize(memoryPluginManifest)?.trustLevel).toBe('official');
    expect(catalog.authorize({ ...memoryPluginManifest })).toBeUndefined();
  });

  it('resolves host-owned trust rather than serialized manifest trust', () => {
    const testCatalog = new TestPluginCatalog();
    testCatalog.add(memoryPluginManifest, 'official');
    expect(testCatalog.resolve(memoryPluginManifest.id, memoryPluginManifest.version)?.trustLevel).toBe('official');
  });

  it('rejects duplicate id and version keys', () => {
    expect(() => new HostPluginCatalog([
      { manifest: memoryPluginManifest, trustLevel: 'core' },
      { manifest: memoryPluginManifest, trustLevel: 'official' },
    ])).toThrow(/Duplicate host plugin catalog entry/);
  });
});
