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
    <header className="flex items-start justify-between gap-4 pb-1">
      <div className="min-w-0">
        <h2 className="text-base font-medium text-fg">{title}</h2>
        <p
          className={cn(
            "mt-1 max-w-2xl text-xs leading-4 text-fg-muted",
            singleLineDescription && "truncate",
          )}
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
    <section className="flex flex-col gap-3">
      <div className="min-w-0">
        <h3 className="text-sm font-medium text-fg">{title}</h3>
        {description ? (
          <p className="mt-0.5 text-xs leading-4 text-fg-faint">{description}</p>
        ) : null}
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
    <div className="flex min-h-[60px] items-center gap-4 border-hairline-soft border-b px-4 py-3 last:border-b-0">
      <div className="min-w-0 flex-1">
        <div className="text-sm text-fg">{title}</div>
        <div className="mt-0.5 text-xs leading-4 text-fg-muted">{description}</div>
      </div>
      <div className="shrink-0">{control}</div>
    </div>
  );
}

export function ReadOnlyPill({ children }: { children: string }) {
  return (
    <span className="rounded-full bg-chip px-2.5 py-1 text-xs text-fg-muted tabular-nums">
      {children}
    </span>
  );
}
