import type { ComponentPropsWithoutRef } from "react";

export type TopBarProps = ComponentPropsWithoutRef<"header">;

export function TopBar({ className, ...props }: TopBarProps) {
  return (
    <header
      className={className}
      data-shell-layer="top-bar"
      {...props}
    />
  );
}
