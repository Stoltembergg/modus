import type { CSSProperties, ReactNode } from "react";
import type { AgentAvatarColor, AgentAvatarFace } from "../../../../shared/contracts";
import { cn } from "../../lib/cn";
import {
  AGENT_AVATAR_ARCHIVED_FILL,
  AGENT_AVATAR_FILL,
  type AgentAvatarSize,
  type AgentAvatarState,
  agentAvatarTiming,
} from "./agentAvatarModel";

const INK = "#18181b";
const LINE = {
  fill: "none",
  stroke: INK,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  strokeWidth: 2.6,
};

/** Every animated part: CSS keyframes only, frozen under prefers-reduced-motion. */
const ANIMATED = "motion-reduce:animate-none";

type FaceParts = { eyes: ReactNode; mouth: ReactNode };

const dot = (cx: number, r = 2.8) => <circle cx={cx} cy={21} fill={INK} r={r} />;

/** The 8 faces: eyes (they blink / look around) and mouth, on a 48×48 grid. */
const FACES: Record<AgentAvatarFace, FaceParts> = {
  happy: {
    eyes: (
      <>
        {dot(17)}
        {dot(31)}
      </>
    ),
    mouth: <path d="M17 29 Q24 36 31 29" {...LINE} />,
  },
  curious: {
    eyes: (
      <>
        {dot(17, 2.4)}
        {dot(31, 3.4)}
      </>
    ),
    mouth: <circle cx={25} cy={31} fill="none" r={2.6} stroke={INK} strokeWidth={2.4} />,
  },
  sleepy: {
    eyes: (
      <>
        <path d="M13.5 21.5 Q17 24 20.5 21.5" {...LINE} />
        <path d="M27.5 21.5 Q31 24 34.5 21.5" {...LINE} />
      </>
    ),
    mouth: <path d="M20 31 H28" {...LINE} />,
  },
  wink: {
    eyes: (
      <>
        {dot(17)}
        <path d="M27.5 21.5 L31 19 L34.5 21.5" {...LINE} />
      </>
    ),
    mouth: <path d="M17 29 Q24 35 31 29" {...LINE} />,
  },
  focused: {
    eyes: (
      <>
        <rect fill={INK} height={3} rx={1.5} width={7} x={13.5} y={19.5} />
        <rect fill={INK} height={3} rx={1.5} width={7} x={27.5} y={19.5} />
      </>
    ),
    mouth: <path d="M19 31 H29" {...LINE} />,
  },
  cheeky: {
    eyes: (
      <>
        {dot(17)}
        {dot(31)}
      </>
    ),
    mouth: (
      <>
        <path d="M17 28 Q24 34 31 28" {...LINE} />
        <path d="M22.5 31.5 Q24.5 36.5 26.5 31.5 Z" fill="#f43f5e" />
      </>
    ),
  },
  calm: {
    eyes: (
      <>
        <path d="M13.5 22 Q17 18.5 20.5 22" {...LINE} />
        <path d="M27.5 22 Q31 18.5 34.5 22" {...LINE} />
      </>
    ),
    mouth: <path d="M20 30 Q24 33 28 30" {...LINE} />,
  },
  bright: {
    eyes: (
      <>
        <circle cx={17} cy={21} fill={INK} r={3.8} />
        <circle cx={18.2} cy={19.8} fill="#fff" r={1.2} />
        <circle cx={31} cy={21} fill={INK} r={3.8} />
        <circle cx={32.2} cy={19.8} fill="#fff" r={1.2} />
      </>
    ),
    mouth: <path d="M18 28 Q24 37 30 28 Z" fill={INK} />,
  },
};

export type AgentAvatarProps = {
  face: AgentAvatarFace;
  color: AgentAvatarColor;
  size?: AgentAvatarSize;
  state?: AgentAvatarState;
  /** Varies the blink / float timing per agent (usually the agent id). */
  seed?: string;
  /** Accessible name; without it the avatar is decorative (the name is next to it). */
  label?: string;
  /** false: drawn in its state but still (e.g. message authors: a list of floating heads is noise). */
  animated?: boolean;
  className?: string;
};

/**
 * An agent's face (A3): an SVG blob in one of 10 colors with one of 8 faces.
 * idle blinks and floats, working looks side to side with a short bounce,
 * waiting shows a pulsing amber ring and a raised brow, archived is grey and
 * still. The motion is CSS only (app.css `agent-avatar-*`), static under
 * prefers-reduced-motion.
 */
export function AgentAvatar({
  face,
  color,
  size = 20,
  state = "idle",
  seed = face,
  label,
  animated = true,
  className,
}: AgentAvatarProps) {
  const parts = FACES[face] ?? FACES.happy;
  const timing = agentAvatarTiming(seed);
  const archived = state === "archived";
  const style = {
    "--agent-avatar-delay": timing.delay,
    "--agent-avatar-blink": timing.blink,
  } as CSSProperties;
  return (
    <span
      {...(label ? { role: "img", "aria-label": label } : { "aria-hidden": true })}
      className={cn("agent-avatar inline-flex shrink-0", className)}
      data-animated={animated ? undefined : "false"}
      data-color={color}
      data-face={face}
      data-size={size}
      data-state={state}
      data-testid="agent-avatar"
      style={{ ...style, width: size, height: size }}
    >
      <svg
        aria-hidden="true"
        className="overflow-visible"
        height={size}
        viewBox="0 0 48 48"
        width={size}
      >
        {state === "waiting" ? (
          <circle
            className={cn("agent-avatar-ring", ANIMATED)}
            cx={24}
            cy={24}
            fill="none"
            r={23}
            stroke="#fbbf24"
            strokeWidth={size <= 20 ? 4 : 2.5}
          />
        ) : null}
        <g className={cn("agent-avatar-body", ANIMATED)}>
          <circle
            cx={24}
            cy={24}
            fill={archived ? AGENT_AVATAR_ARCHIVED_FILL : AGENT_AVATAR_FILL[color]}
            r={state === "waiting" ? 19 : 21}
          />
          <g className={cn("agent-avatar-eyes", ANIMATED)} opacity={archived ? 0.6 : 1}>
            {parts.eyes}
          </g>
          {state === "waiting" ? (
            <path className="agent-avatar-brow" d="M26.5 14.5 Q31 11.5 35 14" {...LINE} />
          ) : null}
          <g opacity={archived ? 0.6 : 1}>{parts.mouth}</g>
        </g>
      </svg>
    </span>
  );
}
