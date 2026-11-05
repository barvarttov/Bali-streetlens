"""Synthetic live feed for the corridor junctions, used until real camera streams exist.

Every value is a pure function of wall-clock time, so the 30-minute history is consistent with
the "now" state and restarts change nothing. Payloads are marked "source": "synthetic", and the
app shows a banner for that. The shape matches the "Live junction state" section of docs/schema.md;
the real pipeline replaces this module, not the app.
"""

from __future__ import annotations

import hashlib
import time
from datetime import datetime, timezone
from typing import Any

# The same thresholds as config/*.yaml `queue:` defaults; the "why" view shows them.
MIN_VEHICLES = 5
MIN_STOPPED_S = 10
SUSTAINED_AFTER_S = 30
HISTORY_MINUTES = 30

LABEL_RANK = {"unknown": -1, "lancar": 0, "padat": 1, "macet": 2}

# Per junction: cycle length (min), the arm that carries the scenario, and (start, end, label) phases.
# Arms not named stay lancar, except where `echo` names an arm that is one step milder.
SCENARIOS: dict[str, dict[str, Any]] = {
    "patung-kuda": {"cycle": 24, "arm": "kaja", "echo": "kangin",
                    "phases": [(0, 8, "lancar"), (8, 12, "padat"), (12, 22, "macet"), (22, 24, "padat")]},
    "underpass-ngurah-rai": {"cycle": 18, "arm": "kelod", "phases": [(0, 10, "padat"), (10, 18, "lancar")]},
    "kedonganan": {"cycle": 15, "arm": "kaja", "phases": [(0, 15, "lancar")], "delayed": (5, 9)},
    "unud": {"cycle": 20, "arm": "kaja-kauh", "phases": [(0, 14, "lancar"), (14, 20, "padat")]},
    "taman-griya": {"cycle": 16, "arm": "kauh", "phases": [(0, 9, "padat"), (9, 16, "lancar")]},
    "pintu-tol": {"cycle": 60, "arm": "kangin", "phases": [(0, 60, "lancar")], "offline": (20, 60)},
}


def _noise(*key: Any) -> float:
    """Deterministic 0..1 noise for a key."""
    digest = hashlib.sha256(":".join(map(str, key)).encode()).digest()
    return int.from_bytes(digest[:4], "big") / 2**32


