"""Train AGA from random weights (no pretrained model) and save models/AGA_Model.pt.

Run from the project root:
    .\\.venv\\Scripts\\python.exe -m aga.train --epochs 150
"""
import argparse
import json
import math
import sys
import time
from pathlib import Path

import torch
from torch.utils.data import DataLoader

from aga.data import YoloDetDataset, collate
from aga.decode import decode
from aga.loss import total_loss
from aga.metrics import average_precision
from aga.model import AGANet

CLASSES = ["motorcycle", "car", "bus", "truck"]


@torch.no_grad()
def evaluate(model, loader, device):
    model.eval()
    dets, gts = [], []
    for batch in loader:
        with torch.autocast("cuda", enabled=device == "cuda"):
            out = model(batch["img"].to(device))
        for (b, s, c), gb, gc in zip(decode(out, AGANet.STRIDE, score_thresh=0.05), batch["boxes"], batch["cls"]):
            dets.append((b.cpu().numpy(), s.cpu().numpy(), c.cpu().numpy()))
            gts.append((gb, gc))
    aps = {n: average_precision(dets, gts, i) for i, n in enumerate(CLASSES)}
    present = [v for v in aps.values() if v is not None]
    return (sum(present) / len(present) if present else 0.0), aps


def save(path, model, cfg, metrics, epoch):
    path.parent.mkdir(parents=True, exist_ok=True)
    torch.save({"state": model.state_dict(), "config": cfg, "metrics": metrics, "epoch": epoch}, path)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--data", default="data/kaggle_vehicles")
    ap.add_argument("--epochs", type=int, default=150)
    ap.add_argument("--batch", type=int, default=16)
    ap.add_argument("--size", type=int, default=640)
    ap.add_argument("--width", type=int, default=32)
    ap.add_argument("--lr", type=float, default=1e-3)
    ap.add_argument("--workers", type=int, default=2)
    ap.add_argument("--eval-every", type=int, default=5)
    ap.add_argument("--out", type=Path, default=Path("models/AGA_Model.pt"))
    ap.add_argument("--init", type=Path, help="continue from your own AGA checkpoint (stage 2: fine-tune on CCTV data)")
    ap.add_argument("--scale", type=float, nargs=2, default=(0.35, 1.25), metavar=("MIN", "MAX"),
                    help="random zoom range in augmentation; >1 zooms in (CCTV: 0.8 1.6 keeps small vehicles big)")
    ap.add_argument("--save-last", action="store_true",
                    help="keep the final epoch, not the best on val; use when val is not the data you care about "
                         "(Kaggle val favours Kaggle's squat motorcycle boxes over CCTV boxes that include the rider)")
    args = ap.parse_args()
    if not 0 < args.scale[0] <= args.scale[1]:
        sys.exit("--scale needs 0 < MIN <= MAX")

    if not torch.cuda.is_available():
        sys.exit("CUDA is not available; refusing to train on CPU.")
    device = "cuda"
    cfg = {"num_classes": len(CLASSES), "width": args.width, "head_channels": 64,
           "input_size": args.size, "classes": CLASSES, "stride": AGANet.STRIDE, "aug_scale": list(args.scale)}

    train_ds = YoloDetDataset(args.data, "train", args.size, train=True, scale=tuple(args.scale))
    val_ds = YoloDetDataset(args.data, "val", args.size, train=False)
    kw = dict(num_workers=args.workers, collate_fn=collate, persistent_workers=args.workers > 0)
    train_dl = DataLoader(train_ds, args.batch, shuffle=True, drop_last=True, **kw)
    val_dl = DataLoader(val_ds, args.batch, shuffle=False, **kw)

    model = AGANet(cfg["num_classes"], cfg["width"], cfg["head_channels"]).to(device)
    if args.init:
        if args.init.resolve() == args.out.resolve():
            sys.exit("--init and --out are the same file; the stage-1 weights would be overwritten. Pick a new --out.")
        ckpt = torch.load(args.init, map_location=device, weights_only=True)
        if ckpt["config"]["width"] != cfg["width"] or ckpt["config"]["head_channels"] != cfg["head_channels"]:
            sys.exit(f"--init was trained with width {ckpt['config']['width']}; pass the same --width.")
        model.load_state_dict(ckpt["state"])
        origin = f"continued from {args.init} (epoch {ckpt['epoch']})"
    else:
        origin = "random init"
    params = sum(p.numel() for p in model.parameters())
    print(f"AGA: {params / 1e6:.2f}M parameters, {origin}, {len(train_ds)} train / {len(val_ds)} val images")
    opt = torch.optim.AdamW(model.parameters(), lr=args.lr, weight_decay=1e-4)
    total_steps = args.epochs * len(train_dl)
    warm = 3 * len(train_dl)
    sched = torch.optim.lr_scheduler.LambdaLR(
        opt, lambda s: (s + 1) / warm if s < warm else 0.5 * (1 + math.cos(math.pi * (s - warm) / max(1, total_steps - warm))) * 0.98 + 0.02)
    scaler = torch.amp.GradScaler("cuda")

    best, log = -1.0, []
    for epoch in range(1, args.epochs + 1):
        model.train()
        t0, run = time.time(), 0.0
        for batch in train_dl:
            batch = {k: (v.to(device, non_blocking=True) if torch.is_tensor(v) else v) for k, v in batch.items()}
            with torch.autocast("cuda"):
                out = model(batch["img"])
            loss, parts = total_loss(out, batch)
            if not torch.isfinite(loss):
                sys.exit(f"loss became {loss.item()} at epoch {epoch}; lower --lr")
            opt.zero_grad(set_to_none=True)
            scaler.scale(loss).backward()
            scaler.unscale_(opt)
            torch.nn.utils.clip_grad_norm_(model.parameters(), 10.0)
            scaler.step(opt)
            scaler.update()
            sched.step()
            run += loss.item()
        entry = {"epoch": epoch, "loss": run / len(train_dl), "sec": round(time.time() - t0, 1)}
        if epoch % args.eval_every == 0 or epoch == args.epochs:
            m_ap, aps = evaluate(model, val_dl, device)
            entry.update({"mAP50": m_ap, "AP50": aps})
            if m_ap > best or (args.save_last and epoch == args.epochs):
                best = max(best, m_ap)
                save(args.out, model, cfg, {"mAP50": m_ap, "AP50": aps, "val_images": len(val_ds)}, epoch)
                entry["saved"] = True
        log.append(entry)
        print(json.dumps(entry, default=float), flush=True)
    Path("runs/aga").mkdir(parents=True, exist_ok=True)
    Path("runs/aga/log.json").write_text(json.dumps(log, default=float, indent=1), encoding="utf-8")
    print(f"done. best mAP50 on Kaggle val = {best:.3f}. weights: {args.out}")


if __name__ == "__main__":
    main()
