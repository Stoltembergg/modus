# Glass opacity floor: v0.1.11 release blocker

_Jennie, 2026-10-17 (BRT). Repo Stoltembergg/modus, main `3d796844` (#254 merged: window 60%, overlay 86%, blur 24px). Fix branch `fix/glass-opacity-floor`._

## TL;DR

- On the gate model Debbie reviewed for #254, main's 60% window fails over **every** real wallpaper I tried. With a light wallpaper behind the dark theme, fg-muted is at **3.09:1** (Sequoia light), and **2.34:1** over white. It fails for the light theme too, even over its *own* light wallpapers: **3.78:1** over Sequoia light, and **2.87:1** over black. The opposite-brightness case is the worst one, but it is not the only failure.
- The tier that binds everywhere is fg-faint at 3:1. The smallest passing alphas are: **window 81.5% dark / 81% light**, **overlay 88.5% dark / 76.5% light**, **#245 tint** OK once the window is ≥ 80% (dark) / 78.5% (light).
- Implemented (simplest that passes): **one alpha set for both themes, window 82%, overlay 89%** (both rounded up). The #245 tint stays at 10%.
- Cost: the wallpaper shows through **18% instead of 40%** on the window (−55% see-through) and 11% instead of 14% on overlays. That is **more opaque than before #254 (64%)**, and more opaque than classic's 78%. **This reverses Gabriel's 2026-10-13 "more transparent than 64%" ruling.** It needs his call before merge.
- The real app does not sit on a bare blurred wallpaper. macOS `vibrancy: "sidebar"` and Windows `backgroundMaterial: "acrylic"` add a theme-matched material that already follows `nativeTheme.themeSource`. With an *approximate* material layer, the floor drops to **61% dark / 56.5% light**, set by faint over pure white. The muted-only floor is 54.5%. That fits the ruling. **Open question for Debbie:** gate on the measured native material instead of the no-material model? That would need captures on real macOS and Windows hardware, which this box can't produce.

## Method

1. **Compositing:** the same as `tokensNew.test.ts` / `glassTokens.test.ts`: `surface = a·base + (1−a)·backdrop` per 8-bit sRGB channel (CSS `color-mix(in srgb, …, transparent)` over the backdrop), WCAG 2.x relative luminance and contrast.
   - window = `--color-panel` @ `--glass-alpha-chrome`
   - overlay = `--color-elevated` @ `--glass-alpha-overlay`, directly over the backdrop, like the tests
   - #245 tint = `--color-elevated` @ `--glass-alpha-chat` (10%) over the window
   - Tokens from `tokens-new.css` at `3d796844`: dark panel `#0b1018`, elevated `#1a2333`, fg `#f2f4f8`, muted `#a9b2c0`, subtle `#939dac`, faint `#7d8797`; light panel `#eef1f6`, elevated `#ffffff`, fg `#161c27`, muted `#3f4959`, subtle `#535d6f`, faint `#626c7e`.
2. **Backdrop:** each wallpaper is cover-fitted to 1920×1080 logical px and blurred with a **24px gaussian** (PIL GaussianBlur σ = 24, in sRGB like Chromium's `blur()`). It is then box-downsampled ×8 for speed; after a σ = 24 blur no detail is lost.
   - Variant "+saturate": CSS `saturate()` matrix at 1.3 (dark) / 1.6 (light), as in `--glass-filter`. It changes nothing material (±0.5%).
   - Variant "+material": a theme-matched layer, `#1e1e20` (dark) / `#f6f6f6` (light) at 55%, over the blurred wallpaper. This is the assumption the `pr-glass` shots already used. It is an **approximation of NSVisualEffectView / acrylic, not a measurement**.
3. **Worst case:** the **P5 of per-pixel contrast over the whole frame**, i.e. the P95 of the worst local backdrop. The window can sit anywhere on the screen, so every point of the wallpaper may end up under text. Min (P0) is in `results.json`. Uniform backdrops have P5 = min.
4. **Gates:** fg ≥ 4.5, fg-muted ≥ 4.5, fg-subtle ≥ 3, fg-faint ≥ 3.
5. **Floor:** the smallest alpha in 0.5% steps such that **every** alpha from it to 100% passes. Contrast is not monotonic in alpha: dark faint over bare white passes at 0%, fails in the middle, and passes again near solid.
6. **Real screenshots:** real Electron builds.
   - Before: main's renderer, the `modus-glass` build, whose renderer sources are byte-identical to `3d796844`.
   - After: an `electron-vite build` of the fix branch.
   - Glass is forced on (`data-native-glass`, Full transparency). A free backdrop sits behind the window: the CC0 photo with CSS `blur(24px)`, or a plain colour. There is **no material layer**, i.e. the gate model.
   - P5 contrast of the token colours is taken against an empty 190×750 px strip of window glass on the Settings screen (`shots/pixel-contrast.json`). Script: `pr-glass/app/floor-shots2.mjs`.

Code: `measure.py` (→ `results.json`, `tables.md`).

## Wallpapers (local only; the Apple and Microsoft files are not committed anywhere)

| File | Source | License |
|---|---|---|
| macOS Sequoia light / dark (6400×3552) | basicappleguy.com/s/SequoiaLight.png, /s/SequoiaDark.png (Basic Apple Guy's captures of the stock Sequoia wallpaper) | © Apple. Used here for local measurement only; not redistributed. |
| Windows 11 Bloom light `img0` (3840×2400) | windowswallpaper.miraheze.org, File:Img0_(Windows_11).jpg | © Microsoft. Local measurement only. |
| Windows 11 Bloom dark `img19` (2560×1600) | windowsobserver.com/wp-content/uploads/2021/07/img19-scaled.jpg | © Microsoft. Local measurement only. |
| Busy photo "City rush" (3840×2537) | commons.wikimedia.org/wiki/File:City_rush_(Unsplash).jpg, Christopher Burns | CC0 1.0 |
| Plain #ffffff, #cccccc, #333333, #000000 | generated | n/a |

I found no clean Sonoma source (Basic Apple Guy's Sonoma page 404s). The Sequoia pair covers the default macOS case. The plain white and black frames bound every wallpaper: no real wallpaper in the set was worse than them at P5.

The PR screenshots use only the CC0 photo and plain colours. An earlier set over blurred Apple and Microsoft wallpapers was removed from the assets branch tip; it remains in that branch's history at `4797e0e0`, which was not rewritten.

## Results (P5 contrast; **bold** = fails the gate)

### Gate model (24px blur, no saturate, no OS material): P5 contrast at main's 60% window / 86% overlay / #245 tint on 60%

#### dark theme

| Wallpaper | P95 lum | window fg / muted / subtle / faint | overlay fg / muted / subtle / faint | #245 tint fg / muted / subtle / faint |
|---|---|---|---|---|
| #ffffff | 1.00 | 4.54 / **2.34** / **1.82** / **1.38** | 9.22 / 4.74 / 3.70 / **2.80** | 5.09 / **2.62** / **2.04** / **1.54** |
| #cccccc | 0.60 | 6.17 / **3.18** / **2.48** / **1.87** | 10.29 / 5.30 / 4.13 / 3.12 | 6.74 / **3.47** / **2.71** / **2.04** |
| macOS Sequoia light | 0.64 | 6.01 / **3.09** / **2.41** / **1.82** | 10.24 / 5.27 / 4.11 / 3.11 | 6.59 / **3.39** / **2.65** / **2.00** |
| Win 11 Bloom light | 0.56 | 6.44 / **3.31** / **2.58** / **1.95** | 10.42 / 5.36 / 4.18 / 3.16 | 7.00 / **3.60** / **2.81** / **2.12** |
| macOS Sequoia dark | 0.53 | 6.65 / **3.42** / **2.67** / **2.02** | 10.56 / 5.43 / 4.24 / 3.20 | 7.21 / **3.71** / **2.90** / **2.19** |
| Busy photo (City rush) | 0.35 | 8.16 / **4.20** / 3.28 / **2.48** | 11.30 / 5.82 / 4.54 / 3.43 | 8.67 / **4.46** / 3.48 / **2.63** |
| Win 11 Bloom dark | 0.17 | 10.94 / 5.63 / 4.39 / 3.32 | 12.48 / 6.43 / 5.01 / 3.79 | 11.28 / 5.81 / 4.53 / 3.42 |
| #333333 | 0.03 | 15.18 / 7.81 / 6.10 / 4.60 | 13.93 / 7.17 / 5.59 / 4.22 | 15.10 / 7.77 / 6.06 / 4.58 |
| #000000 | 0.00 | 18.05 / 9.29 / 7.25 / 5.47 | 15.16 / 7.80 / 6.09 / 4.60 | 17.77 / 9.15 / 7.14 / 5.39 |

#### light theme

| Wallpaper | P95 lum | window fg / muted / subtle / faint | overlay fg / muted / subtle / faint | #245 tint fg / muted / subtle / faint |
|---|---|---|---|---|
| #ffffff | 1.00 | 15.86 / 8.45 / 6.17 / 4.92 | 17.08 / 9.10 / 6.64 / 5.30 | 15.98 / 8.51 / 6.21 / 4.96 |
| #cccccc | 0.60 | 13.19 / 7.02 / 5.13 / 4.09 | 16.06 / 8.55 / 6.24 / 4.98 | 13.55 / 7.22 / 5.27 / 4.20 |
| macOS Sequoia light | 0.64 | 7.10 / **3.78** / **2.76** / **2.20** | 13.31 / 7.09 / 5.17 / 4.13 | 7.85 / **4.18** / 3.05 / **2.43** |
| Win 11 Bloom light | 0.56 | 6.44 / **3.43** / **2.50** / **2.00** | 12.96 / 6.90 / 5.04 / 4.02 | 7.22 / **3.84** / **2.80** / **2.24** |
| macOS Sequoia dark | 0.53 | 6.24 / **3.32** / **2.43** / **1.93** | 12.86 / 6.85 / 5.00 / 3.99 | 7.02 / **3.74** / **2.73** / **2.18** |
| Busy photo (City rush) | 0.35 | 5.82 / **3.10** / **2.26** / **1.80** | 12.63 / 6.73 / 4.91 / 3.92 | 6.62 / **3.52** / **2.57** / **2.05** |
| Win 11 Bloom dark | 0.17 | 5.66 / **3.01** / **2.20** / **1.75** | 12.53 / 6.67 / 4.87 / 3.89 | 6.45 / **3.44** / **2.51** / **2.00** |
| #333333 | 0.03 | 6.92 / **3.69** / **2.69** / **2.15** | 13.24 / 7.05 / 5.15 / 4.10 | 7.69 / **4.09** / **2.99** / **2.38** |
| #000000 | 0.00 | 5.38 / **2.87** / **2.09** / **1.67** | 12.37 / 6.59 / 4.81 / 3.84 | 6.18 / **3.29** / **2.40** / **1.92** |

### Less pessimistic: + approximate OS material (theme-matched layer at 55%, the pr-glass shots assumption), same alphas

#### dark theme

| Wallpaper | P95 lum | window fg / muted / subtle / faint | overlay fg / muted / subtle / faint | #245 tint fg / muted / subtle / faint |
|---|---|---|---|---|
| #ffffff | 1.00 | 9.73 / 5.01 / 3.91 / **2.95** | 11.96 / 6.16 / 4.80 / 3.63 | 10.15 / 5.23 / 4.08 / 3.08 |
| #cccccc | 0.60 | 11.19 / 5.76 / 4.49 / 3.39 | 12.52 / 6.44 / 5.03 / 3.80 | 11.49 / 5.92 / 4.62 / 3.49 |
| macOS Sequoia light | 0.64 | 11.07 / 5.70 / 4.45 / 3.36 | 12.51 / 6.44 / 5.02 / 3.79 | 11.40 / 5.87 / 4.58 / 3.46 |
| Win 11 Bloom light | 0.56 | 11.38 / 5.86 / 4.57 / 3.45 | 12.58 / 6.47 / 5.05 / 3.81 | 11.66 / 6.00 / 4.68 / 3.54 |
| macOS Sequoia dark | 0.53 | 11.54 / 5.94 / 4.63 / 3.50 | 12.65 / 6.51 / 5.08 / 3.84 | 11.81 / 6.08 / 4.74 / 3.58 |
| Busy photo (City rush) | 0.35 | 12.56 / 6.47 / 5.05 / 3.81 | 13.01 / 6.70 / 5.22 / 3.95 | 12.74 / 6.56 / 5.12 / 3.87 |
| Win 11 Bloom dark | 0.17 | 14.18 / 7.30 / 5.69 / 4.30 | 13.59 / 6.99 / 5.46 / 4.12 | 14.20 / 7.31 / 5.70 / 4.31 |
| #333333 | 0.03 | 15.94 / 8.20 / 6.40 / 4.83 | 14.21 / 7.31 / 5.71 / 4.31 | 15.78 / 8.12 / 6.34 / 4.79 |
| #000000 | 0.00 | 17.28 / 8.89 / 6.94 / 5.24 | 14.77 / 7.60 / 5.93 / 4.48 | 17.03 / 8.76 / 6.84 / 5.16 |

#### light theme

| Wallpaper | P95 lum | window fg / muted / subtle / faint | overlay fg / muted / subtle / faint | #245 tint fg / muted / subtle / faint |
|---|---|---|---|---|
| #ffffff | 1.00 | 15.59 / 8.30 / 6.06 / 4.83 | 16.98 / 9.04 / 6.60 / 5.26 | 15.74 / 8.38 / 6.12 / 4.88 |
| #cccccc | 0.60 | 14.36 / 7.65 / 5.58 / 4.45 | 16.52 / 8.80 / 6.42 / 5.12 | 14.62 / 7.79 / 5.68 / 4.53 |
| macOS Sequoia light | 0.64 | 11.15 / 5.94 / 4.34 / 3.46 | 15.22 / 8.11 / 5.92 / 4.72 | 11.67 / 6.22 / 4.54 / 3.62 |
| Win 11 Bloom light | 0.56 | 10.78 / 5.74 / 4.19 / 3.34 | 15.06 / 8.02 / 5.85 / 4.67 | 11.33 / 6.03 / 4.40 / 3.51 |
| macOS Sequoia dark | 0.53 | 10.62 / 5.66 / 4.13 / 3.29 | 15.00 / 7.99 / 5.83 / 4.65 | 11.18 / 5.95 / 4.35 / 3.47 |
| Busy photo (City rush) | 0.35 | 10.35 / 5.51 / 4.02 / 3.21 | 14.88 / 7.93 / 5.79 / 4.61 | 10.93 / 5.82 / 4.25 / 3.39 |
| Win 11 Bloom dark | 0.17 | 10.25 / 5.46 / 3.98 / 3.18 | 14.84 / 7.90 / 5.77 / 4.60 | 10.84 / 5.77 / 4.21 / 3.36 |
| #333333 | 0.03 | 11.04 / 5.88 / 4.29 / 3.42 | 15.18 / 8.09 / 5.90 / 4.71 | 11.58 / 6.16 / 4.50 / 3.59 |
| #000000 | 0.00 | 10.06 / 5.36 / 3.91 / 3.12 | 14.75 / 7.86 / 5.73 / 4.57 | 10.66 / 5.68 / 4.14 / 3.30 |

### Floors: smallest alpha (0.5% steps) at which P5 contrast meets the gate for every alpha above it

#### Gate model

| Wallpaper | dark window | dark overlay | dark #245 (window alpha) | light window | light overlay | light #245 (window alpha) |
|---|---|---|---|---|---|---|
| #ffffff | 81.5% (faint) | 88.5% (faint) | 80.0% (faint) | 0 | 0 | 0 |
| #cccccc | 76.0% (faint) | 84.5% (faint) | 74.5% (faint) | 0 | 0 | 0 |
| macOS Sequoia light | 76.5% (faint) | 85.0% (faint) | 75.0% (faint) | 75.5% (faint) | 70.0% (faint) | 72.0% (faint) |
| Win 11 Bloom light | 75.5% (faint) | 84.0% (faint) | 74.0% (faint) | 78.0% (faint) | 73.0% (faint) | 74.5% (faint) |
| macOS Sequoia dark | 74.5% (faint) | 83.5% (faint) | 73.0% (faint) | 78.5% (faint) | 73.5% (faint) | 75.5% (faint) |
| Busy photo (City rush) | 69.0% (faint) | 79.0% (faint) | 67.0% (faint) | 80.0% (faint) | 75.0% (faint) | 77.0% (faint) |
| Win 11 Bloom dark | 53.5% (faint) | 66.0% (faint) | 50.5% (faint) | 80.5% (faint) | 75.5% (faint) | 77.5% (faint) |
| #333333 | 0 | 0 | 0 | 76.0% (faint) | 71.0% (faint) | 72.5% (faint) |
| #000000 | 0 | 0 | 0 | 81.0% (faint) | 76.5% (faint) | 78.5% (faint) |
| **max** | **81.5%** | **88.5%** | **80.0%** | **81.0%** | **76.5%** | **78.5%** |

#### Gate model + CSS saturate (1.3 / 1.6)

| Wallpaper | dark window | dark overlay | dark #245 (window alpha) | light window | light overlay | light #245 (window alpha) |
|---|---|---|---|---|---|---|
| #ffffff | 81.5% (faint) | 88.5% (faint) | 80.0% (faint) | 0 | 0 | 0 |
| #cccccc | 76.0% (faint) | 84.5% (faint) | 74.5% (faint) | 0 | 0 | 0 |
| macOS Sequoia light | 77.0% (faint) | 85.0% (faint) | 75.0% (faint) | 75.5% (faint) | 70.0% (faint) | 71.5% (faint) |
| Win 11 Bloom light | 75.5% (faint) | 84.0% (faint) | 74.0% (faint) | 77.5% (faint) | 72.5% (faint) | 74.5% (faint) |
| macOS Sequoia dark | 74.5% (faint) | 83.5% (faint) | 73.0% (faint) | 78.5% (faint) | 73.5% (faint) | 75.5% (faint) |
| Busy photo (City rush) | 69.0% (faint) | 79.0% (faint) | 67.0% (faint) | 80.0% (faint) | 75.0% (faint) | 77.0% (faint) |
| Win 11 Bloom dark | 54.0% (faint) | 66.0% (faint) | 51.0% (faint) | 80.5% (faint) | 75.5% (faint) | 77.5% (faint) |
| #333333 | 0 | 0 | 0 | 76.0% (faint) | 71.0% (faint) | 72.5% (faint) |
| #000000 | 0 | 0 | 0 | 81.0% (faint) | 76.5% (faint) | 78.5% (faint) |
| **max** | **81.5%** | **88.5%** | **80.0%** | **81.0%** | **76.5%** | **78.5%** |

#### + approx. OS material

| Wallpaper | dark window | dark overlay | dark #245 (window alpha) | light window | light overlay | light #245 (window alpha) |
|---|---|---|---|---|---|---|
| #ffffff | 61.0% (faint) | 73.0% (faint) | 58.5% (faint) | 0 | 0 | 0 |
| #cccccc | 51.5% (faint) | 64.5% (faint) | 48.5% (faint) | 0 | 0 | 0 |
| macOS Sequoia light | 52.5% (faint) | 65.0% (faint) | 49.5% (faint) | 42.5% (faint) | 36.5% (faint) | 34.5% (faint) |
| Win 11 Bloom light | 50.0% (faint) | 63.5% (faint) | 46.5% (faint) | 48.5% (faint) | 41.5% (faint) | 41.0% (faint) |
| macOS Sequoia dark | 48.5% (faint) | 62.0% (faint) | 45.5% (faint) | 50.5% (faint) | 43.5% (faint) | 43.0% (faint) |
| Busy photo (City rush) | 38.0% (faint) | 51.0% (faint) | 34.0% (faint) | 53.5% (faint) | 47.0% (faint) | 47.0% (faint) |
| Win 11 Bloom dark | 10.5% (faint) | 16.5% (faint) | 5.0% (faint) | 55.0% (faint) | 48.0% (faint) | 48.0% (faint) |
| #333333 | 0 | 0 | 0 | 44.5% (faint) | 38.0% (faint) | 36.5% (faint) |
| #000000 | 0 | 0 | 0 | 56.5% (faint) | 50.0% (faint) | 50.5% (faint) |
| **max** | **61.0%** | **73.0%** | **58.5%** | **56.5%** | **50.0%** | **50.5%** |


### Real screenshots (gate model, no material), P5 over an empty strip of window glass on Settings

Backdrops are free only: the CC0 "City rush" photo (blurred 24px) and plain colours. The Apple and Microsoft wallpapers were used only for the numeric measurement above and appear in no image at the assets branch tip. Script: `pr-glass/app/floor-shots2.mjs`; data: `shots/pixel-contrast.json` on the assets branch.

| Build | Theme over backdrop | fg | muted | subtle | faint |
|---|---|---|---|---|---|
| before, main (60/86) | dark over white | 4.52 | **2.33** | **1.81** | **1.37** |
| before, main (60/86) | light over black | 5.41 | **2.88** | **2.10** | **1.68** |
| after (82/89) | dark over white | 10.22 | 5.26 | 4.10 | 3.10 |
| after (82/89) | dark over #cccccc | 11.69 | 6.02 | 4.69 | 3.55 |
| after (82/89) | dark over City rush | 15.84 | 8.15 | 6.36 | 4.81 |
| after (82/89) | dark over #333333 | 16.47 | 8.48 | 6.61 | 4.99 |
| after (82/89) | dark over black | 17.67 | 9.10 | 7.10 | 5.36 |
| after (82/89) | light over white | 15.48 | 8.25 | 6.02 | 4.80 |
| after (82/89) | light over #cccccc | 14.28 | 7.61 | 5.55 | 4.43 |
| after (82/89) | light over City rush | 10.17 | 5.42 | 3.95 | 3.15 |
| after (82/89) | light over #333333 | 10.93 | 5.82 | 4.25 | 3.39 |
| after (82/89) | light over black | 9.96 | 5.31 | 3.87 | 3.09 |

Over plain white and black these match the model (dark over white: 2.34 → 3.0x faint). The City rush figures read better than the whole-frame P5 because the strip covers only one part of the photo.

## What the floor means against 60% and Gabriel's ruling

| | main (#254) | before #254 | classic | gate-model floor (implemented) | approx-material floor |
|---|---|---|---|---|---|
| window alpha | 60% | 64% | 78% | **82%** (81.5 dark / 81 light) | 61% dark / 56.5% light (54.5% / 45% if faint is excluded) |
| wallpaper showing through | 40% | 36% | 22% | **18%** | 39% / 43.5% |
| overlay alpha | 86% | 90% | 82% | **89%** (88.5 dark / 76.5 light) | 73% dark / 50% light |

On the gate model, **no value below about 78% can satisfy the gate for fg-muted alone** (78% dark over white, 76% light over black). So no gate-model floor can honour "more transparent than 64%". The ruling and the gate model are incompatible; one of them has to give.

## Alternatives (not implemented)

1. **Theme-scoped floor:** dark needs 81.5%, light 81%. No real saving, and it breaks the "one alpha set" invariant. Not worth it.
2. **Fallback only for an 'opposite' desktop:**
   - It doesn't save 60% on the gate model, because matched backdrops fail too: light over Sequoia light needs 75.5%, dark over Sequoia dark 74.5%.
   - Electron can't detect it either. No API exposes wallpaper luminance, and `nativeTheme.shouldUseDarkColors` reflects the `themeSource` we set, not the OS. macOS `systemPreferences.getEffectiveAppearance()` follows the app's appearance too.
   - At best, the OS appearance could be read before we override it. That says nothing about the wallpaper: users run light wallpapers in dark mode.
3. **Theme-matched scrim under the glass:** this is what the native material already is. macOS vibrancy follows the window appearance, which follows `nativeTheme.themeSource`, and DWM acrylic follows the app's dark-mode attribute. Adding our own CSS scrim is equivalent to raising the alpha; it is the same trade.
4. **Stronger tint only behind text:** the window is mostly text (sidebar, chat, Settings). Per-region tints would bring back visible panels, i.e. the dividers Gabriel ruled out. Not simpler.
5. **Gate on the measured material:** the recommended follow-up. If real captures confirm that the material adds roughly what the approximation assumes, a floor around **62%** holds every gate over pure white and black, inside the ruling. That needs a macOS machine and a Windows 11 machine, each over a white and a black wallpaper, sampling the pixels behind the empty sidebar.

## Decisions (Debbie, 2026-10-17)

- **Gate model:** the gate stays on the no-material model.
- **faint:** keeps the 3:1 gate, for auxiliary or disabled text only.
- **Values:** 82% / 89% is the only value she approves without a hardware measurement.
- **Screenshots:** redone over the CC0 photo and plain colours only. The Apple and Microsoft images were removed from the PR and from the assets branch tip; they remain in that branch's history at `4797e0e0`, which is not rewritten.

## Open question for Gabriel

Accept 82% / 89% for v0.1.11, or hold #257 until hardware captures on a real Mac and a real Windows 11, each over a white and a black wallpaper?

If those captures confirm the approximate-material numbers (about 61% dark / 56.5% light), Debbie would approve a lower floor. It must come with an opaque fallback for reduce-transparency or energy saving.
