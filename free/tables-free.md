#### Gate model (24px blur, no OS material): P5 contrast on main (window 60%, overlay 86%, #245 tint on the 60% window)

**dark**

| Backdrop | P95 lum | window fg / muted / subtle / faint | overlay fg / muted / subtle / faint | #245 tint fg / muted / subtle / faint |
|---|---|---|---|---|
| #ffffff | 1.00 | 4.54 / **2.34** / **1.82** / **1.38** | 9.22 / 4.74 / 3.70 / **2.80** | 5.09 / **2.62** / **2.04** / **1.54** |
| #cccccc | 0.60 | 6.17 / **3.18** / **2.48** / **1.87** | 10.29 / 5.30 / 4.13 / 3.12 | 6.74 / **3.47** / **2.71** / **2.04** |
| City rush (CC0) | 0.35 | 8.16 / **4.20** / 3.28 / **2.48** | 11.30 / 5.82 / 4.54 / 3.43 | 8.67 / **4.46** / 3.48 / **2.63** |
| #333333 | 0.03 | 15.18 / 7.81 / 6.10 / 4.60 | 13.93 / 7.17 / 5.59 / 4.22 | 15.10 / 7.77 / 6.06 / 4.58 |
| #000000 | 0.00 | 18.05 / 9.29 / 7.25 / 5.47 | 15.16 / 7.80 / 6.09 / 4.60 | 17.77 / 9.15 / 7.14 / 5.39 |

**light**

| Backdrop | P95 lum | window fg / muted / subtle / faint | overlay fg / muted / subtle / faint | #245 tint fg / muted / subtle / faint |
|---|---|---|---|---|
| #ffffff | 1.00 | 15.86 / 8.45 / 6.17 / 4.92 | 17.08 / 9.10 / 6.64 / 5.30 | 15.98 / 8.51 / 6.21 / 4.96 |
| #cccccc | 0.60 | 13.19 / 7.02 / 5.13 / 4.09 | 16.06 / 8.55 / 6.24 / 4.98 | 13.55 / 7.22 / 5.27 / 4.20 |
| City rush (CC0) | 0.35 | 5.82 / **3.10** / **2.26** / **1.80** | 12.63 / 6.73 / 4.91 / 3.92 | 6.62 / **3.52** / **2.57** / **2.05** |
| #333333 | 0.03 | 6.92 / **3.69** / **2.69** / **2.15** | 13.24 / 7.05 / 5.15 / 4.10 | 7.69 / **4.09** / **2.99** / **2.38** |
| #000000 | 0.00 | 5.38 / **2.87** / **2.09** / **1.67** | 12.37 / 6.59 / 4.81 / 3.84 | 6.18 / **3.29** / **2.40** / **1.92** |

#### Less pessimistic, for reference only: plus approximate OS material (theme colour at 55%), same alphas

**dark**

| Backdrop | P95 lum | window fg / muted / subtle / faint | overlay fg / muted / subtle / faint | #245 tint fg / muted / subtle / faint |
|---|---|---|---|---|
| #ffffff | 1.00 | 9.73 / 5.01 / 3.91 / **2.95** | 11.96 / 6.16 / 4.80 / 3.63 | 10.15 / 5.23 / 4.08 / 3.08 |
| #cccccc | 0.60 | 11.19 / 5.76 / 4.49 / 3.39 | 12.52 / 6.44 / 5.03 / 3.80 | 11.49 / 5.92 / 4.62 / 3.49 |
| City rush (CC0) | 0.35 | 12.56 / 6.47 / 5.05 / 3.81 | 13.01 / 6.70 / 5.22 / 3.95 | 12.74 / 6.56 / 5.12 / 3.87 |
| #333333 | 0.03 | 15.94 / 8.20 / 6.40 / 4.83 | 14.21 / 7.31 / 5.71 / 4.31 | 15.78 / 8.12 / 6.34 / 4.79 |
| #000000 | 0.00 | 17.28 / 8.89 / 6.94 / 5.24 | 14.77 / 7.60 / 5.93 / 4.48 | 17.03 / 8.76 / 6.84 / 5.16 |

**light**

