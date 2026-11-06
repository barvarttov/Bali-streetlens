"""Export AGA (models/AGA_Model_cctv6.pt) to ONNX so the hosted site can run it without torch.

Run on a machine with torch, from the repo root, after every retrain:
    python tools/export_aga_onnx.py            (pip install onnx first)
Then commit models/AGA_Model_cctv6.onnx. backend/aga_onnx.py reads it with onnxruntime.

The graph includes the sigmoid and the 3x3 peak picking of aga/decode.py; the class names, input size and
stride are stored in the model's metadata ("aga_config"). The script checks that ONNX gives the same
detections as torch on a random image before it writes anything.
"""

import json
import sys
import tempfile
from pathlib import Path

import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from aga.model import AGANet  # noqa: E402

SRC = ROOT / "models" / "AGA_Model_cctv6.pt"
DST = ROOT / "models" / "AGA_Model_cctv6.onnx"


class Exported(nn.Module):
    def __init__(self, model: AGANet):
        super().__init__()
        self.model = model

    def forward(self, x):
        out = self.model(x)
        heat = out["heat"].float().sigmoid()
        heat = heat * (F.max_pool2d(heat, 3, 1, 1) == heat).float()
        return heat, out["wh"], out["off"]


def main() -> None:
    import onnx
    import onnxruntime as ort

    ckpt = torch.load(SRC, map_location="cpu", weights_only=True)
    cfg = ckpt["config"]
    model = AGANet(cfg["num_classes"], cfg["width"], cfg["head_channels"])
    model.load_state_dict(ckpt["state"])
    model.eval()
    wrapped = Exported(model).eval()
    size = cfg["input_size"]
    x = torch.rand(1, 3, size, size)

    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "aga.onnx"
        torch.onnx.export(wrapped, x, str(path), input_names=["image"], output_names=["heat", "wh", "off"],
                          opset_version=17, dynamo=False)
        proto = onnx.load(str(path))
        meta = {"classes": cfg["classes"], "input_size": size, "stride": cfg.get("stride", AGANet.STRIDE)}
        proto.metadata_props.add(key="aga_config", value=json.dumps(meta))
        onnx.save(proto, str(path))

        with torch.no_grad():
            want = [t.numpy() for t in wrapped(x)]
        got = ort.InferenceSession(str(path), providers=["CPUExecutionProvider"]).run(None, {"image": x.numpy()})
        for name, a, b in zip(("heat", "wh", "off"), want, got):
            err = float(np.abs(a - b).max())
            print(f"{name}: max difference {err:.2e}")
            if err > 1e-3:
                raise SystemExit(f"ONNX output '{name}' differs from torch; not writing {DST.name}")
        DST.write_bytes(path.read_bytes())
    print(f"wrote {DST.relative_to(ROOT)} ({DST.stat().st_size / 1e6:.1f} MB)")


if __name__ == "__main__":
    main()
