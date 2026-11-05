"""Turn ground-truth boxes into CenterNet training targets (numpy, runs in workers)."""
import math

import numpy as np

MAX_OBJS = 128


def gaussian_radius(h, w, min_overlap=0.7):
    a1, b1, c1 = 1, h + w, w * h * (1 - min_overlap) / (1 + min_overlap)
    r1 = (b1 + math.sqrt(b1 ** 2 - 4 * a1 * c1)) / 2
    a2, b2, c2 = 4, 2 * (h + w), (1 - min_overlap) * w * h
    r2 = (b2 + math.sqrt(b2 ** 2 - 4 * a2 * c2)) / 2
    a3, b3, c3 = 4 * min_overlap, -2 * min_overlap * (h + w), (min_overlap - 1) * w * h
    r3 = (b3 + math.sqrt(b3 ** 2 - 4 * a3 * c3)) / 2
    return min(r1, r2, r3)


def draw_gaussian(heat, cx, cy, radius):
    d = 2 * radius + 1
    sigma = d / 6
    ys, xs = np.ogrid[-radius:radius + 1, -radius:radius + 1]
    g = np.exp(-(xs * xs + ys * ys) / (2 * sigma * sigma))
    h, w = heat.shape
    left, right = min(cx, radius), min(w - cx, radius + 1)
    top, bottom = min(cy, radius), min(h - cy, radius + 1)
    patch = heat[cy - top:cy + bottom, cx - left:cx + right]
    np.maximum(patch, g[radius - top:radius + bottom, radius - left:radius + right], out=patch)


def encode(boxes, classes, num_classes, in_size, stride):
    """boxes: (N,4) xyxy in input pixels. Returns heat, wh, off, ind, mask."""
    out = in_size // stride
    heat = np.zeros((num_classes, out, out), np.float32)
    wh = np.zeros((MAX_OBJS, 2), np.float32)
    off = np.zeros((MAX_OBJS, 2), np.float32)
    ind = np.zeros(MAX_OBJS, np.int64)
    mask = np.zeros(MAX_OBJS, np.float32)
    k = 0
    for (x1, y1, x2, y2), c in zip(boxes, classes):
        bw, bh = (x2 - x1) / stride, (y2 - y1) / stride
        if min(bw, bh) < 0.5 or k >= MAX_OBJS:  # under 2 px: not learnable
            continue
        cx, cy = (x1 + x2) / 2 / stride, (y1 + y2) / 2 / stride
        ix, iy = min(out - 1, max(0, int(cx))), min(out - 1, max(0, int(cy)))
        radius = max(0, int(gaussian_radius(math.ceil(bh), math.ceil(bw))))
        draw_gaussian(heat[int(c)], ix, iy, radius)
        wh[k] = (math.log(bw), math.log(bh))
        off[k] = (cx - ix, cy - iy)
        ind[k] = iy * out + ix
        mask[k] = 1.0
        k += 1
    return heat, wh, off, ind, mask
