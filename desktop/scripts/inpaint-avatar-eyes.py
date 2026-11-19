#!/usr/bin/env python3
"""Remove the baked-in eyes from the marble bust avatars and record where they were.

The app draws flat black eyes itself (src/avatars.js), so the PNGs must be blank
where the original glossy eyes sat. For every avatar this script:
  1. finds the two dark pill-shaped eyes in the original image,
  2. measures each one (centre, radii, tilt) and writes it to manifest.json,
  3. fills the eye socket by solving for the smoothest surface that matches the
     surrounding marble (Laplace fill), adds back the stone's grain and feathers
     the edge, leaving every other pixel and the alpha channel untouched.

Originals are read from --src, or, by default, from git (the last commit that
still has the baked eyes), so a re-run always starts from the untouched art:

  uv run --with pillow --with numpy desktop/scripts/inpaint-avatar-eyes.py
"""
import argparse, io, json, math, pathlib, subprocess
import numpy as np
from PIL import Image, ImageFilter

BAKED_REF = '8d6c5d8'
ROOT = pathlib.Path(__file__).resolve().parents[1]
AVATARS = ROOT / 'assets' / 'avatars'
SOCKET_MARGIN = 9    # px beyond the dark pill: covers the bright lip and soft shadow around it
# How far the live eyes may move from rest, as a fraction of the image width. Hand-tuned by rendering every
# avatar with its eyes at each extreme: the default is safe everywhere except where a cheek or the hairline is close.
DEFAULT_TRAVEL = dict(left=0.02, right=0.02, up=0.012, down=0.016)
TRAVEL = dict(zeus=dict(right=0.012), poseidon=dict(right=0.012), hades=dict(right=0.01, up=0.008), artemis=dict(right=0.016),
              minotaur=dict(right=0.006, left=0.016), faun=dict(right=0.012), athena=dict(right=0.016), hermes=dict(right=0.014),
              apollo=dict(right=0.012), medusa=dict(right=0.016))
FEATHER = 3          # px: extra fill beyond the margin, blended out with a gaussian


def load_original(name, src):
    if src:
        return Image.open(pathlib.Path(src) / name).convert('RGBA')
    blob = subprocess.run(['git', 'show', f'{BAKED_REF}:desktop/assets/avatars/{name}'], cwd=ROOT, check=True, capture_output=True).stdout
    return Image.open(io.BytesIO(blob)).convert('RGBA')


def components(mask):
    """4-connected components of a boolean array, as lists of (y, x) index arrays."""
    seen = np.zeros_like(mask)
    found = []
    height, width = mask.shape
    for y0, x0 in zip(*np.nonzero(mask)):
        if seen[y0, x0]:
            continue
        stack, ys, xs = [(y0, x0)], [], []
        seen[y0, x0] = True
        while stack:
            y, x = stack.pop()
            ys.append(y); xs.append(x)
            for ny, nx in ((y - 1, x), (y + 1, x), (y, x - 1), (y, x + 1)):
                if 0 <= ny < height and 0 <= nx < width and mask[ny, nx] and not seen[ny, nx]:
                    seen[ny, nx] = True
                    stack.append((ny, nx))
        found.append((np.array(ys), np.array(xs)))
    return found


def find_eyes(rgba):
    """Two dark pills in the upper face. Returns a list of filled boolean masks, left eye first."""
    height, width = rgba.shape[:2]
    luminance = rgba[..., :3] @ np.array([0.299, 0.587, 0.114])
    dark = (luminance < 125) & (rgba[..., 3] > 128)
    window = np.zeros_like(dark)
    window[int(height * 0.28):int(height * 0.55), int(width * 0.30):int(width * 0.75)] = True
    blobs = []
    for ys, xs in components(dark & window):
        if not 1500 < len(ys) < 20000:
            continue
        box = (ys.max() - ys.min() + 1) * (xs.max() - xs.min() + 1)
        if len(ys) / box < 0.6:
            continue
        filled = np.zeros_like(dark)
        filled[ys, xs] = True
        for y in range(ys.min(), ys.max() + 1):  # specular highlights are lighter than the cutoff: fill rows between edges
            row = np.nonzero(filled[y])[0]
            filled[y, row.min():row.max() + 1] = True
        blobs.append(filled)
    if len(blobs) != 2:
        raise SystemExit('expected two baked eyes, found %d (already processed? pass --src with the original PNGs)' % len(blobs))
    return sorted(blobs, key=lambda blob: np.nonzero(blob)[1].mean())


def measure(mask):
    ys, xs = np.nonzero(mask)
    cx, cy = xs.mean(), ys.mean()
    covariance = np.cov(np.vstack([xs - cx, ys - cy]))
    theta = 0.5 * math.atan2(2 * covariance[0, 1], covariance[0, 0] - covariance[1, 1])  # major axis, from +x towards +y
    major = np.array([math.cos(theta), math.sin(theta)])
    minor = np.array([-major[1], major[0]])
    along = (xs - cx) * major[0] + (ys - cy) * major[1]
    across = (xs - cx) * minor[0] + (ys - cy) * minor[1]
    half_major = (along.max() - along.min() + 1) / 2
    half_minor = (across.max() - across.min() + 1) / 2
    rotate = (math.degrees(theta)) % 180 - 90  # tilt from vertical, clockwise positive
    # The old eyes are pills; the new ones are ellipses of the same area and tilt.
    scale = math.sqrt(mask.sum() / (math.pi * half_major * half_minor))
    return dict(cx=cx, cy=cy, half_major=half_major, half_minor=half_minor, theta=theta,
                rx=half_minor * scale, ry=half_major * scale, rotate=rotate)


