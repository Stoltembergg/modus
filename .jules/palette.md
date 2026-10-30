## 2024-05-24 - Sidebar Item Focus Visibility
**Learning:** The `button` and `a` elements in the sidebar items lacked proper focus rings, making keyboard navigation difficult to track.
**Action:** Applied the `focus-visible:ring-2 focus-visible:ring-focus-ring/35` utility classes to ensure a clear focus indicator is present.

## 2024-05-31 - Modus Input Focus Enhancements
**Learning:** Found that custom inputs within the Modus system sometimes lack sufficient focus indication. Setting `outline-none` but not applying a `ring` or custom focus outline leads to inaccessible inputs.
**Action:** When adding or modifying custom input elements, ensure they receive focus states by applying standard ring utilities: `focus:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring/35`.

## 2024-06-21 - [Palette: Adjust primary button focus styles]
**Learning:** The default primary button style has a subtle box-shadow for focus that gets lost against similar backgrounds (contrast ratio < 3:1).
**Action:** Switched primary button focus states to use a solid outline with an offset: `outline: 2px solid var(--color-accent); outline-offset: 2px;` to guarantee sufficient contrast.

## 2025-02-14 - [Palette: Ensure Checkbox Focus Contrast]
**Learning:** Our custom checkbox component was using `ring-focus-ring/35` for its focus state, which only provided a 1.8:1 contrast ratio against the background, failing accessibility standards.
**Action:** Changed custom checkbox focus styles to use a solid outline (`focus-visible:ring-2 focus-visible:ring-focus-ring`) to ensure a >= 3:1 contrast ratio for keyboard focus indicators, adhering to the updated Modus UI rules.

## 2025-02-28 - [Palette: Add focus rings to FileReference links]
**Learning:** Elements styled as interactive chips (like `FileReference` and `Badge`) often lack focus rings because they use custom rendering instead of standard button styles.
**Action:** Always add `outline-none focus-visible:ring-2 focus-visible:ring-focus-ring` to custom interactive inline elements to ensure keyboard accessibility.
