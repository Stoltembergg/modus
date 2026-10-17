#!/usr/bin/env python3
"""Reproducible inputs for measure.py: plain colours (generated) + the CC0 photo (downloaded, sha256-checked)."""
import hashlib, os, urllib.request
from PIL import Image
D = os.path.join(os.path.dirname(os.path.abspath(__file__)), "backdrops")
os.makedirs(D, exist_ok=True)
for name, c in [("plain-white", "#ffffff"), ("plain-cccccc", "#cccccc"), ("plain-333333", "#333333"), ("plain-black", "#000000")]:
  Image.new("RGB", (1920, 1080), c).save(os.path.join(D, f"{name}.png"))
URL = "https://commons.wikimedia.org/wiki/Special:FilePath/City_rush_(Unsplash).jpg?width=3000"  # CC0 1.0, Christopher Burns
SHA256 = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "photo-city-rush-cc0.sha256")).read().split()[0]
dst = os.path.join(D, "photo-city-rush-cc0.jpg")
if not os.path.exists(dst):
  req = urllib.request.Request(URL, headers={"User-Agent": "modus-glass-measure/1.0"})
  open(dst, "wb").write(urllib.request.urlopen(req).read())
got = hashlib.sha256(open(dst, "rb").read()).hexdigest()
assert got == SHA256, f"sha256 mismatch: {got}"
print("ok", D)
