import torch
import torch.nn.functional as F


def decode(out, stride=4, k=100, score_thresh=0.05):
    """Network output -> per-image (boxes xyxy in input pixels, scores, class ids)."""
    heat = out["heat"].float().sigmoid()
    keep = (F.max_pool2d(heat, 3, 1, 1) == heat).float()  # 3x3 peak picking acts as NMS
    heat = heat * keep
    b, c, h, w = heat.shape
    k = min(k, c * h * w)
    scores, idx = heat.view(b, -1).topk(k)
    cls = idx // (h * w)
    pix = idx % (h * w)
    ys, xs = (pix // w).float(), (pix % w).float()
    wh = out["wh"].float().view(b, 2, -1).gather(2, pix.unsqueeze(1).expand(-1, 2, -1))
    off = out["off"].float().view(b, 2, -1).gather(2, pix.unsqueeze(1).expand(-1, 2, -1))
    bw, bh = wh[:, 0].clamp(max=8).exp(), wh[:, 1].clamp(max=8).exp()
    cx, cy = xs + off[:, 0], ys + off[:, 1]
    boxes = torch.stack([cx - bw / 2, cy - bh / 2, cx + bw / 2, cy + bh / 2], dim=2) * stride
    results = []
    for i in range(b):
        m = scores[i] >= score_thresh
        results.append((boxes[i][m], scores[i][m], cls[i][m]))
    return results
