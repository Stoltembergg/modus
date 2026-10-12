import { createContext, useContext } from "react";
import type { WidthTier, WidthTierBreakpoints } from "../../lib/useWidthTier";

/**
 * L3c: the 1:1 composer toolbar (mode, session branch, context, send) by its own width.
 * - `lg` (≥ 520px): full row.
 * - `md` (380–519px): the branch label truncates at 6rem.
 * - `sm` (< 380px): Attach moves into a "More actions" overflow menu; the branch picker is
 *   compact (icon + up to 4.5rem of the name, no chevron).
 */
export const COMPOSER_TOOLBAR_BREAKPOINTS: WidthTierBreakpoints = { md: 380, lg: 520 };

/** Read by controls rendered into the toolbar (e.g. `SessionBranchPicker`). */
export const ComposerToolbarTierContext = createContext<WidthTier>("lg");

export function useComposerToolbarTier(): WidthTier {
  return useContext(ComposerToolbarTierContext);
}
