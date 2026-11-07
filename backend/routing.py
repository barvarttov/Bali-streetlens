"""Route planner for Bali: up to three different routes from A to B, aware of watched junctions.

The road graph is config/roads.json.gz (built by `npm run roads` from OpenStreetMap). Routes are found
with A* on an estimated riding time (by road class). That time is only used to rank roads against each
other; it is never shown, because travel times have not been measured.

Watched junctions change the ranking: entering one from an approach that is padat or macet costs extra,
so the first route prefers to go around a jam. Each route reports which watched junctions it passes and
from which approach, so the app can show their live state next to the route.

Typical south-Bali routes take well under half a second; one across the whole island about three.

Alternatives use the penalty method: after each route is found, its roads are made more expensive and
the search runs again. A new route is kept only if it is mostly different and not much longer.
"""

from __future__ import annotations

import gzip
import heapq
import json
import math
import threading
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

# Riding speed (km/h) per road class, for ranking only. Motorbikes first: Bali's traffic is mostly them.
SPEED_KMH = {
    "motorway": 60, "trunk": 48, "primary": 40, "secondary": 34, "tertiary": 30, "unclassified": 24,
    "residential": 20, "living_street": 10, "motorway_link": 40, "trunk_link": 36, "primary_link": 32,
    "secondary_link": 28, "tertiary_link": 26,
}
MAX_SPEED_MS = max(SPEED_KMH.values()) / 3.6  # keeps the A* estimate admissible
# Extra seconds for entering a watched junction from an approach with this label.
APPROACH_PENALTY_S = {"macet": 420.0, "padat": 120.0, "lancar": 0.0, "unknown": 0.0}
JUNCTION_RADIUS_M = 45.0
MAX_ROUTES = 3
ALT_FACTOR = 1.7  # how much more a found route's roads cost in the next search
MAX_OVERLAP = 0.72  # a new route must be at least 28% different from every kept one
MAX_STRETCH = 1.45  # ...and at most this much costlier than the first
ALT_HEURISTIC_WEIGHT = 1.35  # alternatives search greedier (faster on island-long routes)
MIN_COMPONENT = 300  # never snap to a tiny piece of road cut off from the network
SNAP_MAX_M = 3000.0
CELL = 0.01  # spatial grid cell, degrees (~1.1 km)


