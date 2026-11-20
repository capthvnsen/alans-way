#!/usr/bin/env python3
"""Make the Alan's Way logo: the Hermes bust with its solid black oval eyes, on a transparent background.

The source is the highest-resolution copy that still has the eyes baked in (the iOS asset, byte-identical to
mobile/miniapp/assets/hermes.png and to desktop/assets/avatars/hermes.png before the eyes were inpainted away).
It already has a transparent surround, so this script only cleans the matte: it drops the faint haze, gives every
soft edge pixel the colour of the stone next to it (so no dark or tinted fringe shows on light or dark surfaces),
trims to the bust and writes square PNGs. Resizing is done on premultiplied colour, so edges stay clean.

  uv run --with pillow --with numpy desktop/scripts/make-alans-way-logo.py
"""
import pathlib
import numpy as np
from PIL import Image, ImageFilter

ROOT = pathlib.Path(__file__).resolve().parents[2]
SOURCE = ROOT / 'ios' / 'AlanWorkspace' / 'Resources' / 'Assets.xcassets' / 'hermes.imageset' / 'hermes.png'
OUT = ROOT / 'desktop' / 'assets'
SIZES = {'alans-way-logo.png': 256, 'alans-way-logo-64.png': 64}  # 256 for the new tab, 64 for chips and menus
HAZE = 12        # alpha at or below this is background noise, not stone
SOLID = 250      # alpha at or above this is trusted for edge colour
MARGIN = 0.03    # of the longer side, kept around the bust


def clean(image):
    rgba = np.asarray(image.convert('RGBA'), dtype=np.float32)
    assert rgba[0, 0, 3] < HAZE and rgba[-1, -1, 3] < HAZE, 'source is not a transparent cutout'
    alpha = rgba[..., 3]
    alpha[alpha <= HAZE] = 0
    solid = (alpha >= SOLID).astype(np.float32)
    # Normalised blur of the solid stone colour (8-bit planes are plenty for colour), used wherever the edge is soft.
    blur = lambda plane: np.asarray(Image.fromarray(plane.round().astype(np.uint8), 'L').filter(ImageFilter.GaussianBlur(8)), dtype=np.float32)
    weight = blur(solid * 255)
    for channel in range(3):
        fill = blur(rgba[..., channel] * solid) * 255 / np.maximum(weight, 1)
        rgba[..., channel] = np.where(solid > 0, rgba[..., channel], np.where(weight > 0, np.minimum(fill, 255), rgba[..., channel]))
    return Image.fromarray(rgba.round().astype(np.uint8), 'RGBA')


def trimmed_square(image):
    box = image.getchannel('A').point(lambda value: 255 if value > HAZE else 0).getbbox()
    image = image.crop(box)
    side = round(max(image.size) * (1 + 2 * MARGIN))
    canvas = Image.new('RGBA', (side, side), (0, 0, 0, 0))
    canvas.paste(image, ((side - image.width) // 2, (side - image.height) // 2))
    return canvas


def main():
    logo = trimmed_square(clean(Image.open(SOURCE)))
    for name, size in SIZES.items():
        small = logo.convert('RGBa').resize((size, size), Image.LANCZOS).convert('RGBA')
        small.save(OUT / name, optimize=True)
        print(f'{name}: {size}x{size}, {(OUT / name).stat().st_size} bytes')


if __name__ == '__main__':
    main()
