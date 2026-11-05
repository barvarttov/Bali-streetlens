"""Load AGA_Model.pt and detect vehicles in a BGR image (OpenCV array)."""
import cv2
import torch

from aga.data import letterbox
from aga.decode import decode
from aga.model import AGANet


def load_aga(path, device="cpu"):
    ckpt = torch.load(path, map_location=device, weights_only=True)
    cfg = ckpt["config"]
    model = AGANet(cfg["num_classes"], cfg["width"], cfg["head_channels"]).to(device)
    model.load_state_dict(ckpt["state"])
    model.eval()
    return model, cfg


@torch.no_grad()
def detect(model, cfg, bgr, conf=0.3, device="cpu"):
    """Returns [{'cls': name, 'conf': float, 'bbox_px': [x1,y1,x2,y2]}] in original image pixels."""
    size = cfg["input_size"]
    canvas, r, px, py = letterbox(bgr, size)
    x = torch.from_numpy(cv2.cvtColor(canvas, cv2.COLOR_BGR2RGB)).permute(2, 0, 1).float().div(255).unsqueeze(0)
    boxes, scores, cls = decode(model(x.to(device)), AGANet.STRIDE, score_thresh=conf)[0]
    out = []
    for b, s, c in zip(boxes.tolist(), scores.tolist(), cls.tolist()):
        x1, y1, x2, y2 = (b[0] - px) / r, (b[1] - py) / r, (b[2] - px) / r, (b[3] - py) / r
        out.append({"cls": cfg["classes"][c], "conf": s, "bbox_px": [x1, y1, x2, y2]})
    return out
