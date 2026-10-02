import type { CSSProperties, ReactNode } from "react";
import type {
  AgentAvatarColor,
  AgentAvatarFace,
  AgentAvatarShape,
} from "../../../../shared/contracts";
import { cn } from "../../lib/cn";
import {
  AGENT_AVATAR_ARCHIVED_FILL,
  AGENT_AVATAR_ARCHIVED_INK,
  AGENT_AVATAR_FILL,
  AGENT_AVATAR_INK,
  type AgentAvatarSize,
  type AgentAvatarState,
  agentAvatarTiming,
} from "./agentAvatarModel";

/** Every animated part: CSS keyframes only, frozen under prefers-reduced-motion. */
const ANIMATED = "motion-reduce:animate-none";

type FaceParts = { eyes: ReactNode; mouth: ReactNode };

const FACE = { fill: "currentColor", stroke: "none" } as const;
const LINE = {
  fill: "none",
  stroke: "currentColor",
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  strokeWidth: 2.6,
};

const dot = (cx: number, r = 2.8) => <circle cx={cx} cy={21} r={r} {...FACE} />;

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
    mouth: <circle cx={25} cy={31} fill="none" r={2.6} stroke="currentColor" strokeWidth={2.4} />,
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
        <rect height={3} rx={1.5} width={7} x={13.5} y={19.5} {...FACE} />
        <rect height={3} rx={1.5} width={7} x={27.5} y={19.5} {...FACE} />
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
        <circle cx={17} cy={21} r={3.8} {...FACE} />
        <circle cx={18.2} cy={19.8} fill="#fff" r={1.2} />
        <circle cx={31} cy={21} r={3.8} {...FACE} />
        <circle cx={32.2} cy={19.8} fill="#fff" r={1.2} />
      </>
    ),
    mouth: <path d="M18 28 Q24 37 30 28 Z" {...FACE} />,
  },
};

/** Silhouette path/geometry for each shape (fill + optional waiting ring). */
function ShapeFill({
  shape,
  fill,
  waiting,
}: {
  shape: AgentAvatarShape;
  fill: string;
  waiting: boolean;
}) {
  const r = waiting ? 19 : 21;
  switch (shape) {
    case "circle":
      return <circle className="agent-avatar-fill" cx={24} cy={24} fill={fill} r={r} />;
    case "squircle":
      return (
        <rect
          className="agent-avatar-fill"
          fill={fill}
          height={r * 2}
          rx={r * 0.42}
          width={r * 2}
          x={24 - r}
          y={24 - r}
        />
      );
    case "roundedSquare":
      return (
        <rect
          className="agent-avatar-fill"
          fill={fill}
          height={r * 2}
          rx={5}
          width={r * 2}
          x={24 - r}
          y={24 - r}
        />
      );
    case "hexagon": {
      const pts = hexPoints(24, 24, r);
      return <polygon className="agent-avatar-fill" fill={fill} points={pts} />;
    }
    case "triangle":
      return (
        <polygon
          className="agent-avatar-fill"
          fill={fill}
          points={regularPolygonPoints(24, 24, r, 3, -90)}
        />
      );
    case "pentagon":
      return (
        <polygon
          className="agent-avatar-fill"
          fill={fill}
          points={regularPolygonPoints(24, 24, r, 5, -90)}
        />
      );
    case "capsule":
      return (
        <rect
          className="agent-avatar-fill"
          fill={fill}
          height={r * 2}
          rx={r}
          width={r * 1.55}
          x={24 - r * 0.775}
          y={24 - r}
        />
      );
    case "blob":
      return (
        <path
          className="agent-avatar-fill"
          d={
            waiting
              ? "M24 5 C33 5 42 12 42 22 C43 31 36 41 24 43 C12 41 5 31 6 22 C6 12 15 5 24 5 Z"
              : "M24 3 C34 3 44 11 44 22 C45 32 37 43 24 45 C11 43 3 32 4 22 C4 11 14 3 24 3 Z"
          }
          fill={fill}
        />
      );
    case "diamond": {
      const d = r * 0.95;
      return (
        <polygon
          className="agent-avatar-fill"
          fill={fill}
          points={`${24},${24 - d} ${24 + d},${24} ${24},${24 + d} ${24 - d},${24}`}
        />
      );
    }
    case "shield":
      return (
        <path
          className="agent-avatar-fill"
          d={
            waiting
              ? "M24 6 L39 11 V24 C39 34 31 40 24 43 C17 40 9 34 9 24 V11 Z"
              : "M24 4 L41 10 V24 C41 35 32 42 24 45 C16 42 7 35 7 24 V10 Z"
          }
          fill={fill}
        />
      );
    default:
      return <circle className="agent-avatar-fill" cx={24} cy={24} fill={fill} r={r} />;
  }
}

