import { AgentAvatar as PackageAgentAvatar } from "@tryopenbot/agent-avatar";
import type {
  AgentAvatarColor,
  AgentAvatarFace,
  AgentAvatarShape,
} from "../../../../shared/contracts";
import { cn } from "../../lib/cn";
import {
  type AgentAvatarSize,
  type AgentAvatarState,
  agentAvatarPresentation,
} from "./agentAvatarModel";

export type AgentAvatarProps = {
  face: AgentAvatarFace;
  color: AgentAvatarColor;
  shape?: AgentAvatarShape;
  size?: AgentAvatarSize;
  state?: AgentAvatarState;
  /** Varies the package avatar's deterministic details per agent. */
  seed?: string;
  /** Accessible name; without it the avatar is decorative (the name is next to it). */
  label?: string;
  /** false: keep the state appearance but pause animation. */
  animated?: boolean;
  className?: string;
};

/** Stable Modus wrapper around the shared package avatar renderer. */
export function AgentAvatar({
  face,
  color,
  shape = "circle",
  size = 20,
  state = "idle",
  seed = face,
  label,
  animated = true,
  className,
}: AgentAvatarProps) {
  const presentation = agentAvatarPresentation(color, shape, state, animated);
  return (
    <span
      {...(label ? { role: "img", "aria-label": label } : { "aria-hidden": true })}
      className={cn("agent-avatar inline-flex shrink-0", className)}
      data-animated={animated ? undefined : "false"}
      data-color={color}
      data-face={face}
      data-paused={presentation.paused ? "true" : undefined}
      data-shape={shape}
      data-size={size}
      data-state={state}
      data-testid="agent-avatar"
      style={{ width: size, height: size }}
    >
      <PackageAgentAvatar
        className="!size-full"
        color={presentation.fill}
        id={seed}
        paused={presentation.paused}
        shape={presentation.shape}
        state={presentation.state}
      />
    </span>
  );
}