def _iso(epoch: float) -> str:
    return datetime.fromtimestamp(epoch, tz=timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def _phase(scenario: dict[str, Any], minute: int) -> tuple[str, int]:
    """Scenario label for the arm at an absolute minute, and minutes since that phase began."""
    m = minute % scenario["cycle"]
    for start, end, label in scenario["phases"]:
        if start <= m < end:
            return label, m - start
    return "lancar", 0


def _offline(scenario: dict[str, Any], minute: int) -> tuple[bool, int]:
    window = scenario.get("offline")
    if not window:
        return False, 0
    m = minute % scenario["cycle"]
    return window[0] <= m < window[1], minute - (m - window[0])


def _approach(jid: str, arm: str, label: str, minute: int, since_min: int) -> dict[str, Any]:
    n = _noise(jid, arm, minute)
    if label == "macet":
        stopped, stopped_for = 18 + int(n * 10), since_min * 60 + 30 + int(n * 50)
        flow = 4 + int(n * 4)  # still crossing the stop line: a sustained queue, not a red light
        kind = "sustained_queue"
    elif label == "padat":
        # A queue that keeps discharging: always shorter than SUSTAINED_AFTER_S, or it would be macet.
        stopped, stopped_for = 6 + int(n * 6), 12 + int(n * 16)
        flow = 9 + int(n * 6)
        kind = "red_light_stop"
    else:
        stopped, stopped_for = int(n * 4), int(n * 8)
        flow = 6 + int(n * 8)
        kind = "flowing"
    return {
        "arm": arm, "label": label, "kind": kind,
        "stopped": stopped, "stopped_for_s": stopped_for, "flow_per_min": flow,
    }


def label_at(junction: dict[str, Any], minute: int) -> str:
    """The junction's label during an absolute minute (epoch // 60), or "none" while its camera is off.

    The worst approach decides, as in the live state: the scenario arm carries the label, its echo
    is milder and every other arm is lancar.
    """
    scenario = SCENARIOS.get(junction["id"], {"cycle": 10, "arm": "", "phases": [(0, 10, "lancar")]})
    if _offline(scenario, minute)[0]:
        return "none"
    if scenario["arm"] not in {a["id"] for a in junction["arms"]}:
        return "lancar"
    return _phase(scenario, minute)[0]


def junction_state(junction: dict[str, Any], now: float) -> dict[str, Any]:
    jid = junction["id"]
    scenario = SCENARIOS.get(jid, {"cycle": 10, "arm": "", "phases": [(0, 10, "lancar")]})
    minute = int(now // 60)
    arms = [a["id"] for a in junction["arms"]]

    def labels_at(m: int) -> dict[str, tuple[str, int]]:
        label, since = _phase(scenario, m)
        out = {a: ("lancar", 0) for a in arms}
        if scenario["arm"] in out:
            out[scenario["arm"]] = (label, since)
        echo = scenario.get("echo")
        if echo in out and label != "lancar":
            out[echo] = ("padat" if label == "macet" else "lancar", since)
        return out

    def worst(labels: dict[str, tuple[str, int]]) -> str:
        return max((v[0] for v in labels.values()), key=LABEL_RANK.__getitem__, default="unknown")

    history = [label_at(junction, m) for m in range(minute - HISTORY_MINUTES + 1, minute + 1)]

    offline, offline_since_min = _offline(scenario, minute)
    if offline:
        return {
            "id": jid, "camera_state": "offline", "updated_at": _iso(offline_since_min * 60),
            "label": "unknown", "volume_per_min": None, "approaches": [], "why": None,
            "classes_15min": None, "history": history,
        }

    delayed = scenario.get("delayed")
    is_delayed = bool(delayed) and delayed[0] <= minute % scenario["cycle"] < delayed[1]
    lag = 95 if is_delayed else 1 + _noise(jid, "lag", int(now)) * 2

    approaches = [_approach(jid, a, lab, minute, since) for a, (lab, since) in labels_at(minute).items()]
    label = worst({a["arm"]: (a["label"], 0) for a in approaches})
    lead = max(approaches, key=lambda a: (LABEL_RANK[a["label"]], a["stopped"]))
    volume = sum(a["flow_per_min"] for a in approaches) * 3  # all lanes, both directions
    total15 = volume * 15
    moto = 0.72 + _noise(jid, "moto", minute) * 0.08
    classes = {
        "motorcycle": round(total15 * moto),
        "car": round(total15 * (0.94 - moto)),
        "bus": round(total15 * 0.015),
        "truck": round(total15 * 0.045),
    }
    return {
        "id": jid,
        "camera_state": "delayed" if is_delayed else "live",
        "updated_at": _iso(now - lag),
        "label": label,
        "volume_per_min": volume,
        "approaches": approaches,
        "why": {
            "mode": "inferred",
            "arm": lead["arm"],
            "kind": lead["kind"],
            "stopped": lead["stopped"],
            "min_vehicles": MIN_VEHICLES,
            "stopped_for_s": lead["stopped_for_s"],
            "min_stopped_s": MIN_STOPPED_S,
            "flow_per_min": lead["flow_per_min"],
            "sustained_after_s": SUSTAINED_AFTER_S,
        },
        "classes_15min": classes,
        "history": history,
    }


def snapshot(corridor: dict[str, Any], now: float | None = None) -> dict[str, Any]:
    now = time.time() if now is None else now
    return {
        "source": "synthetic",
        "generated_at": _iso(now),
        "junctions": [junction_state(j, now) for j in corridor["junctions"]],
    }
