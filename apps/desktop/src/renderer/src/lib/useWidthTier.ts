import { type RefCallback, useCallback, useLayoutEffect, useState } from "react";

/**
 * L3c responsive bars: a bar's own width (not the viewport's) picks one of three tiers.
 * `sm` = below `md`, `md` = below `lg`, `lg` = the full layout. An unmeasured element
 * (width 0, jsdom, no ResizeObserver) is `lg`, so the full layout is the default.
 */
export type WidthTier = "sm" | "md" | "lg";
export type WidthTierBreakpoints = { readonly md: number; readonly lg: number };

/**
 * Window top bars (group room header and the 1:1 session bar): `lg` ≥ 760px,
 * `md` 520–759px, `sm` < 520px.
 */
export const TOP_BAR_BREAKPOINTS: WidthTierBreakpoints = { md: 520, lg: 760 };

export function widthTier(width: number, breakpoints: WidthTierBreakpoints): WidthTier {
  if (!(width > 0)) return "lg";
  if (width < breakpoints.md) return "sm";
  if (width < breakpoints.lg) return "md";
  return "lg";
}

/** `[ref, tier]`: attach `ref` to an element whose width does not depend on its content. */
export function useWidthTier<T extends HTMLElement>(
  breakpoints: WidthTierBreakpoints,
): [RefCallback<T>, WidthTier] {
  const [element, setElement] = useState<T | null>(null);
  const [tier, setTier] = useState<WidthTier>("lg");
  const { md, lg } = breakpoints;
  const ref = useCallback((node: T | null) => setElement(node), []);

  useLayoutEffect(() => {
    if (!element) return;
    const apply = (width: number) => setTier(widthTier(width, { md, lg }));
    apply(element.getBoundingClientRect().width);
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[entries.length - 1];
      apply(entry ? entry.contentRect.width : element.getBoundingClientRect().width);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [element, md, lg]);

  return [ref, tier];
}