class RouteError(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


def _meters(ax: float, ay: float, bx: float, by: float) -> float:
    k = math.cos(math.radians((ay + by) / 2))
    return math.hypot((bx - ax) * 111320 * k, (by - ay) * 110540)


def _bearing(ax: float, ay: float, bx: float, by: float) -> float:
    k = math.cos(math.radians(ay))
    return (math.degrees(math.atan2((bx - ax) * k, by - ay)) + 360) % 360


def _angle(a: float, b: float) -> float:
    d = abs(a - b) % 360
    return min(d, 360 - d)


@dataclass
class Graph:
    xs: list[float]
    ys: list[float]
    # Per edge: endpoints, length (m), class index, name index, flat shape deltas (×1e6)
    ea: list[int]
    eb: list[int]
    elen: list[float]
    ecls: list[int]
    ename: list[int]
    eshape: list[list[int]]
    classes: list[str]
    names: list[str]
    # adj[u] = [(v, seconds, edge id), ...]
    adj: list[list[tuple[int, float, int]]]
    comp: list[int]
    comp_size: list[int]
    grid: dict[tuple[int, int], list[int]] = field(default_factory=dict)
    generated: str = ""
    source: str = ""


def load_graph(path: Path) -> Graph:
    doc = json.loads(gzip.decompress(path.read_bytes()))
    flat = doc["nodes"]
    n = len(flat) // 2
    xs = [flat[2 * i] / 1e6 for i in range(n)]
    ys = [flat[2 * i + 1] / 1e6 for i in range(n)]
    classes: list[str] = doc["classes"]
    speed = [SPEED_KMH.get(c, 20) / 3.6 for c in classes]
    adj: list[list[tuple[int, float, int]]] = [[] for _ in range(n)]
    ea, eb, elen, ecls, ename, eshape = [], [], [], [], [], []
    parent = list(range(n))

    def find(i: int) -> int:
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    for eid, (a, b, dm, cls, name, oneway, shape) in enumerate(doc["edges"]):
        length = dm / 10
        seconds = length / speed[cls]
        ea.append(a)
        eb.append(b)
        elen.append(length)
        ecls.append(cls)
        ename.append(name)
        eshape.append(shape)
        adj[a].append((b, seconds, eid))
        if not oneway:
            adj[b].append((a, seconds, eid))
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[ra] = rb

    roots = [find(i) for i in range(n)]
    counts: dict[int, int] = {}
    for r in roots:
        counts[r] = counts.get(r, 0) + 1
    comp_size = [counts[r] for r in roots]

    grid: dict[tuple[int, int], list[int]] = {}
    for i in range(n):
        if comp_size[i] >= MIN_COMPONENT and adj[i]:
            grid.setdefault((int(xs[i] // CELL), int(ys[i] // CELL)), []).append(i)

    return Graph(xs, ys, ea, eb, elen, ecls, ename, eshape, classes, doc["names"], adj, roots, comp_size, grid,
                 doc.get("generated", ""), doc.get("source", ""))


def snap(g: Graph, lng: float, lat: float) -> tuple[int, float]:
    """Nearest routable node and its distance in meters."""
    cx, cy = int(lng // CELL), int(lat // CELL)
    best, best_d = -1, math.inf
    for ring in range(0, 4):
        for ix in range(cx - ring, cx + ring + 1):
            for iy in range(cy - ring, cy + ring + 1):
                if max(abs(ix - cx), abs(iy - cy)) != ring:
                    continue
                for i in g.grid.get((ix, iy), ()):
                    d = _meters(lng, lat, g.xs[i], g.ys[i])
                    if d < best_d:
                        best, best_d = i, d
        # Anything in a further ring is at least `ring` cells away.
        if best >= 0 and best_d <= ring * CELL * 109_000:
            break
    if best < 0 or best_d > SNAP_MAX_M:
        raise RouteError("far_from_road", "Titik ini terlalu jauh dari jalan yang dikenal.")
    return best, best_d


@dataclass
class WatchedJunction:
    id: str
    cx: float
    cy: float
    nodes: set[int]
    arms: list[tuple[str, float]]  # (arm id, bearing from the centre)


def watched_junctions(g: Graph, corridor: dict[str, Any]) -> list[WatchedJunction]:
    out = []
    for j in corridor.get("junctions", []):
        cx, cy = j["center"]
        cand = []
        for ix in range(int(cx // CELL) - 1, int(cx // CELL) + 2):
            for iy in range(int(cy // CELL) - 1, int(cy // CELL) + 2):
                for i in g.grid.get((ix, iy), ()):
                    cand.append((_meters(cx, cy, g.xs[i], g.ys[i]), i))
        cand.sort()
        nodes = {i for d, i in cand if d <= JUNCTION_RADIUS_M}
        if not nodes and cand and cand[0][0] <= 90:
            nodes = {cand[0][1]}
        if nodes:
            out.append(WatchedJunction(j["id"], cx, cy, nodes, [(a["id"], float(a["bearing"])) for a in j["arms"]]))
    return out


def _arm_for(j: WatchedJunction, x: float, y: float) -> str | None:
    """The approach a vehicle coming from (x, y) uses: the arm pointing that way, within 50°."""
    b = _bearing(j.cx, j.cy, x, y)
    arm, best = None, 50.0
    for arm_id, arm_bearing in j.arms:
        d = _angle(b, arm_bearing)
        if d < best:
            arm, best = arm_id, d
    return arm


class Router:
    def __init__(self, path: Path) -> None:
        self.path = path
        self._graph: Graph | None = None
        self._lock = threading.Lock()
        self._junctions: tuple[int, list[WatchedJunction]] | None = None

    @property
    def available(self) -> bool:
        return self.path.is_file()

    def graph(self) -> Graph:
        with self._lock:
            if self._graph is None:
                if not self.path.is_file():
                    raise RouteError("no_graph", "config/roads.json.gz belum ada. Jalankan `npm run roads` di web/.")
                self._graph = load_graph(self.path)
            return self._graph

    def _watched(self, g: Graph, corridor: dict[str, Any]) -> list[WatchedJunction]:
        key = id(corridor)
        if self._junctions is None or self._junctions[0] != key:
            self._junctions = (key, watched_junctions(g, corridor))
        return self._junctions[1]

    def route(self, start: tuple[float, float], end: tuple[float, float], corridor: dict[str, Any],
              snapshot: dict[str, Any]) -> dict[str, Any]:
        g = self.graph()
        src, src_d = snap(g, *start)
        dst, dst_d = snap(g, *end)
        if g.comp[src] != g.comp[dst]:
            raise RouteError("no_road", "Tidak ada jalan darat yang menghubungkan kedua tempat ini.")
        if src == dst:
            raise RouteError("same_place", "Titik awal dan tujuan terlalu dekat.")

        watched = self._watched(g, corridor)
        node_junction: dict[int, WatchedJunction] = {}
        for j in watched:
            for i in j.nodes:
                node_junction[i] = j
        labels: dict[str, dict[str, str]] = {}
        for js in snapshot.get("junctions", []):
            offline = js.get("camera_state") == "offline"
            labels[js["id"]] = {a["arm"]: ("unknown" if offline else a["label"]) for a in js.get("approaches", [])}

        def entry_penalty(u: int, v: int) -> float:
            j = node_junction.get(v)
            if j is None or node_junction.get(u) is j:
                return 0.0
            arm = _arm_for(j, g.xs[u], g.ys[u])
            return APPROACH_PENALTY_S.get(labels.get(j.id, {}).get(arm or "", "unknown"), 0.0)

        factor: dict[int, float] = {}
        kept: list[tuple[list[int], list[int], float, float]] = []  # nodes, edges, cost, length
        for _ in range(MAX_ROUTES + 3):
            found = _astar(g, src, dst, factor, entry_penalty, node_junction.keys(), 1.0 if not kept else ALT_HEURISTIC_WEIGHT)
            if found is None:
                break
            nodes, edges = found
            cost = sum(_edge_seconds(g, e) for e in edges) + sum(entry_penalty(a, b) for a, b in zip(nodes, nodes[1:]))
            length = sum(g.elen[e] for e in edges)
            if not kept:
                kept.append((nodes, edges, cost, length))
            else:
                best_cost = kept[0][2]
                eset = set(edges)
                overlap = max(sum(g.elen[e] for e in k[1] if e in eset) / max(1.0, length) for k in kept)
                if overlap < MAX_OVERLAP and cost <= best_cost * MAX_STRETCH:
                    kept.append((nodes, edges, cost, length))
            if len(kept) >= MAX_ROUTES:
                break
            for e in edges:
                factor[e] = factor.get(e, 1.0) * ALT_FACTOR
        if not kept:
            raise RouteError("no_route", "Rute tidak ditemukan. Coba titik lain di dekatnya.")

        routes = [_describe(g, nodes, edges, length, node_junction) for nodes, edges, _, length in kept]
        _name_routes(routes)
        for r in routes:
            r.pop("_names")
        return {
            "from": {"lnglat": [start[0], start[1]], "snapped": [g.xs[src], g.ys[src]], "offset_m": round(src_d)},
            "to": {"lnglat": [end[0], end[1]], "snapped": [g.xs[dst], g.ys[dst]], "offset_m": round(dst_d)},
            "routes": routes,
            "source": g.source,
            "graph_generated": g.generated,
        }


def _edge_seconds(g: Graph, e: int) -> float:
    return g.elen[e] / (SPEED_KMH.get(g.classes[g.ecls[e]], 20) / 3.6)


def _astar(g: Graph, src: int, dst: int, factor: dict[int, float], penalty,
           junction_nodes: set[int] | frozenset[int] = frozenset(), weight: float = 1.0) -> tuple[list[int], list[int]] | None:
    """A* on riding seconds. Factors (>= 1) and junction penalties (>= 0) only add cost, so the
    straight-line estimate at the top speed stays a lower bound. weight > 1 trades exactness for speed
    (used for the alternatives, which only need to be good, not optimal)."""
    xs, ys, adj = g.xs, g.ys, g.adj
    tx, ty = xs[dst], ys[dst]
    kx = weight * 111320 * math.cos(math.radians(ty)) / MAX_SPEED_MS
    ky = weight * 110540 / MAX_SPEED_MS
    n = len(xs)
    best = [math.inf] * n
    prev_node = [-1] * n
    prev_edge = [-1] * n
    closed = bytearray(n)
    best[src] = 0.0
    heap = [(math.hypot((xs[src] - tx) * kx, (ys[src] - ty) * ky), 0.0, src)]
    pop, push, hypot, fget = heapq.heappop, heapq.heappush, math.hypot, factor.get
    while heap:
        _, cost, u = pop(heap)
        if closed[u]:
            continue
        if u == dst:
            break
        closed[u] = 1
        for v, sec, e in adj[u]:
            if closed[v]:
                continue
            c = cost + sec * fget(e, 1.0)
            if v in junction_nodes:
                c += penalty(u, v)
            if c < best[v]:
                best[v] = c
                prev_node[v] = u
                prev_edge[v] = e
                push(heap, (c + hypot((xs[v] - tx) * kx, (ys[v] - ty) * ky), c, v))
    if prev_node[dst] < 0:
        return None
    nodes, edges = [dst], []
    while nodes[-1] != src:
        v = nodes[-1]
        edges.append(prev_edge[v])
        nodes.append(prev_node[v])
    nodes.reverse()
    edges.reverse()
    return nodes, edges


def _edge_coords(g: Graph, e: int, forward: bool) -> list[list[float]]:
    a = g.ea[e]
    x, y = round(g.xs[a] * 1e6), round(g.ys[a] * 1e6)
    pts = [[g.xs[a], g.ys[a]]]
    s = g.eshape[e]
    for i in range(0, len(s), 2):
        x += s[i]
        y += s[i + 1]
        pts.append([x / 1e6, y / 1e6])
    b = g.eb[e]
    pts.append([g.xs[b], g.ys[b]])
    return pts if forward else pts[::-1]


def _describe(g: Graph, nodes: list[int], edges: list[int], length: float,
              node_junction: dict[int, WatchedJunction]) -> dict[str, Any]:
    coords: list[list[float]] = []
    by_name: dict[str, float] = {}
    for u, e in zip(nodes, edges):
        pts = _edge_coords(g, e, g.ea[e] == u)
        coords.extend(pts if not coords else pts[1:])
        name = g.names[g.ename[e]]
        if name:
            by_name[name] = by_name.get(name, 0.0) + g.elen[e]
    passed: list[dict[str, Any]] = []
    for u, v in zip(nodes, nodes[1:]):
        j = node_junction.get(v)
        if j is not None and node_junction.get(u) is not j:
            passed.append({"id": j.id, "arm": _arm_for(j, g.xs[u], g.ys[u])})
    # Waypoints that make Google Maps follow this route rather than its own: points at 30% and 65%.
    waypoints = []
    if coords:
        run, targets = 0.0, [0.3 * length, 0.65 * length]
        for a, b in zip(coords, coords[1:]):
            step = _meters(a[0], a[1], b[0], b[1])
            while targets and run + step >= targets[0]:
                waypoints.append([round(b[0], 6), round(b[1], 6)])
                targets.pop(0)
            run += step
    names = sorted(by_name.items(), key=lambda kv: -kv[1])
    return {
        "distance_m": round(length),
        "geometry": [[round(x, 6), round(y, 6)] for x, y in coords],
        "roads": [n for n, _ in names[:4]],
        "junctions": passed,
        "waypoints": waypoints,
        "_names": names,
    }


def _name_routes(routes: list[dict[str, Any]]) -> None:
    """'via': each route's longest road, unless an earlier route already goes by that name; then its
    next longest road that carries a real share of it (a rider recognises main roads, not alleys)."""
    used: set[str] = set()
    for r in routes:
        names = r["_names"]
        share = 0.12 * r["distance_m"]
        via = next((n for n, d in names[:6] if n not in used and d >= share), None)
        if via is None:
            via = next((n for n, _ in names[:6] if n not in used), names[0][0] if names else None)
        if via:
            used.add(via)
        r["via"] = via or None


# ---------------------------------------------------------------------------------------------- road near a camera
#
# An uncalibrated camera's vehicles are known only in image pixels. Rather than drawing them in a guessed box
# around the camera (on roofs, in rice fields), the map lays them along the OSM road nearest to the camera:
# this returns that road around its nearest point. It is still an estimate, and the app says so.

EDGE_CELL = 0.004  # degrees (~440 m): edge index cell
ROAD_WIDTH_M = {
    "motorway": 14.0, "trunk": 12.0, "primary": 10.0, "secondary": 8.0, "tertiary": 7.0, "unclassified": 6.0,
    "residential": 5.5, "living_street": 4.5,
}
# Government CCTV watches main roads: a bigger road may be this many meters farther and still win.
ROAD_PREFERENCE_M = {
    "motorway": 30.0, "trunk": 30.0, "primary": 25.0, "secondary": 20.0, "tertiary": 15.0, "unclassified": 5.0,
    "residential": 0.0, "living_street": -5.0,
}
_edge_index_lock = threading.Lock()


def _edge_index(g: Graph) -> dict[tuple[int, int], list[int]]:
    """Cell -> edges with a vertex in it. Built on first use (about a second), then kept on the graph."""
    with _edge_index_lock:
        idx = getattr(g, "_edge_index", None)
        if idx is None:
            idx = {}
            for e in range(len(g.ea)):
                cells = {(int(x // EDGE_CELL), int(y // EDGE_CELL)) for x, y in _edge_coords(g, e, True)}
                for c in cells:
                    idx.setdefault(c, []).append(e)
            g._edge_index = idx  # type: ignore[attr-defined]
        return idx


def _local(o_lng: float, o_lat: float, lng: float, lat: float) -> tuple[float, float]:
    return (lng - o_lng) * 111320 * math.cos(math.radians(o_lat)), (lat - o_lat) * 110540


def _edges_at(g: Graph, node: int) -> list[int]:
    x, y = g.xs[node], g.ys[node]
    cell = (int(x // EDGE_CELL), int(y // EDGE_CELL))
    return [e for e in _edge_index(g).get(cell, []) if g.ea[e] == node or g.eb[e] == node]


def _continue(g: Graph, node: int, came_from: int, heading: tuple[float, float]) -> tuple[int, list[list[float]]] | None:
    """The straightest edge leaving `node` (not the one we came from), as points starting at `node`."""
    best, best_cos = None, 0.5  # at most ~60 degrees of turn: a junction's side street is not "the same road"
    for e in _edges_at(g, node):
        if e == came_from:
            continue
        pts = _edge_coords(g, e, g.ea[e] == node)
        if len(pts) < 2:
            continue
        dx, dy = _local(pts[0][0], pts[0][1], pts[1][0], pts[1][1])
        n = math.hypot(dx, dy) or 1.0
        c = (dx * heading[0] + dy * heading[1]) / n
        if c > best_cos:
            best, best_cos = (e, pts), c
    return best


def _walk(g: Graph, start: list[list[float]], edge: int, end_node: int, length: float) -> list[list[float]]:
    """Points from start[0] along `start`, then along straight continuations, for `length` meters."""
    out = [start[0]]
    left = length
    pts, e, node = start, edge, end_node
    for _ in range(8):
        for a, b in zip(pts, pts[1:]):
            d = _meters(a[0], a[1], b[0], b[1])
            if d >= left:
                t = left / d if d else 0.0
                out.append([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t])
                return out
            out.append(b)
            left -= d
        hx, hy = _local(pts[-2][0], pts[-2][1], pts[-1][0], pts[-1][1])
        n = math.hypot(hx, hy) or 1.0
        nxt = _continue(g, node, e, (hx / n, hy / n))
        if nxt is None:
            return out
        e, pts = nxt
        node = g.eb[e] if g.ea[e] == node else g.ea[e]
    return out


def road_near(g: Graph, lng: float, lat: float, max_m: float = 150.0, half_m: float = 70.0) -> dict[str, Any] | None:
    """The OSM road nearest to a point, as a line through its nearest point (half_m each way along the road)."""
    idx = _edge_index(g)
    cx, cy = int(lng // EDGE_CELL), int(lat // EDGE_CELL)
    best: tuple[float, int, int, float, list[list[float]]] | None = None
    best_score = math.inf
    for ix in range(cx - 1, cx + 2):
        for iy in range(cy - 1, cy + 2):
            for e in idx.get((ix, iy), ()):
                pts = _edge_coords(g, e, True)
                for i, (a, b) in enumerate(zip(pts, pts[1:])):
                    ax, ay = _local(lng, lat, a[0], a[1])
                    bx, by = _local(lng, lat, b[0], b[1])
                    vx, vy = bx - ax, by - ay
                    L2 = vx * vx + vy * vy
                    t = 0.0 if L2 == 0 else max(0.0, min(1.0, -(ax * vx + ay * vy) / L2))
                    d = math.hypot(ax + vx * t, ay + vy * t)
                    if d > max_m:
                        continue
                    score = d - ROAD_PREFERENCE_M.get(g.classes[g.ecls[e]].replace("_link", ""), 0.0)
                    if score < best_score:
                        best, best_score = (d, e, i, t, pts), score
    if best is None:
        return None
    d, e, i, t, pts = best
    a, b = pts[i], pts[i + 1]
    snap = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]
    forward = _walk(g, [snap] + pts[i + 1:], e, g.eb[e], half_m)
    backward = _walk(g, [snap] + pts[i::-1], e, g.ea[e], half_m)
    line = backward[::-1] + forward[1:]
    cls = g.classes[g.ecls[e]]
    return {
        "name": g.names[g.ename[e]] or None,
        "class": cls,
        "width_m": ROAD_WIDTH_M.get(cls.replace("_link", ""), 6.0),
        "distance_m": round(d, 1),
        "snap": [round(snap[0], 7), round(snap[1], 7)],
        "snap_index": len(backward) - 1,
        "line": [[round(p[0], 7), round(p[1], 7)] for p in line],
    }
