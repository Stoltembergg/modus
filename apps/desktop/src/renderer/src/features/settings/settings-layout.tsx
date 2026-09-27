import type { ReactNode } from "react";
import { cn } from "../../lib/cn";

export function SettingsPageHeader({
  actions,
  description,
  singleLineDescription = false,
  title,
}: {
  actions?: ReactNode;
  description: string;
  singleLineDescription?: boolean;
  title: string;
}) {
  return (
    <header className="sticky top-0 z-10 -mx-10 -mt-16 flex items-end justify-between gap-5 bg-gradient-to-b from-canvas via-canvas to-canvas/0 px-10 pt-16 pb-8">
      <div className="min-w-0">
        <h2 className="text-lg font-normal text-fg">{title}</h2>
        <p
          className={cn("mt-2 text-sm text-fg-muted", singleLineDescription && "truncate")}
          title={singleLineDescription ? description : undefined}
        >
          {description}
        </p>
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2 pb-0.5">{actions}</div> : null}
    </header>
  );
}

export function SettingsSection({
  children,
  description,
  title,
}: {
  children: ReactNode;
  description?: string;
  title: string;
}) {
  return (
    <section className="flex flex-col gap-4">
      <div className="min-w-0">
        <h3 className="text-md font-normal text-fg">{title}</h3>
        {description ? <p className="mt-1 text-xs text-fg-faint">{description}</p> : null}
      </div>
      {children}
    </section>
  );
}

export function SettingsList({ children }: { children: ReactNode }) {
  return (
    <div className="overflow-hidden rounded-lg border border-hairline-soft bg-panel">
      {children}
    </div>
  );
}

export function SettingsRow({
  control,
  description,
  title,
}: {
  control: ReactNode;
  description: string;
  title: string;
}) {
  return (
    <div className="flex min-h-[72px] items-center gap-5 border-hairline-soft border-b px-5 py-4 last:border-b-0">
      <div className="min-w-0 flex-1">
        <div className="text-sm text-fg">{title}</div>
        <div className="mt-1 text-xs text-fg-muted">{description}</div>
      </div>
      <div className="shrink-0">{control}</div>
    </div>
  );
}

export function ReadOnlyPill({ children }: { children: string }) {
  return <span className="rounded-md bg-chip px-2.5 py-1 text-xs text-fg-muted">{children}</span>;
}
