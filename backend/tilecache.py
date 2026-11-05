"""Map tiles for anywhere in Bali, not only the pre-downloaded corridor.

`npm run tiles` copies the island into data/tiles so the demo works offline. When a tile is missing
(an area nobody downloaded yet), this module reads it from the same Protomaps OpenStreetMap build over
HTTP range requests, gunzips it, and stores it in data/tiles, so it is offline from then on.
No internet: it answers None fast and stays quiet for a minute before trying again.

PMTiles v3 reading follows the public spec (github.com/protomaps/PMTiles/blob/main/spec/v3/spec.md).
"""

from __future__ import annotations

import gzip
import os
import struct
import threading
import time
import urllib.request
from collections import OrderedDict
from pathlib import Path

BUILD_URL = os.environ.get("PMTILES_URL", "https://build.protomaps.com/20261101.pmtiles")
# Only Bali is ever fetched (same box as the map's maxBounds).
BALI = (114.3, -9.05, 115.95, -7.9)
TIMEOUT_S = 6
OFFLINE_BACKOFF_S = 60


def _varint(buf: bytes, pos: int) -> tuple[int, int]:
    result = shift = 0
    while True:
        b = buf[pos]
        pos += 1
        result |= (b & 0x7F) << shift
        if b < 0x80:
            return result, pos
        shift += 7


def _zxy_to_tile_id(z: int, x: int, y: int) -> int:
    acc = sum(4**i for i in range(z))
    tx, ty = x, y
    d = 0
    s = (1 << z) // 2
    while s > 0:
        rx = 1 if tx & s else 0
        ry = 1 if ty & s else 0
        d += s * s * ((3 * rx) ^ ry)
        if ry == 0:
            if rx == 1:
                tx, ty = s - 1 - tx, s - 1 - ty
            tx, ty = ty, tx
        s //= 2
    return acc + d


def _deserialize_directory(raw: bytes) -> list[tuple[int, int, int, int]]:
    """Entries as (tile_id, offset, length, run_length); run_length 0 points at a leaf directory."""
    n, pos = _varint(raw, 0)
    ids, runs, lengths, offsets = [0] * n, [0] * n, [0] * n, [0] * n
    last = 0
    for i in range(n):
        delta, pos = _varint(raw, pos)
        last += delta
        ids[i] = last
    for i in range(n):
        runs[i], pos = _varint(raw, pos)
    for i in range(n):
        lengths[i], pos = _varint(raw, pos)
    for i in range(n):
        v, pos = _varint(raw, pos)
        offsets[i] = offsets[i - 1] + lengths[i - 1] if v == 0 and i > 0 else v - 1
    return list(zip(ids, offsets, lengths, runs))


def _find(entries: list[tuple[int, int, int, int]], tile_id: int) -> tuple[int, int, int, int] | None:
    lo, hi = 0, len(entries) - 1
    while lo <= hi:
        mid = (lo + hi) // 2
        if entries[mid][0] < tile_id:
            lo = mid + 1
        elif entries[mid][0] > tile_id:
            hi = mid - 1
        else:
            return entries[mid]
    if hi >= 0:
        e = entries[hi]
        if e[3] == 0 or tile_id - e[0] < e[3]:
            return e
    return None


def _in_bali(z: int, x: int, y: int) -> bool:
    import math

    n = 2**z
    west = x / n * 360 - 180
    east = (x + 1) / n * 360 - 180
    north = math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * y / n))))
    south = math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * (y + 1) / n))))
    w, s, e, nn = BALI
    return east > w and west < e and north > s and south < nn


class RemoteTiles:
    def __init__(self, url: str = BUILD_URL) -> None:
        self.url = url
        self._lock = threading.Lock()
        self._header: dict[str, int] | None = None
        self._root: list[tuple[int, int, int, int]] | None = None
        self._leaves: OrderedDict[int, list[tuple[int, int, int, int]]] = OrderedDict()
        self._offline_until = 0.0

    def _get(self, offset: int, length: int) -> bytes:
        req = urllib.request.Request(self.url, headers={"Range": f"bytes={offset}-{offset + length - 1}", "User-Agent": "bali-streetlens"})
        with urllib.request.urlopen(req, timeout=TIMEOUT_S) as res:
            return res.read()

    def _decompress(self, raw: bytes, kind: int) -> bytes:
        return gzip.decompress(raw) if kind == 2 else raw

    def _ensure_header(self) -> None:
        if self._header is not None:
            return
        raw = self._get(0, 16384)
        if raw[:7] != b"PMTiles" or raw[7] != 3:
            raise RuntimeError("not a PMTiles v3 archive")
        (root_off, root_len, _mo, _ml, leaf_off, _ll, data_off) = struct.unpack_from("<7Q", raw, 8)
        header = {"leaf_off": leaf_off, "data_off": data_off, "internal": raw[97], "tile": raw[98]}
        self._root = _deserialize_directory(self._decompress(raw[root_off : root_off + root_len], header["internal"]))
        self._header = header

    def _leaf(self, offset: int, length: int) -> list[tuple[int, int, int, int]]:
        assert self._header is not None
        key = self._header["leaf_off"] + offset
        if key in self._leaves:
            self._leaves.move_to_end(key)
            return self._leaves[key]
        entries = _deserialize_directory(self._decompress(self._get(key, length), self._header["internal"]))
        self._leaves[key] = entries
        if len(self._leaves) > 64:
            self._leaves.popitem(last=False)
        return entries

    def tile(self, z: int, x: int, y: int) -> bytes | None:
        """Decompressed tile bytes, b"" for a tile the build doesn't have, None when unreachable."""
        if not _in_bali(z, x, y) or time.monotonic() < self._offline_until:
            return b"" if not _in_bali(z, x, y) else None
        try:
            with self._lock:
                self._ensure_header()
                assert self._header is not None and self._root is not None
                tile_id = _zxy_to_tile_id(z, x, y)
                entries = self._root
                for _depth in range(4):
                    entry = _find(entries, tile_id)
                    if entry is None:
                        return b""
                    if entry[3] > 0:
                        offset, length = entry[1], entry[2]
                        break
                    entries = self._leaf(entry[1], entry[2])
                else:
                    return b""
            raw = self._get(self._header["data_off"] + offset, length)
            return self._decompress(raw, self._header["tile"])
        except Exception:  # noqa: BLE001 - no internet, DNS, timeout: the map just shows the blank tile
            self._offline_until = time.monotonic() + OFFLINE_BACKOFF_S
            return None


def store(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".part")
    tmp.write_bytes(data)
    tmp.replace(path)