| Backdrop | P95 lum | window fg / muted / subtle / faint | overlay fg / muted / subtle / faint | #245 tint fg / muted / subtle / faint |
|---|---|---|---|---|
| #ffffff | 1.00 | 15.59 / 8.30 / 6.06 / 4.83 | 16.98 / 9.04 / 6.60 / 5.26 | 15.74 / 8.38 / 6.12 / 4.88 |
| #cccccc | 0.60 | 14.36 / 7.65 / 5.58 / 4.45 | 16.52 / 8.80 / 6.42 / 5.12 | 14.62 / 7.79 / 5.68 / 4.53 |
| City rush (CC0) | 0.35 | 10.35 / 5.51 / 4.02 / 3.21 | 14.88 / 7.93 / 5.79 / 4.61 | 10.93 / 5.82 / 4.25 / 3.39 |
| #333333 | 0.03 | 11.04 / 5.88 / 4.29 / 3.42 | 15.18 / 8.09 / 5.90 / 4.71 | 11.58 / 6.16 / 4.50 / 3.59 |
| #000000 | 0.00 | 10.06 / 5.36 / 3.91 / 3.12 | 14.75 / 7.86 / 5.73 / 4.57 | 10.66 / 5.68 / 4.14 / 3.30 |

#### Floor search: smallest alpha (0.5% steps) at which every alpha above it passes

**Gate model**

| Backdrop | dark window | dark overlay | dark #245 (window alpha) | light window | light overlay | light #245 (window alpha) |
|---|---|---|---|---|---|---|
| #ffffff | 81.5% (faint) | 88.5% (faint) | 80.0% (faint) | 0 | 0 | 0 |
| #cccccc | 76.0% (faint) | 84.5% (faint) | 74.5% (faint) | 0 | 0 | 0 |
| City rush (CC0) | 69.0% (faint) | 79.0% (faint) | 67.0% (faint) | 80.0% (faint) | 75.0% (faint) | 77.0% (faint) |
| #333333 | 0 | 0 | 0 | 76.0% (faint) | 71.0% (faint) | 72.5% (faint) |
| #000000 | 0 | 0 | 0 | 81.0% (faint) | 76.5% (faint) | 78.5% (faint) |
| **max** | **81.5%** | **88.5%** | **80.0%** | **81.0%** | **76.5%** | **78.5%** |

**Gate model + CSS saturate (1.3 / 1.6)**

| Backdrop | dark window | dark overlay | dark #245 (window alpha) | light window | light overlay | light #245 (window alpha) |
|---|---|---|---|---|---|---|
| #ffffff | 81.5% (faint) | 88.5% (faint) | 80.0% (faint) | 0 | 0 | 0 |
| #cccccc | 76.0% (faint) | 84.5% (faint) | 74.5% (faint) | 0 | 0 | 0 |
| City rush (CC0) | 69.0% (faint) | 79.0% (faint) | 67.0% (faint) | 80.0% (faint) | 75.0% (faint) | 77.0% (faint) |
| #333333 | 0 | 0 | 0 | 76.0% (faint) | 71.0% (faint) | 72.5% (faint) |
| #000000 | 0 | 0 | 0 | 81.0% (faint) | 76.5% (faint) | 78.5% (faint) |
| **max** | **81.5%** | **88.5%** | **80.0%** | **81.0%** | **76.5%** | **78.5%** |

**+ approx. OS material (reference)**

| Backdrop | dark window | dark overlay | dark #245 (window alpha) | light window | light overlay | light #245 (window alpha) |
|---|---|---|---|---|---|---|
| #ffffff | 61.0% (faint) | 73.0% (faint) | 58.5% (faint) | 0 | 0 | 0 |
| #cccccc | 51.5% (faint) | 64.5% (faint) | 48.5% (faint) | 0 | 0 | 0 |
| City rush (CC0) | 38.0% (faint) | 51.0% (faint) | 34.0% (faint) | 53.5% (faint) | 47.0% (faint) | 47.0% (faint) |
| #333333 | 0 | 0 | 0 | 44.5% (faint) | 38.0% (faint) | 36.5% (faint) |
| #000000 | 0 | 0 | 0 | 56.5% (faint) | 50.0% (faint) | 50.5% (faint) |
| **max** | **61.0%** | **73.0%** | **58.5%** | **56.5%** | **50.0%** | **50.5%** |
