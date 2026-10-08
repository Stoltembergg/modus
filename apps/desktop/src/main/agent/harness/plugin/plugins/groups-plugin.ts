/**
 * Modus Internal Plugin — @modus/groups (Fase 10B)
 * Core capability for durable group mailboxes, inter-agent message routing, and team coordination.
 */

import type { CapabilityImplementation } from "../../capability/capability-types";
import type { PluginManifest } from "../plugin-types";

export interface GroupMessage {
  id: string;
  sender: string;
  recipient: string;
  body: string;
  timestamp: number;
}

class GroupMailbox {
  private messages: GroupMessage[] = [];

  public post(msg: Omit<GroupMessage, "id" | "timestamp">): GroupMessage {
    const full: GroupMessage = {
      ...msg,
      id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      timestamp: Date.now(),
    };
    this.messages.push(full);
    return full;
  }

  public read(recipient: string): GroupMessage[] {
    return this.messages.filter((m) => m.recipient === recipient || m.recipient === "*");
  }

  public clear(): void {
    this.messages = [];
  }
}

export const groupMailboxInstance = new GroupMailbox();

const groupsMailboxImpl: CapabilityImplementation<
  { action: "post" | "read"; recipient?: string; body?: string; sender?: string },
  any
> = {
  execute: (ctx) => {
    if (ctx.action === "post") {
      return groupMailboxInstance.post({
        sender: ctx.sender ?? "agent",
        recipient: ctx.recipient ?? "*",
        body: ctx.body ?? "",
      });
    }
    return groupMailboxInstance.read(ctx.recipient ?? "*");
  },
};

const groupsCoordinateImpl: CapabilityImplementation<
  { groupId: string; members: string[] },
  { status: string; activeMembers: string[] }
> = {
  execute: (ctx) => {
    return {
      status: "coordinated",
      activeMembers: ctx.members,
    };
  },
};

export const groupsPluginManifest: PluginManifest = {
  id: "@modus/groups",
  name: "Modus Agent Groups & Durable Mailbox",
  version: "1.0.0",
  author: "Modus Core Team",
  description: "Core capability providing team coordination and durable mailbox communication",
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
    capabilities: [
      {
        capability: "context.resolve",
        version: "^1.0",
      },
    ],
  },

  permissions: {
    required: {},
  },
};
