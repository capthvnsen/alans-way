#!/usr/bin/env python3
"""Make the default favicon: the Alan's Way bust as one solid colour, traced from alans-way-logo.png.

The tab strip shows it for a tab that is not on a website yet. It is the logo's silhouette (the alpha mask, so the
eyes and the stone's shading are gone), traced to one path in a 32x32 box so it stays crisp from 16px to 64px.

  uv run --with pillow --with numpy --with scikit-image desktop/scripts/make-favicon.py
"""
import pathlib
import numpy as np
from PIL import Image
from skimage import filters, measure

ROOT = pathlib.Path(__file__).resolve().parents[2]
SOURCE = ROOT / 'desktop' / 'assets' / 'alans-way-logo.png'
OUT = ROOT / 'desktop' / 'assets' / 'favicon.svg'
COLOUR = '#c4c4cd'  # the tab strip's secondary text colour, so it sits in the strip like any other glyph
BOX = 32
PAD = 1            # px of the 32 left clear around the bust
SMOOTH = 1.4       # blur radius in source px
TOLERANCE = 0.08   # polygon simplification, in 32-box units: well under a pixel at 32px


def main():
    alpha = np.asarray(Image.open(SOURCE).convert('RGBA'))[..., 3] > 127
    rows, cols = np.where(alpha)
    alpha = alpha[rows.min():rows.max() + 1, cols.min():cols.max() + 1]
    size = max(alpha.shape)
    square = np.zeros((size, size), bool)
    top, left = (size - alpha.shape[0]) // 2, (size - alpha.shape[1]) // 2
    square[top:top + alpha.shape[0], left:left + alpha.shape[1]] = alpha
    scale = (BOX - 2 * PAD) / size
    # Pad so contours close at the image edge; a hole in the mask becomes an even-odd cut-out.
    # A light blur first, so the mask's pixel staircase does not become wobble in the path.
    contours = measure.find_contours(filters.gaussian(np.pad(square, 1).astype(float), SMOOTH), 0.5)
    parts = []
    for contour in contours:
        points = measure.approximate_polygon(contour, TOLERANCE / scale)
        if len(points) < 4:
            continue
        xs = (points[:, 1] - 1) * scale + PAD
        ys = (points[:, 0] - 1) * scale + PAD
        parts.append('M' + 'L'.join(f'{x:.2f} {y:.2f}' for x, y in zip(xs[:-1], ys[:-1])) + 'Z')
    svg = (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {BOX} {BOX}" width="{BOX}" height="{BOX}">'
           f'<path fill="{COLOUR}" fill-rule="evenodd" d="{"".join(parts)}"/></svg>\n')
    OUT.write_text(svg)
    print(f'{OUT.relative_to(ROOT)}: {len(parts)} contour(s), {len(svg)} bytes')


if __name__ == '__main__':
    main()
