import type { ComponentPropsWithoutRef } from "react";
import { cn } from "../../lib/cn";

export type SurfaceTone = "app" | "sidebar" | "main" | "raised" | "glass";

const TONE_CLASSES: Record<SurfaceTone, string> = {
  app: "surface-app",
  sidebar: "surface-sidebar",
  main: "surface-main",
  raised: "surface-raised",
  glass: "surface-glass",
};

export type SurfaceProps = ComponentPropsWithoutRef<"div"> & {
  tone?: SurfaceTone;
};

/** Shared surface primitive; glass is reserved for elevated overlays. */
export function Surface({ className, tone = "main", ...props }: SurfaceProps) {
  return (
    <div
      className={cn("modus-surface", TONE_CLASSES[tone], className)}
      data-surface={tone}
      {...props}
    />
  );
}
