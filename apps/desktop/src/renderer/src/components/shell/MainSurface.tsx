import { m, type HTMLMotionProps } from "motion/react";

export type MainSurfaceProps = HTMLMotionProps<"main">;

export function MainSurface({ className, ...props }: MainSurfaceProps) {
  return (
    <m.main
      className={className}
      data-shell-layer="main-surface"
      {...props}
    />
  );
}
