import type { ComponentPropsWithRef } from "react";

export type TopBarProps = ComponentPropsWithRef<"header">;

export function TopBar({ className, ...props }: TopBarProps) {
  return <header className={className} data-shell-layer="top-bar" {...props} />;
}
