"""YOLO-format dataset -> CenterNet targets, with augmentation aimed at CCTV.

The Kaggle photos are close-ups, CCTV shows small vehicles, so training
randomly zooms OUT (objects shrink), darkens (night) and blurs (low-res feeds).
"""
from pathlib import Path

import cv2
import numpy as np
import torch
from torch.utils.data import Dataset

from aga.targets import encode

IMG_EXT = {".jpg", ".jpeg", ".png"}
PAD = 114


def read_image(path):
    """cv2.imread fails on non-ASCII Windows paths, so decode the bytes ourselves."""
    data = np.fromfile(str(path), dtype=np.uint8)
    return cv2.imdecode(data, cv2.IMREAD_COLOR) if data.size else None


def letterbox(img, size):
    h, w = img.shape[:2]
    r = size / max(h, w)
    nh, nw = max(1, round(h * r)), max(1, round(w * r))
    resized = cv2.resize(img, (nw, nh), interpolation=cv2.INTER_AREA if r < 1 else cv2.INTER_LINEAR)
    canvas = np.full((size, size, 3), PAD, np.uint8)
    px, py = (size - nw) // 2, (size - nh) // 2
    canvas[py:py + nh, px:px + nw] = resized
    return canvas, r, px, py


def read_labels(path: Path, w, h):
    boxes, cls = [], []
    if path.exists():
        for line in path.read_text(encoding="utf-8").splitlines():
            p = line.split()
            if len(p) < 5:
                continue
            cx, cy, bw, bh = (float(v) for v in p[1:5])
            boxes.append(((cx - bw / 2) * w, (cy - bh / 2) * h, (cx + bw / 2) * w, (cy + bh / 2) * h))
            cls.append(int(p[0]))
    return np.array(boxes, np.float32).reshape(-1, 4), np.array(cls, np.int64)


def augment(img, boxes, cls, size, rng, scale=(0.35, 1.25)):
    # scale > 1 zooms in and crops at a random spot (span < 0); small CCTV vehicles need that more than zoom-out
    s = rng.uniform(*scale)
    span = size - s * size
    tx = rng.uniform(min(0, span), max(0, span))
    ty = rng.uniform(min(0, span), max(0, span))
    m = np.array([[s, 0, tx], [0, s, ty]], np.float32)
    img = cv2.warpAffine(img, m, (size, size), flags=cv2.INTER_LINEAR, borderValue=(PAD, PAD, PAD))
    if len(boxes):
        moved = boxes * s + np.array([tx, ty, tx, ty], np.float32)
        clipped = np.clip(moved, 0, size)
        area_new = np.prod(np.clip(clipped[:, 2:] - clipped[:, :2], 0, None), axis=1)
        area_old = np.prod(moved[:, 2:] - moved[:, :2], axis=1)
        side = (clipped[:, 2:] - clipped[:, :2]).min(axis=1)
        ok = (area_new >= 0.35 * area_old) & (side >= 2)
        boxes, cls = clipped[ok], cls[ok]
    if rng.random() < 0.5:
        img = img[:, ::-1].copy()
        if len(boxes):
            boxes = np.stack([size - boxes[:, 2], boxes[:, 1], size - boxes[:, 0], boxes[:, 3]], axis=1)
    f = img.astype(np.float32) / 255.0
    f = f ** rng.uniform(0.6, 1.9)  # gamma: <1 brighter, >1 darker (night)
    f = (f - 0.5) * rng.uniform(0.7, 1.3) + 0.5 + rng.uniform(-0.1, 0.1)
    img = (np.clip(f, 0, 1) * 255).astype(np.uint8)
    if rng.random() < 0.3:  # mimic low-resolution CCTV
        k = rng.uniform(1.5, 3.0)
        small = cv2.resize(img, (int(size / k), int(size / k)), interpolation=cv2.INTER_AREA)
        img = cv2.resize(small, (size, size), interpolation=cv2.INTER_LINEAR)
    return img, boxes.astype(np.float32), cls


class YoloDetDataset(Dataset):
    def __init__(self, root, split, size=640, num_classes=4, stride=4, train=True, seed=0, scale=(0.35, 1.25)):
        root = Path(root)
        self.images = sorted(p for p in (root / "images" / split).iterdir() if p.suffix.lower() in IMG_EXT)
        self.label_dir = root / "labels" / split
        self.size, self.num_classes, self.stride, self.train, self.seed = size, num_classes, stride, train, seed
        self.scale = scale

    def __len__(self):
        return len(self.images)

    def __getitem__(self, i):
        img = read_image(self.images[i])
        if img is None:
            raise OSError(f"cannot read image {self.images[i]}")
        h, w = img.shape[:2]
        boxes, cls = read_labels(self.label_dir / f"{self.images[i].stem}.txt", w, h)
        img, r, px, py = letterbox(img, self.size)
        if len(boxes):
            boxes = boxes * r + np.array([px, py, px, py], np.float32)
        if self.train:
            rng = np.random.default_rng()
            img, boxes, cls = augment(img, boxes, cls, self.size, rng, self.scale)
        heat, wh, off, ind, mask = encode(boxes, cls, self.num_classes, self.size, self.stride)
        tensor = torch.from_numpy(cv2.cvtColor(img, cv2.COLOR_BGR2RGB)).permute(2, 0, 1).float() / 255.0
        return {
            "img": tensor,
            "heat": torch.from_numpy(heat), "wh": torch.from_numpy(wh), "off": torch.from_numpy(off),
            "ind": torch.from_numpy(ind), "mask": torch.from_numpy(mask),
            "boxes": boxes, "cls": cls,
        }


def collate(items):
    stacked = {k: torch.stack([it[k] for it in items]) for k in ("img", "heat", "wh", "off", "ind", "mask")}
    stacked["boxes"] = [it["boxes"] for it in items]
    stacked["cls"] = [it["cls"] for it in items]
    return stacked
