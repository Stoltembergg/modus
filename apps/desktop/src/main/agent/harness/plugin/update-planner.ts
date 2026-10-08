/**
 * @file update-planner.ts
 * Topological Update Planner with Phase Parallelization (Fase 14).
 * Plans multi-plugin upgrades ensuring dependencies are upgraded before dependents,
 * grouping independent upgrades into parallel execution phases.
 */

import type { DependencyGraph } from './dependency-graph';
import type { PluginUpdate, UpdatePlan } from './plugin-dependency-types';

export class UpdatePlanner {
  /**
   * Plans updates in topological order, grouped into parallel execution phases.
   */
  public planUpdates(updates: PluginUpdate[], graph: DependencyGraph): UpdatePlan {
    if (updates.length === 0) {
      return {
        phases: [],
        totalPhases: 0,
        totalUpdates: 0,
        estimatedDurationSec: 0,
      };
    }

    const updateMap = new Map<string, PluginUpdate>(updates.map((u) => [u.pluginId, u]));
    // A cycle anywhere in the graph must not abort an advisory plan: fall
    // back to update-list order and let the phase loop below isolate the
    // cyclic subset one per phase.
    let topoOrder: string[];
    try {
      topoOrder = graph.topologicalSort();
    } catch {
      topoOrder = updates.map((u) => u.pluginId);
    }

    // Filter to only plugins being updated, ordered topologically
    const relevantIds = topoOrder.filter((id) => updateMap.has(id));

    // Handle any update targets not present in topoOrder (e.g. newly registered or isolated)
    for (const update of updates) {
      if (!relevantIds.includes(update.pluginId)) {
        relevantIds.push(update.pluginId);
      }
    }

    // Build phases: A plugin can be in a phase if all its dependencies in relevantIds
    // have already been placed in earlier phases.
    const phases: PluginUpdate[][] = [];
    const completed = new Set<string>();
    let remaining = [...relevantIds];

    while (remaining.length > 0) {
      const currentPhase: PluginUpdate[] = [];
      const nextRemaining: string[] = [];

      for (const id of remaining) {
        const node = graph.getPlugin(id);
        const deps = node ? node.dependencies.filter((d) => updateMap.has(d)) : [];

        const allDepsSatisfied = deps.every((d) => completed.has(d));
        if (allDepsSatisfied) {
          const item = updateMap.get(id);
          if (item) currentPhase.push(item);
        } else {
          nextRemaining.push(id);
        }
      }

      if (currentPhase.length === 0) {
        // Fallback for cycle in subset
        const fallbackId = remaining[0]!;
        const item = updateMap.get(fallbackId);
        if (item) currentPhase.push(item);
        remaining = remaining.slice(1);
      } else {
        remaining = nextRemaining;
      }

      for (const item of currentPhase) {
        completed.add(item.pluginId);
      }

      phases.push(currentPhase);
    }

    const estimatedDurationSec = phases.length * 5; // Base 5s per parallel phase

    return {
      phases,
      totalPhases: phases.length,
      totalUpdates: updates.length,
      estimatedDurationSec,
    };
  }
}
