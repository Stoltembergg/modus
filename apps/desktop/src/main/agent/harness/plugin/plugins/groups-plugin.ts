/**
 * Modus Internal Plugin — @modus/groups (Fase 10B)
 * Core capability for durable group mailboxes, inter-agent message routing, and team coordination.
 */

import {
  type CapabilityImplementation,
  CapabilityUnavailableError,
} from "../../capability/capability-types";
import type { PluginManifest } from "../plugin-types";

const groupsMailboxImpl: CapabilityImplementation<
  { action: "post" | "read"; recipient?: string; body?: string; sender?: string },
  never
> = {
  execute: () => {
    throw new CapabilityUnavailableError(
      "groups.mailbox",
      "use the runtime's durable, group-scoped mailbox tools",
    );
  },
};

const groupsCoordinateImpl: CapabilityImplementation<
  { groupId: string; members: string[] },
  never
> = {
  execute: () => {
    throw new CapabilityUnavailableError(
      "groups.coordinate",
      "coordination is performed by the runtime group service",
    );
  },
};

export const groupsPluginManifest: PluginManifest = {
  id: "@modus/groups",
  name: "Modus Agent Groups & Durable Mailbox",
  version: "1.0.0",
  author: "Modus Core Team",
  description:
    "Legacy capability markers; group coordination and mailbox operations use runtime-owned services",
  trustLevel: "core",

  provides: [
    {
      capability: "groups.coordinate",
      apiVersion: "1.0",
      implementation: groupsCoordinateImpl,
    },
    {
      capability: "groups.mailbox",
      apiVersion: "1.0",
      implementation: groupsMailboxImpl,
    },
  ],

  requires: {
    modus: ">=0.8.0",
  },

  permissions: {
    required: {},
  },
};
