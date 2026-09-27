import { IconAlertTriangle } from "@tabler/icons-react";
import { type ReactNode, useState } from "react";
import { cn } from "../../lib/cn";

/**
 * Compact, in-detail reminder that stays visible while Antigravity is
 * configured. The text is deliberately grounded in the upstream warning and
 * does not promise safety, legality, or support.
 */
export function UnofficialProviderNotice({ className }: { className?: string }) {
  return (
    <section
      aria-label="Unofficial provider warning"
      className={cn(
        "flex flex-col gap-2 rounded-lg border border-warning/35 bg-warning/8 px-3 py-3",
        className,
      )}
    >
      <div className="flex items-center gap-2 text-warning">
        <IconAlertTriangle aria-hidden size={14} stroke={1.8} />
        <span className="font-medium text-xs uppercase tracking-wide">Unofficial provider</span>
      </div>
      <p className="text-xs leading-5 text-warning/95">
        Antigravity reaches Google through unofficial internal Cloud Code Assist endpoints,
        including undocumented methods that can change without notice.
      </p>
      <p className="text-xs leading-5 text-fg-muted">
        The upstream README warns that use may violate Google’s terms and that Google may warn,
        restrict, or suspend the linked account. Modus cannot guarantee an outcome or make this
        integration supported, legal, or safe to use.
      </p>
    </section>
  );
}

/**
 * Interstitial that gates the start of Antigravity OAuth. The user must
 * explicitly tick the risk acknowledgement before the primary action enables;
 * cancellation closes without starting OAuth or persisting credentials. The
 * confirmed path forwards `riskAcknowledged: true` to the preload layer, which
 * the main process enforces independently.
 */
export function UnofficialProviderRiskInterstitial({
  busy,
  checked,
  onChange,
  onConfirm,
  onCancel,
}: {
  busy: boolean;
  checked: boolean;
  onChange(checked: boolean): void;
  onConfirm(): void;
  onCancel(): void;
}) {
  // Defensive local state ensures checkbox behaviour even when the parent
  // does not bounce state back through this render path.
  const [localChecked, setLocalChecked] = useState(checked);
  const value = localChecked;
  const setValue = (next: boolean) => {
    setLocalChecked(next);
    onChange(next);
  };

  return (
    <div className="flex flex-col gap-5">
      <header className="grid gap-1.5">
        <h3 className="text-md font-normal text-fg">Antigravity risk acknowledgement</h3>
        <p className="text-xs text-fg-faint">
          Review what Antigravity does and what it does not promise before starting sign-in.
        </p>
      </header>

      <section className="grid gap-3 rounded-lg border border-hairline bg-surface/45 p-3">
        <p className="text-sm text-fg">
          Antigravity reaches Google through unofficial internal Cloud Code Assist endpoints,
          including undocumented methods that the upstream plugin has to reverse engineer.
        </p>
        <p className="text-xs leading-5 text-fg-muted">
          The upstream README warns that use may violate Google’s terms of service and that Google
          may warn, restrict, or suspend the linked account. Endpoint behaviour and quotas can
          change without notice.
        </p>
        <p className="text-xs leading-5 text-fg-muted">
          Modus cannot guarantee an outcome or make this integration supported, legal, or safe to
          use.
        </p>
      </section>

      <label className="flex min-h-[44px] cursor-pointer items-start gap-3 rounded-md border border-hairline bg-canvas/70 px-3 py-2.5 text-sm text-fg transition-colors hover:border-hairline-strong">
        <input
          aria-label="Acknowledge Antigravity risk"
          checked={value}
          className="mt-0.5 size-4 cursor-pointer accent-fg"
          data-testid="unofficial-provider-acknowledge"
          disabled={busy}
          onChange={(event) => setValue(event.target.checked)}
          type="checkbox"
        />
        <span className="grid gap-1">
          <span>I understand this is unofficial and may violate Google’s terms.</span>
          <span className="text-2xs text-fg-faint">
            Modus cannot guarantee that Google will not warn, restrict, or suspend the linked
            account.
          </span>
        </span>
      </label>

      <div className="flex flex-wrap items-center justify-end gap-2">
        <button
          aria-label="Cancel Antigravity sign-in"
          className="h-9 rounded-md px-3 text-sm text-fg-faint transition-colors hover:bg-hover hover:text-fg"
          disabled={busy}
          onClick={onCancel}
          type="button"
        >
          Cancel
        </button>
        <button
          aria-label="Start Antigravity OAuth with acknowledgement"
          className="flex h-9 items-center justify-center rounded-md bg-fg px-3 text-sm text-canvas transition-colors hover:bg-white disabled:cursor-not-allowed disabled:opacity-50"
          disabled={busy || !value}
          onClick={onConfirm}
          type="button"
        >
          Continue to sign-in
        </button>
      </div>
    </div>
  );
}

/**
 * Compact badge + tooltip used in the Antigravity row before sign-in, so users
 * see the warning before they pick "Connect". The same tooltip stays attached
 * to the row while configured.
 */
export function UnofficialProviderMark({ children }: { children: ReactNode }) {
  return (
    <span
      aria-label="Unofficial provider"
      className="ml-1 inline-flex items-center gap-1 rounded-full bg-warning/15 px-1.5 py-0.5 text-2xs font-medium text-warning"
      role="img"
      title="Uses unofficial Google internal endpoints. See the risk notice in Configure."
    >
      <IconAlertTriangle aria-hidden size={11} stroke={1.8} />
      {children ?? "Unofficial"}
    </span>
  );
}
