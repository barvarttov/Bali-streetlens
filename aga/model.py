"""AGA detector: a small anchor-free detector, written from scratch, random init.

Idea follows CenterNet ("Objects as Points", Zhou et al. 2019): every object is
a peak in a per-class heatmap, plus its width/height and a sub-cell offset.
No pretrained weights are used anywhere.

Output stride is 4: a 640x640 input gives 160x160 heatmaps.
"""
import torch
import torch.nn as nn
import torch.nn.functional as F


def conv_bn(c_in, c_out, k=3, s=1):
    return nn.Sequential(
        nn.Conv2d(c_in, c_out, k, s, k // 2, bias=False),
        nn.BatchNorm2d(c_out),
        nn.SiLU(inplace=True),
    )


class ResBlock(nn.Module):
    def __init__(self, c_in, c_out, stride):
        super().__init__()
        self.c1 = conv_bn(c_in, c_out, 3, stride)
        self.c2 = nn.Sequential(nn.Conv2d(c_out, c_out, 3, 1, 1, bias=False), nn.BatchNorm2d(c_out))
        if c_in == c_out and stride == 1:
            self.skip = nn.Identity()
        else:
            self.skip = nn.Sequential(nn.Conv2d(c_in, c_out, 1, stride, bias=False), nn.BatchNorm2d(c_out))
        self.act = nn.SiLU(inplace=True)

    def forward(self, x):
        return self.act(self.c2(self.c1(x)) + self.skip(x))


def head(c, out_c, bias=0.0):
    last = nn.Conv2d(c, out_c, 1)
    nn.init.constant_(last.bias, bias)
    return nn.Sequential(conv_bn(c, c, 3), last)


class AGANet(nn.Module):
    STRIDE = 4

    def __init__(self, num_classes=4, width=32, head_channels=64):
        super().__init__()
        w, hc = width, head_channels
        self.stem = nn.Sequential(conv_bn(3, w, 3, 2), conv_bn(w, w, 3, 1))  # /2
        self.s1 = nn.Sequential(ResBlock(w, 2 * w, 2), ResBlock(2 * w, 2 * w, 1))  # /4
        self.s2 = nn.Sequential(ResBlock(2 * w, 4 * w, 2), ResBlock(4 * w, 4 * w, 1))  # /8
        self.s3 = nn.Sequential(ResBlock(4 * w, 8 * w, 2), ResBlock(8 * w, 8 * w, 1), ResBlock(8 * w, 8 * w, 1))  # /16
        self.s4 = nn.Sequential(ResBlock(8 * w, 16 * w, 2), ResBlock(16 * w, 16 * w, 1))  # /32
        self.lat4 = conv_bn(16 * w, hc, 1)
        self.lat3 = conv_bn(8 * w, hc, 1)
        self.lat2 = conv_bn(4 * w, hc, 1)
        self.lat1 = conv_bn(2 * w, hc, 1)
        self.sm3 = conv_bn(hc, hc, 3)
        self.sm2 = conv_bn(hc, hc, 3)
        self.sm1 = conv_bn(hc, hc, 3)
        self.heat = head(hc, num_classes, bias=-2.19)  # start with ~10% peak prior
        self.wh = head(hc, 2)  # log(width), log(height) in output cells
        self.off = head(hc, 2)  # sub-cell centre offset

    def forward(self, x):
        c1 = self.s1(self.stem(x))
        c2 = self.s2(c1)
        c3 = self.s3(c2)
        c4 = self.s4(c3)
        p = self.lat4(c4)
        p = self.sm3(self.lat3(c3) + F.interpolate(p, size=c3.shape[-2:], mode="nearest"))
        p = self.sm2(self.lat2(c2) + F.interpolate(p, size=c2.shape[-2:], mode="nearest"))
        p = self.sm1(self.lat1(c1) + F.interpolate(p, size=c1.shape[-2:], mode="nearest"))
        return {"heat": self.heat(p), "wh": self.wh(p), "off": self.off(p)}
