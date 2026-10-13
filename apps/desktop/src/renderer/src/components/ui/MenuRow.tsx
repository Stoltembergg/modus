import { Menu } from "@base-ui/react/menu";
import type { ReactNode } from "react";
import { cn } from "../../lib/cn";

/** A row in a Base UI menu (icon + label). */
export function MenuRow({
  icon,
  children,
  onClick,
  danger = false,
  closeOnClick = true,
}: {
  icon: ReactNode;
  children: ReactNode;
  onClick(): void;
  danger?: boolean;
  closeOnClick?: boolean;
}) {
  return (
    <Menu.Item
      className={cn(
        "flex cursor-default items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm outline-none select-none data-highlighted:bg-hover",
        danger ? "text-danger" : "text-fg",
      )}
      closeOnClick={closeOnClick}
      onClick={onClick}
    >
      <span className="flex size-4 shrink-0 items-center justify-center">{icon}</span>
      {children}
    </Menu.Item>
  );
}