def capsule(shape, eye, grow):
    """Pill-shaped region, `grow` px bigger than the measured eye on every side."""
    yy, xx = np.mgrid[:shape[0], :shape[1]]
    dx, dy = xx - eye['cx'], yy - eye['cy']
    along = dx * math.cos(eye['theta']) + dy * math.sin(eye['theta'])
    across = -dx * math.sin(eye['theta']) + dy * math.cos(eye['theta'])
    segment = max(eye['half_major'] - eye['half_minor'], 0)
    clamped = np.clip(along, -segment, segment)
    return np.hypot(along - clamped, across) <= eye['half_minor'] + grow


def laplace_fill(channel, hole, iterations=6000):
    """Smoothest surface that matches `channel` just outside `hole` (harmonic interpolation)."""
    value = channel.copy()
    value[hole] = channel[~hole & (np.roll(hole, 1, 0) | np.roll(hole, -1, 0) | np.roll(hole, 1, 1) | np.roll(hole, -1, 1))].mean()
    for _ in range(iterations):
        padded = np.pad(value, 1, mode='edge')
        average = (padded[:-2, 1:-1] + padded[2:, 1:-1] + padded[1:-1, :-2] + padded[1:-1, 2:]) / 4
        value[hole] = average[hole]
    return value


def erase(rgba, eye, rng):
    height, width = rgba.shape[:2]
    pad = int(eye['half_major'] + SOCKET_MARGIN + FEATHER + 40)
    x0, x1 = max(int(eye['cx']) - pad, 0), min(int(eye['cx']) + pad, width)
    y0, y1 = max(int(eye['cy']) - pad, 0), min(int(eye['cy']) + pad, height)
    crop = rgba[y0:y1, x0:x1, :3].astype(np.float64)
    local = dict(eye, cx=eye['cx'] - x0, cy=eye['cy'] - y0)
    hole = capsule(crop.shape[:2], local, SOCKET_MARGIN + FEATHER)
    inner = capsule(crop.shape[:2], local, SOCKET_MARGIN)
    filled = np.stack([laplace_fill(crop[..., c], hole) for c in range(3)], axis=-1)

    # Grain: match the fine noise of the marble around the socket. A robust estimate (median
    # absolute deviation) keeps hair edges and the cutout silhouette near the ring from inflating it.
    image = Image.fromarray(crop.astype(np.uint8))
    detail = (crop - np.asarray(image.filter(ImageFilter.GaussianBlur(1.5)), dtype=np.float64)).mean(axis=-1)
    ring = capsule(crop.shape[:2], local, SOCKET_MARGIN + FEATHER + 24) & ~hole
    sigma = 1.4826 * np.median(np.abs(detail[ring] - np.median(detail[ring])))
    grain = rng.normal(0, 1, crop.shape[:2])
    kernel = np.exp(-np.arange(-2, 3) ** 2 / (2 * 0.6 ** 2)); kernel /= kernel.sum()
    grain = np.apply_along_axis(np.convolve, 0, np.apply_along_axis(np.convolve, 1, grain, kernel, 'same'), kernel, 'same')
    filled += (grain / grain.std() * sigma)[..., None]

    weight = np.asarray(Image.fromarray((inner * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(FEATHER / 1.5)), dtype=np.float64) / 255
    weight[~hole] = 0
    blended = crop * (1 - weight[..., None]) + np.clip(filled, 0, 255) * weight[..., None]
    rgba[y0:y1, x0:x1, :3] = np.clip(np.rint(blended), 0, 255).astype(np.uint8)


def eye_record(eye, width, height):
    return dict(cx=eye['cx'] / width, cy=eye['cy'] / height, rx=eye['rx'] / width, ry=eye['ry'] / height, rotate=eye['rotate'])


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--src', help='directory holding the original (baked-eye) PNGs; default: read them from git')
    parser.add_argument('--out', default=str(AVATARS), help='directory to write the eyeless PNGs and manifest.json into')
    args = parser.parse_args()
    out = pathlib.Path(args.out)
    manifest = json.loads((AVATARS / 'manifest.json').read_text())
    for entry in manifest:
        original = load_original(entry['file'], args.src)
        rgba = np.array(original)
        height, width = rgba.shape[:2]
        left, right = (measure(mask) for mask in find_eyes(rgba))
        rng = np.random.default_rng(zlib_seed(entry['id']))
        for eye in (left, right):
            erase(rgba, eye, rng)
        Image.fromarray(rgba, 'RGBA').save(out / entry['file'], optimize=True)
        L, R = eye_record(left, width, height), eye_record(right, width, height)
        radius, aspect = L['rx'], L['ry'] / L['rx']
        r4 = lambda value: round(float(value), 4)
        entry['eyes'] = dict(enabled=True, style='obsidian', radius=r4(radius), aspect=round(float(aspect), 3),
            left=dict(x=r4(L['cx']), y=r4(L['cy']), scaleX=1, scaleY=1, rotate=round(float(L['rotate']), 1)),
            right=dict(x=r4(R['cx']), y=r4(R['cy']), scaleX=r4(R['rx'] / radius), scaleY=r4(R['ry'] / (radius * aspect)), rotate=round(float(R['rotate']), 1)))
        entry['eyes']['travel'] = {**DEFAULT_TRAVEL, **TRAVEL.get(entry['file'].removesuffix('.png'), {})}
        print(entry['file'], json.dumps(entry['eyes']))
    (out / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')


def zlib_seed(text):
    import zlib
    return zlib.crc32(text.encode())


if __name__ == '__main__':
    main()
