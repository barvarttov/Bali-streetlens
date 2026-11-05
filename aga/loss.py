import torch
import torch.nn.functional as F


def focal_loss(logits, gt):
    """Penalty-reduced focal loss on the heatmap (CenterNet)."""
    pred = logits.float().sigmoid().clamp(1e-4, 1 - 1e-4)
    pos = gt.eq(1).float()
    neg_w = (1 - gt) ** 4
    pos_loss = (torch.log(pred) * (1 - pred) ** 2 * pos).sum()
    neg_loss = (torch.log(1 - pred) * pred ** 2 * neg_w * (1 - pos)).sum()
    return -(pos_loss + neg_loss) / pos.sum().clamp(min=1)


def gather_feat(feat, ind):
    """feat (B,C,H,W), ind (B,K) -> (B,K,C)."""
    b, c = feat.shape[:2]
    flat = feat.float().view(b, c, -1).permute(0, 2, 1)
    return flat.gather(1, ind.unsqueeze(2).expand(-1, -1, c))


def l1_at(feat, ind, mask, target):
    pred = gather_feat(feat, ind)
    m = mask.unsqueeze(2)
    return (F.l1_loss(pred * m, target * m, reduction="sum")) / (m.sum() * 2).clamp(min=1)


def total_loss(out, batch):
    heat = focal_loss(out["heat"], batch["heat"])
    wh = l1_at(out["wh"], batch["ind"], batch["mask"], batch["wh"])
    off = l1_at(out["off"], batch["ind"], batch["mask"], batch["off"])
    return heat + wh + off, {"heat": heat.item(), "wh": wh.item(), "off": off.item()}
