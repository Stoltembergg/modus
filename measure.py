#!/usr/bin/env python3
"""Glass opacity floor measurement (v0.1.11 blocker).

Model = tokensNew.test.ts / glassTokens.test.ts: surface = a*base + (1-a)*backdrop per
8-bit sRGB channel (color-mix in srgb), WCAG 2.x contrast, no OS material tint.
Additions: the backdrop is a real wallpaper cover-fit to 1920x1080 logical px,
blurred with a 24px gaussian (CSS blur(24px), sRGB space as Chromium does), optionally
saturated (CSS saturate(), 1.3 dark / 1.6 light), and the worst case is the P5 of the
per-pixel contrast over the whole frame (= P95 of the worst local backdrop luminance:
the window can sit anywhere on the screen). Min (P0) reported too.
"""
import json, sys, glob, os
import numpy as np
from PIL import Image, ImageFilter

W, H, SIGMA = 1920, 1080, 24
HERE = os.path.dirname(os.path.abspath(__file__))
WALLS = os.path.join(HERE, "wallpapers")

def hx(s): s = s.lstrip("#"); return np.array([int(s[i:i+2], 16) for i in (0, 2, 4)], float)

TOK = {  # tokens-new.css at main 3d796844
  "dark":  dict(panel="#0b1018", elevated="#1a2333", fg="#f2f4f8", muted="#a9b2c0", subtle="#939dac", faint="#7d8797", sat=1.3),
  "light": dict(panel="#eef1f6", elevated="#ffffff", fg="#161c27", muted="#3f4959", subtle="#535d6f", faint="#626c7e", sat=1.6),
}
CHROME, OVERLAY, CHAT = 0.60, 0.86, 0.10
GATE = dict(fg=4.5, muted=4.5, subtle=3.0, faint=3.0)
TEXTS = ["fg", "muted", "subtle", "faint"]

def lin(c):
  v = c / 255.0
  return np.where(v <= 0.03928, v / 12.92, ((v + 0.055) / 1.055) ** 2.4)
def lum(rgb): l = lin(rgb); return 0.2126*l[...,0] + 0.7152*l[...,1] + 0.0722*l[...,2]
def contrast(L1, L2): hi, lo = np.maximum(L1, L2), np.minimum(L1, L2); return (hi+0.05)/(lo+0.05)

def saturate(img, s):  # CSS Filter Effects saturate() matrix, sRGB values
  m = np.array([[0.213+0.787*s, 0.715-0.715*s, 0.072-0.072*s],
                [0.213-0.213*s, 0.715+0.285*s, 0.072-0.072*s],
                [0.213-0.213*s, 0.715-0.715*s, 0.072+0.928*s]])
  return np.clip(img @ m.T, 0, 255)

def load(path):
  im = Image.open(path).convert("RGB")
  r = max(W / im.width, H / im.height)
  im = im.resize((round(im.width*r), round(im.height*r)), Image.LANCZOS)
  l, t = (im.width-W)//2, (im.height-H)//2
  im = im.crop((l, t, l+W, t+H)).filter(ImageFilter.GaussianBlur(SIGMA))
  im = im.resize((W//8, H//8), Image.BOX)  # post-blur: no detail left above sigma/4
  return np.asarray(im, float)

MATERIAL = {"dark": (hx("#1e1e20"), 0.55), "light": (hx("#f6f6f6"), 0.55)}  # pr-glass/app/shots.mjs approximation
def material(theme, bg):
  c, a = MATERIAL[theme]; return a*c + (1-a)*bg

def surfaces(theme, bg, chrome=CHROME, overlay=OVERLAY):
  t = TOK[theme]; P, E = hx(t["panel"]), hx(t["elevated"])
  win = chrome*P + (1-chrome)*bg
  return {"window": win, "overlay": overlay*E + (1-overlay)*bg, "chat": CHAT*E + (1-CHAT)*win}

def stats(theme, bg, surf, text, chrome=CHROME, overlay=OVERLAY):
  s = surfaces(theme, bg, chrome, overlay)[surf]
  c = contrast(lum(hx(TOK[theme][text])), lum(s)).ravel()
  return float(np.percentile(c, 5)), float(c.min())

def floor(theme, bg, surf, text, q=5):
  """Smallest alpha (0.5% steps) of the varying tier such that every alpha from it up to
  100% keeps P5 contrast >= gate (contrast is not monotonic in alpha: e.g. dark faint on a
  bare white backdrop passes at 0%, fails in the middle, passes again near solid)."""
  best = None
  for a in np.arange(1.0, -0.0001, -0.005):
    kw = {"overlay": a} if surf == "overlay" else {"chrome": a}
    s = surfaces(theme, bg, **kw)[surf]
    c = contrast(lum(hx(TOK[theme][text])), lum(s)).ravel()
    if np.percentile(c, q) >= GATE[text]: best = round(float(a), 3)
    else: break
  return best

def main():
  out = {}
  files = sorted(glob.glob(os.path.join(WALLS, "*")))
  for f in files:
    name = os.path.splitext(os.path.basename(f))[0]
    raw = load(f)
    out[name] = {"bgP95lum": float(np.percentile(lum(raw), 95)), "bgP5lum": float(np.percentile(lum(raw), 5))}
    for theme in TOK:
      for satmode in ("nosat", "sat", "material"):
        bg = raw if satmode == "nosat" else saturate(raw, TOK[theme]["sat"])
        if satmode == "material": bg = material(theme, bg)
        for surf in ("window", "overlay", "chat"):
          for text in TEXTS:
            p5, mn = stats(theme, bg, surf, text)
            out[name][f"{theme}|{satmode}|{surf}|{text}"] = {"p5": round(p5, 2), "min": round(mn, 2), "floor": floor(theme, bg, surf, text)}
    print(name, "done", file=sys.stderr)
  json.dump(out, open(os.path.join(HERE, "results.json"), "w"), indent=1)

if __name__ == "__main__":
  main()
