Fragments of the Settings + question card catalog (`../settings-text.ts`).
Each file exports `<AREA>_TEXT_EN` (`as const`, defines the keys) and
`<AREA>_TEXT_PT: Record<keyof typeof <AREA>_TEXT_EN, string>`.
Keys are `settings.<area>.<name>`; placeholders are `{name}`; plurals are a
`<base>_one` / `<base>_other` pair with `{count}`.
