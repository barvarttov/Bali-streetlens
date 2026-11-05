"""AP at IoU 0.5 per class (all-point interpolation), numpy only."""
import numpy as np


def iou_one_to_many(box, boxes):
    ix = np.clip(np.minimum(box[2], boxes[:, 2]) - np.maximum(box[0], boxes[:, 0]), 0, None)
    iy = np.clip(np.minimum(box[3], boxes[:, 3]) - np.maximum(box[1], boxes[:, 1]), 0, None)
    inter = ix * iy
    union = (box[2] - box[0]) * (box[3] - box[1]) + (boxes[:, 2] - boxes[:, 0]) * (boxes[:, 3] - boxes[:, 1]) - inter
    return inter / np.maximum(union, 1e-9)


def average_precision(dets, gts, cls, iou_thr=0.5):
    """dets: list per image of (boxes, scores, classes). gts: list per image of (boxes, classes)."""
    n_gt = sum(int((g[1] == cls).sum()) for g in gts)
    if n_gt == 0:
        return None
    records = []
    for img_i, (boxes, scores, classes) in enumerate(dets):
        for b, s in zip(boxes[classes == cls], scores[classes == cls]):
            records.append((float(s), img_i, b))
    records.sort(key=lambda r: -r[0])
    used = [np.zeros(int((g[1] == cls).sum()), bool) for g in gts]
    tp = np.zeros(len(records))
    for n, (_s, img_i, b) in enumerate(records):
        gt_boxes = gts[img_i][0][gts[img_i][1] == cls]
        if len(gt_boxes) == 0:
            continue
        ious = iou_one_to_many(b, gt_boxes)
        ious[used[img_i]] = -1
        j = int(ious.argmax())
        if ious[j] >= iou_thr:
            used[img_i][j] = True
            tp[n] = 1
    ctp = np.cumsum(tp)
    cfp = np.cumsum(1 - tp)
    recall = ctp / n_gt
    precision = ctp / np.maximum(ctp + cfp, 1e-9)
    mrec = np.concatenate([[0], recall, [1]])
    mpre = np.concatenate([[0], precision, [0]])
    for i in range(len(mpre) - 2, -1, -1):
        mpre[i] = max(mpre[i], mpre[i + 1])
    idx = np.where(mrec[1:] != mrec[:-1])[0]
    return float(((mrec[idx + 1] - mrec[idx]) * mpre[idx + 1]).sum())
