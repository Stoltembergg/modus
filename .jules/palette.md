## 2026-10-31 - Focus-visible token fix
**Learning:** `ring-focus-ring/35` produces a low-contrast outline that is inaccessible, and violates the rule to use a solid accent color.
**Action:** Use `ring-focus-ring` (without opacity divisor) for focus rings.