function ShapeRing({ shape, strokeWidth }: { shape: AgentAvatarShape; strokeWidth: number }) {
  const stroke = "#fbbf24";
  const r = 23;
  switch (shape) {
    case "circle":
      return (
        <circle
          className={cn("agent-avatar-ring", ANIMATED)}
          cx={24}
          cy={24}
          fill="none"
          r={r}
          stroke={stroke}
          strokeWidth={strokeWidth}
        />
      );
    case "squircle":
      return (
        <rect
          className={cn("agent-avatar-ring", ANIMATED)}
          fill="none"
          height={46}
          rx={19}
          stroke={stroke}
          strokeWidth={strokeWidth}
          width={46}
          x={1}
          y={1}
        />
      );
    case "roundedSquare":
      return (
        <rect
          className={cn("agent-avatar-ring", ANIMATED)}
          fill="none"
          height={46}
          rx={7}
          stroke={stroke}
          strokeWidth={strokeWidth}
          width={46}
          x={1}
          y={1}
        />
      );
    case "hexagon":
      return (
        <polygon
          className={cn("agent-avatar-ring", ANIMATED)}
          fill="none"
          points={hexPoints(24, 24, r)}
          stroke={stroke}
          strokeWidth={strokeWidth}
        />
      );
    case "triangle":
      return (
        <polygon
          className={cn("agent-avatar-ring", ANIMATED)}
          fill="none"
          points={regularPolygonPoints(24, 24, r, 3, -90)}
          stroke={stroke}
          strokeWidth={strokeWidth}
        />
      );
    case "pentagon":
      return (
        <polygon
          className={cn("agent-avatar-ring", ANIMATED)}
          fill="none"
          points={regularPolygonPoints(24, 24, r, 5, -90)}
          stroke={stroke}
          strokeWidth={strokeWidth}
        />
      );
    case "capsule":
      return (
        <rect
          className={cn("agent-avatar-ring", ANIMATED)}
          fill="none"
          height={46}
          rx={23}
          stroke={stroke}
          strokeWidth={strokeWidth}
          width={36}
          x={6}
          y={1}
        />
      );
    case "blob":
      return (
        <path
          className={cn("agent-avatar-ring", ANIMATED)}
          d="M24 2 C35 2 46 10 46 22 C47 33 38 45 24 47 C10 45 1 33 2 22 C2 10 13 2 24 2 Z"
          fill="none"
          stroke={stroke}
          strokeWidth={strokeWidth}
        />
      );
    case "diamond":
      return (
        <polygon
          className={cn("agent-avatar-ring", ANIMATED)}
          fill="none"
          points="24,2 46,24 24,46 2,24"
          stroke={stroke}
          strokeWidth={strokeWidth}
        />
      );
    case "shield":
      return (
        <path
          className={cn("agent-avatar-ring", ANIMATED)}
          d="M24 2 L43 9 V24 C43 36 33 44 24 47 C15 44 5 36 5 24 V9 Z"
          fill="none"
          stroke={stroke}
          strokeWidth={strokeWidth}
        />
      );
    default:
      return (
        <circle
          className={cn("agent-avatar-ring", ANIMATED)}
          cx={24}
          cy={24}
          fill="none"
          r={r}
          stroke={stroke}
          strokeWidth={strokeWidth}
        />
      );
  }
}

function hexPoints(cx: number, cy: number, radius: number): string {
  return Array.from({ length: 6 }, (_, index) => {
    const angle = ((index * 60 - 30) * Math.PI) / 180;
    return `${cx + radius * Math.cos(angle)},${cy + radius * Math.sin(angle)}`;
  }).join(" ");
}

function regularPolygonPoints(
  cx: number,
  cy: number,
  radius: number,
  sides: number,
  rotation: number,
): string {
  return Array.from({ length: sides }, (_, index) => {
    const angle = ((index * 360) / sides + rotation) * (Math.PI / 180);
    return `${cx + radius * Math.cos(angle)},${cy + radius * Math.sin(angle)}`;
  }).join(" ");
}

export type AgentAvatarProps = {
  face: AgentAvatarFace;
  color: AgentAvatarColor;
  shape?: AgentAvatarShape;
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
 * An agent's face: SVG silhouette (shape) + fill/ink pair + one of 8 faces.
 * idle blinks and floats, working looks side to side with a short bounce,
 * waiting shows a pulsing amber ring and a raised brow, archived is grey and
 * still. The motion is CSS only (app.css `agent-avatar-*`), static under
 * prefers-reduced-motion.
 */
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
  const parts = FACES[face] ?? FACES.happy;
  const timing = agentAvatarTiming(seed);
  const archived = state === "archived";
  const fill = archived ? AGENT_AVATAR_ARCHIVED_FILL : AGENT_AVATAR_FILL[color];
  const ink = archived ? AGENT_AVATAR_ARCHIVED_INK : AGENT_AVATAR_INK[color];
  const style = {
    "--agent-avatar-delay": timing.delay,
    "--agent-avatar-blink": timing.blink,
    color: ink,
  } as CSSProperties;
  return (
    <span
      {...(label ? { role: "img", "aria-label": label } : { "aria-hidden": true })}
      className={cn("agent-avatar inline-flex shrink-0", className)}
      data-animated={animated ? undefined : "false"}
      data-color={color}
      data-face={face}
      data-shape={shape}
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
          <ShapeRing shape={shape} strokeWidth={size <= 20 ? 4 : 2.5} />
        ) : null}
        <g className={cn("agent-avatar-body", ANIMATED)}>
          <ShapeFill fill={fill} shape={shape} waiting={state === "waiting"} />
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
