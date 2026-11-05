"""Score AGA checkpoints on the SAME images so the numbers are comparable.

Different training runs print scores on different validation sets, so compare here instead.
--prefix picks one source inside data/combined_v1 (kv_ = Vehicle Dataset for YOLO, iv_ = india_vehicles).
For CCTV, point --data at data/cctv_eval after you have hand-corrected labels.

Example:
    .\\.venv\\Scripts\\python.exe -m aga.evaluate models\\AGA_Model_run1_kaggle.pt models\\AGA_Model_v2.pt --prefix kv_
"""
import argparse
import sys
from pathlib import Path

import torch
from torch.utils.data import DataLoader

from aga.data import IMG_EXT, YoloDetDataset, collate
from aga.infer import load_aga
from aga.train import evaluate


def filter_by_prefix(images, prefix):
    return [p for p in images if p.name.startswith(prefix)] if prefix else list(images)


def flat_dataset(root: Path, split: str, size: int, prefix: str):
    """Dataset over root/images/<split> (or root/images for cctv_eval) with an optional filename prefix."""
    images_dir = root / "images" / split if (root / "images" / split).is_dir() else root / "images"
    labels_dir = root / "labels" / split if (root / "labels" / split).is_dir() else root / "labels"
    ds = YoloDetDataset.__new__(YoloDetDataset)
    ds.images = filter_by_prefix(sorted(p for p in images_dir.iterdir() if p.suffix.lower() in IMG_EXT), prefix)
    ds.label_dir, ds.size, ds.num_classes, ds.stride, ds.train, ds.seed = labels_dir, size, 4, 4, False, 0
    return ds


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("weights", nargs="+", type=Path)
    ap.add_argument("--data", type=Path, default=Path("data/combined_v1"))
    ap.add_argument("--split", default="val")
    ap.add_argument("--prefix", default="", help="only images whose file name starts with this")
    ap.add_argument("--workers", type=int, default=0)
    ap.add_argument("--size", type=int, help="inference size (default: the size the model was trained at); "
                                             "analyze.py runs CCTV at 1280, so score at that size too")
    ap.add_argument("--batch", type=int, default=16)
    args = ap.parse_args()
    if args.size is not None and (args.size <= 0 or args.size % 32):
        sys.exit("--size must be a positive multiple of 32")

    device = "cuda" if torch.cuda.is_available() else "cpu"
    for w in args.weights:
        model, cfg = load_aga(w, device)
        size = args.size or cfg["input_size"]
        ds = flat_dataset(args.data, args.split, size, args.prefix)
        if not len(ds):
            sys.exit(f"no images under {args.data} for split '{args.split}' and prefix '{args.prefix}'")
        dl = DataLoader(ds, args.batch, shuffle=False, num_workers=args.workers, collate_fn=collate)
        m_ap, aps = evaluate(model, dl, device)
        per = "  ".join(f"{k} {v:.3f}" if v is not None else f"{k} n/a" for k, v in aps.items())
        print(f"{w.name} @{size}: {len(ds)} images  mAP50 {m_ap:.3f}  |  {per}")


if __name__ == "__main__":
    main()
