/**
 * @file dependency-graph.ts
 * Core Dependency Graph and Blast Radius Engine (Fase 14).
 * Maintains a live, directed graph of plugins, capabilities, and dependencies,
 * detecting circular dependencies, calculating blast radius, and visualizing dependency trees.
 */

import {
  type BlastRadius,
  type BlastRadiusSeverity,
  CircularDependencyError,
  type DependencyNode,
  type TransitiveDependent,
} from "./plugin-dependency-types";
import type { PluginManifest } from "./plugin-types";

export class DependencyGraph {
  private nodes = new Map<string, DependencyNode>();
  private capabilityProviders = new Map<string, string>(); // capability -> pluginId

  constructor() {}

  /**
   * Adds or updates a plugin node in the graph, linking dependencies and dependents.
   */
  public addPlugin(manifest: PluginManifest): void {
    const previousNode = this.nodes.get(manifest.id);
    const previousNodeSnapshot = previousNode
      ? {
          ...previousNode,
          provides: [...previousNode.provides],
          requiresCapabilities: [...previousNode.requiresCapabilities],
          requiresPlugins: [...previousNode.requiresPlugins],
          dependencies: [...previousNode.dependencies],
          dependents: [...previousNode.dependents],
        }
      : undefined;
    const previousCapabilityProviders = new Map(this.capabilityProviders);
    const provides = manifest.provides.map((p) => p.capability);
    const requiresCaps = (manifest.requires.capabilities ?? []).map((c) => c.capability);
    const requiresPlugins = manifest.requires.plugins ?? [];

    // Register capability provisions
    for (const cap of provides) {
      this.capabilityProviders.set(cap, manifest.id);
    }

    const node: DependencyNode = {
      pluginId: manifest.id,
      version: manifest.version,
      provides,
      requiresCapabilities: requiresCaps,
      requiresPlugins,
      dependencies: [],
      dependents: [],
    };

    this.nodes.set(manifest.id, node);
    this.recomputeAllLinks();

    const cycle = this.findCycles()[0];
    if (cycle) {
      if (previousNodeSnapshot) this.nodes.set(manifest.id, previousNodeSnapshot);
      else this.nodes.delete(manifest.id);
      this.capabilityProviders = previousCapabilityProviders;
      this.recomputeAllLinks();
      throw new CircularDependencyError(cycle);
    }
  }

  public assertCanAddPlugin(manifest: PluginManifest): void {
    const candidate = new DependencyGraph();
    candidate.nodes = new Map(
      Array.from(this.nodes, ([id, node]) => [
        id,
        {
          ...node,
          provides: [...node.provides],
          requiresCapabilities: [...node.requiresCapabilities],
          requiresPlugins: [...node.requiresPlugins],
          dependencies: [...node.dependencies],
          dependents: [...node.dependents],
        },
      ]),
    );
    candidate.capabilityProviders = new Map(this.capabilityProviders);
    candidate.addPlugin(manifest);
  }

  /**
   * Removes a plugin from the graph and cleans up dependent links.
   */
  public removePlugin(pluginId: string): void {
    const node = this.nodes.get(pluginId);
    if (!node) return;

    for (const cap of node.provides) {
      if (this.capabilityProviders.get(cap) === pluginId) {
        this.capabilityProviders.delete(cap);
      }
    }

    this.nodes.delete(pluginId);
    this.recomputeAllLinks();
  }

  public getPlugin(pluginId: string): DependencyNode | undefined {
    return this.nodes.get(pluginId);
  }

  public getAllPlugins(): DependencyNode[] {
    return Array.from(this.nodes.values());
  }

  /**
   * Clears and rebuilds the dependency graph from an array of manifests.
   */
  public rebuild(manifests: PluginManifest[]): void {
    this.nodes.clear();
    this.capabilityProviders.clear();

    for (const manifest of manifests) {
      const provides = manifest.provides.map((p) => p.capability);
      for (const cap of provides) {
        this.capabilityProviders.set(cap, manifest.id);
      }
      this.nodes.set(manifest.id, {
        pluginId: manifest.id,
        version: manifest.version,
        provides,
        requiresCapabilities: (manifest.requires.capabilities ?? []).map((c) => c.capability),
        requiresPlugins: manifest.requires.plugins ?? [],
        dependencies: [],
        dependents: [],
      });
    }

    this.recomputeAllLinks();
  }

  /**
   * Recomputes all incoming (dependents) and outgoing (dependencies) edges.
   */
  private recomputeAllLinks(): void {
    // Reset edges
    for (const node of this.nodes.values()) {
      node.dependencies = [];
      node.dependents = [];
    }

    for (const [id, node] of this.nodes.entries()) {
      const deps = new Set<string>();

      // Direct plugin requirements
      for (const reqPlugin of node.requiresPlugins) {
        if (this.nodes.has(reqPlugin)) {
          deps.add(reqPlugin);
        }
      }

      // Capability requirements mapped to provider plugins
      for (const reqCap of node.requiresCapabilities) {
        const providerId = this.capabilityProviders.get(reqCap);
        if (providerId && this.nodes.has(providerId)) {
          deps.add(providerId);
        }
      }

      node.dependencies = Array.from(deps);

      // Link reverse (dependents)
      for (const depId of node.dependencies) {
        const depNode = this.nodes.get(depId);
        if (depNode && !depNode.dependents.includes(id)) {
          depNode.dependents.push(id);
        }
      }
    }
  }

