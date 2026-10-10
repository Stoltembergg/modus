import { ModusNativeSubagentProvider } from "./modus-native-provider";
import type { SubagentProvider } from "./subagent-provider";

/**
 * SubagentProviderRegistry
 * Central registry for subagent providers with default fallback to ModusNativeSubagentProvider.
 */
export class SubagentProviderRegistry {
  private static instance: SubagentProviderRegistry | null = null;
  private providers = new Map<string, SubagentProvider>();
  private defaultProviderName = "modus-native";

  private constructor() {
    this.register(new ModusNativeSubagentProvider());
  }

  static getInstance(): SubagentProviderRegistry {
    if (!this.instance) {
      this.instance = new SubagentProviderRegistry();
    }
    return this.instance;
  }

  static resetInstance(): void {
    this.instance = null;
  }

  register(provider: SubagentProvider): void {
    this.providers.set(provider.name, provider);
  }

  registerProvider(provider: SubagentProvider): void {
    this.register(provider);
  }

  hasProvider(name: string): boolean {
    return this.providers.has(name);
  }

  unregister(name: string): boolean {
    if (name === "modus-native") {
      return false; // Prevent removing the default baseline provider
    }
    return this.providers.delete(name);
  }

  getProvider(name: string): SubagentProvider | undefined {
    return this.providers.get(name);
  }

  getDefaultProvider(): SubagentProvider {
    return this.providers.get(this.defaultProviderName) ?? new ModusNativeSubagentProvider();
  }

  setDefaultProvider(name: string): boolean {
    if (this.providers.has(name)) {
      this.defaultProviderName = name;
      return true;
    }
    return false;
  }

  listProviders(): string[] {
    return Array.from(this.providers.keys());
  }
}