  /**
   * Calculates the full blast radius of modifying or removing a plugin.
   */
  public calculateBlastRadius(pluginId: string): BlastRadius {
    const node = this.nodes.get(pluginId);
    if (!node) {
      return {
        targetPluginId: pluginId,
        directDependents: [],
        transitiveDependents: [],
        totalAffected: 0,
        severity: "none",
        critical: false,
        message: `Plugin "${pluginId}" not found in dependency graph.`,
      };
    }

    const direct = [...node.dependents];
    const transitive: TransitiveDependent[] = [];
    const visited = new Set<string>([pluginId, ...direct]);

    // BFS for transitive dependents
    const queue: Array<{ id: string; path: string[] }> = direct.map((d) => ({
      id: d,
      path: [d],
    }));

    while (queue.length > 0) {
      const current = queue.shift()!;
      const currentNode = this.nodes.get(current.id);
      if (!currentNode) continue;

      for (const nextDep of currentNode.dependents) {
        if (!visited.has(nextDep)) {
          visited.add(nextDep);
          transitive.push({
            pluginId: nextDep,
            via: [...current.path],
          });
          queue.push({
            id: nextDep,
            path: [...current.path, nextDep],
          });
        }
      }
    }

    const totalAffected = direct.length + transitive.length;
    let severity: BlastRadiusSeverity = "none";

    if (totalAffected === 0) {
      severity = "none";
    } else if (totalAffected <= 2) {
      severity = "low";
    } else if (totalAffected <= 5) {
      severity = "medium";
    } else {
      severity = "high";
    }

    // Criticality check
    const isCritical = severity === "high" || direct.length > 0;

    let message = `Removing or updating "${pluginId}" affects ${totalAffected} plugin(s).`;
    if (direct.length > 0) {
      message += ` Direct dependents: ${direct.join(", ")}.`;
    }
    if (transitive.length > 0) {
      message += ` Transitive dependents: ${transitive.map((t) => `${t.pluginId} (via ${t.via.join("->")})`).join(", ")}.`;
    }

    return {
      targetPluginId: pluginId,
      directDependents: direct,
      transitiveDependents: transitive,
      totalAffected,
      severity,
      critical: isCritical,
      message,
    };
  }

  /**
   * Finds all circular dependencies within the graph using Tarjan's/DFS algorithm.
   */
  public findCycles(): string[][] {
    const cycles: string[][] = [];
    const visited = new Set<string>();
    const recStack = new Map<string, number>();
    const currentPath: string[] = [];

    const dfs = (pluginId: string) => {
      visited.add(pluginId);
      recStack.set(pluginId, currentPath.length);
      currentPath.push(pluginId);

      const node = this.nodes.get(pluginId);
      if (node) {
        for (const depId of node.dependencies) {
          if (!visited.has(depId)) {
            dfs(depId);
          } else if (recStack.has(depId)) {
            // Cycle detected!
            const startIndex = recStack.get(depId)!;
            const cycle = currentPath.slice(startIndex);
            cycle.push(depId);
            cycles.push(cycle);
          }
        }
      }

      currentPath.pop();
      recStack.delete(pluginId);
    };

    for (const pluginId of this.nodes.keys()) {
      if (!visited.has(pluginId)) {
        dfs(pluginId);
      }
    }

    return cycles;
  }

  public hasCycles(): boolean {
    return this.findCycles().length > 0;
  }

  /**
   * Produces a topological sort of the graph (dependencies appear before dependents).
   * Throws CircularDependencyError if any cycle is detected.
   */
  public topologicalSort(): string[] {
    const cycles = this.findCycles();
    if (cycles.length > 0 && cycles[0]) {
      throw new CircularDependencyError(cycles[0]);
    }

    const order: string[] = [];
    const visited = new Set<string>();

    const dfs = (id: string) => {
      visited.add(id);
      const node = this.nodes.get(id);
      if (node) {
        for (const dep of node.dependencies) {
          if (!visited.has(dep)) {
            dfs(dep);
          }
        }
      }
      order.push(id);
    };

    for (const id of this.nodes.keys()) {
      if (!visited.has(id)) {
        dfs(id);
      }
    }

    return order;
  }

  /**
   * Sorts the acyclic portion of the graph while excluding known quarantined
   * nodes. A cycle entirely inside the excluded set does not block unrelated
   * dependency chains from restoring or shutting down in order.
   */
  public topologicalSortExcluding(excludedPluginIds: ReadonlySet<string>): string[] {
    const remainingCycle = this.findCycles().find((cycle) =>
      cycle.every((pluginId) => !excludedPluginIds.has(pluginId)),
    );
    if (remainingCycle) throw new CircularDependencyError(remainingCycle);

    const order: string[] = [];
    const visited = new Set<string>();

    const visit = (pluginId: string): void => {
      if (visited.has(pluginId) || excludedPluginIds.has(pluginId)) return;
      visited.add(pluginId);
      const node = this.nodes.get(pluginId);
      for (const dependencyId of node?.dependencies ?? []) {
        visit(dependencyId);
      }
      order.push(pluginId);
    };

    for (const pluginId of this.nodes.keys()) visit(pluginId);
    return order;
  }

  /**
   * Generates a readable ASCII visualization of the dependency tree.
   */
  public visualize(): string {
    const lines: string[] = [];

    if (this.nodes.size === 0) {
      return "(empty dependency graph)";
    }

    for (const [id, node] of this.nodes.entries()) {
      lines.push(`${id}@${node.version}`);
      if (node.provides.length > 0) {
        lines.push(`  provides: ${node.provides.join(", ")}`);
      }
      if (node.dependencies.length > 0) {
        lines.push("  depends on:");
        for (const dep of node.dependencies) {
          lines.push(`    ↓ ${dep}`);
        }
      }
      if (node.dependents.length > 0) {
        lines.push("  required by:");
        for (const dep of node.dependents) {
          lines.push(`    ↑ ${dep}`);
        }
      }
      lines.push("");
    }

    return lines.join("\n").trimEnd();
  }
}
