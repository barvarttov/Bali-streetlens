"""'Tanya lalu lintas': a chat assistant that answers questions about Bali traffic from our own data.

FREE ONLY. The assistant talks to exactly two hosted model APIs, both on their free tiers:
  1. Groq            https://api.groq.com            (GROQ_API_KEY,   free tier, no credit card)
  2. NVIDIA Build    https://integrate.api.nvidia.com (NVIDIA_API_KEY, free for prototyping)
Their URLs are fixed here on purpose: no setting can point the app at a paid service. Groq is tried
first (fastest); NVIDIA takes over when Groq is missing, refuses (rate limit) or is down. Neither can
charge anything as long as no credit card is added to those accounts (see README).

The model never invents numbers. It answers through tools that read the live junction states, today's
history and the route planner, and the system prompt tells it to say plainly what it doesn't know.
Requests are rate-limited here too, so a busy page can't burn through the free quota.
"""

from __future__ import annotations

import json
import logging
import os
import re
import threading
import time
import unicodedata
import urllib.error
import urllib.request
from collections import deque
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable

from backend import live
from backend.routing import RouteError, Router

ROOT = Path(__file__).resolve().parent.parent
ENV_FILE = ROOT / ".env"
PLACES_FILE = ROOT / "web" / "public" / "places.json"
WITA = timezone(timedelta(hours=8))
log = logging.getLogger("uvicorn.error")

# The only two model APIs this app may call. Both free; see the module docstring.
PROVIDERS: list[dict[str, Any]] = [
    {
        "id": "groq",
        "name": "Groq",
        "url": "https://api.groq.com/openai/v1/chat/completions",
        "key_env": "GROQ_API_KEY",
        "model_env": "GROQ_MODEL",
        # Tried in order; a model the provider has retired is skipped for the rest of the run.
        # (llama-3.3-70b-versatile answered "model not found" on 2026-11-04.)
        "models": ["openai/gpt-oss-120b", "qwen/qwen3-32b", "llama-3.3-70b-versatile", "llama-3.1-8b-instant"],
    },
    {
        "id": "nvidia",
        "name": "NVIDIA",
        "url": "https://integrate.api.nvidia.com/v1/chat/completions",
        "key_env": "NVIDIA_API_KEY",
        "model_env": "NVIDIA_MODEL",
        "models": ["meta/llama-3.3-70b-instruct", "meta/llama-3.1-70b-instruct", "meta/llama-3.1-8b-instruct"],
    },
]

MAX_TOOL_ROUNDS = 4
MAX_TURNS = 12  # conversation turns sent to the model
MAX_CHARS = 600  # per message from the visitor
# Free tiers allow roughly 30-40 requests a minute, and one answer can take 2-4 of them.
CHATS_PER_MINUTE = 10
CHATS_PER_MINUTE_PER_CLIENT = 5


class AssistantError(Exception):
    def __init__(self, code: str, message: str, status: int = 503) -> None:
        super().__init__(message)
        self.code = code
        self.status = status


class _ProviderError(Exception):
    def __init__(self, status: int, body: str) -> None:
        super().__init__(f"HTTP {status}: {body[:300]}")
        self.status = status
        self.body = body


# ---------------------------------------------------------------- settings


def read_env() -> dict[str, str]:
    """KEY=VALUE lines from .env (read on every request, so a key added later works without a restart),
    with real environment variables taking precedence."""
    values: dict[str, str] = {}
    if ENV_FILE.is_file():
        for line in ENV_FILE.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            values[k.strip()] = v.strip().strip('"').strip("'")
    for p in PROVIDERS:
        for k in (p["key_env"], p["model_env"]):
            if os.environ.get(k):
                values[k] = os.environ[k]
    return values


def configured_providers(env: dict[str, str] | None = None) -> list[dict[str, Any]]:
    env = read_env() if env is None else env
    return [p for p in PROVIDERS if env.get(p["key_env"])]


# ---------------------------------------------------------------- rate limit


class _Limiter:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._all: deque[float] = deque()
        self._by_client: dict[str, deque[float]] = {}

    def check(self, client: str, now: float | None = None) -> None:
        now = time.time() if now is None else now
        with self._lock:
            for q in (self._all, self._by_client.setdefault(client, deque())):
                while q and now - q[0] > 60:
                    q.popleft()
            if len(self._all) >= CHATS_PER_MINUTE or len(self._by_client[client]) >= CHATS_PER_MINUTE_PER_CLIENT:
                raise AssistantError("busy", "Terlalu banyak pertanyaan dalam semenit. Coba lagi sebentar.", 429)
            self._all.append(now)
            self._by_client[client].append(now)


limiter = _Limiter()

# ---------------------------------------------------------------- helpers for the tools

_COMPASS_ID = ["utara", "timur laut", "timur", "tenggara", "selatan", "barat daya", "barat", "barat laut"]
_COMPASS_EN = ["north", "northeast", "east", "southeast", "south", "southwest", "west", "northwest"]


def _compass(bearing: float, lang: str) -> str:
    words = _COMPASS_EN if lang == "en" else _COMPASS_ID
    return words[round((bearing % 360) / 45) % 8]


def _clock(epoch: float) -> str:
    return datetime.fromtimestamp(epoch, WITA).strftime("%H:%M")


def _normalize(s: str) -> list[str]:
    s = unicodedata.normalize("NFD", s.lower())
    s = "".join(ch for ch in s if unicodedata.category(ch) != "Mn")
    s = re.sub(r"\b(simpang|jalan|jl)\b\.?", " ", s)
    return [t for t in re.sub(r"[^a-z0-9 ]", " ", s).split() if t]


_KIND_WEIGHT = {"kota": 3, "bandara": 3, "pantai": 1.5, "danau": 1.5, "gunung": 1.2, "pulau": 1.5, "wisata": 1, "desa": 1, "area": 1, "pasar": 0.5}
_places_cache: list[dict[str, Any]] | None = None


def _places() -> list[dict[str, Any]]:
    global _places_cache
    if _places_cache is None:
        try:
            _places_cache = json.loads(PLACES_FILE.read_text(encoding="utf-8"))["places"]
        except (OSError, ValueError, KeyError):
            _places_cache = []
    return _places_cache


def find_place(query: str, corridor: dict[str, Any]) -> dict[str, Any] | None:
    """Best match among watched junctions and Bali places: every query word must start a name word."""
    q = _normalize(query)
    if not q:
        return None
    if {"bandara", "airport", "bandar", "udara"} & set(q) and not {"wisnu", "letkol"} & set(q):
        airport = next((p for p in _places() if p["k"] == "bandara" and "ngurah rai" in p["n"].lower()), None)
        if airport:
            return {"name": airport["n"], "lnglat": airport["c"], "kind": "place"}

    def score(name: str) -> float:
        toks = _normalize(name)
        total = 0.0
        for w in q:
            best = 0.0
            for t in toks:
                if t == w:
                    best = max(best, 3.0)
                elif t.startswith(w) and len(w) >= 2:
                    best = max(best, 2.0)
            if best == 0:
                return 0.0
            total += best
        return total - 0.05 * len(toks)

    best: tuple[float, dict[str, Any]] | None = None
    for j in corridor.get("junctions", []):
        s = score(j["name"])
        if s > 0 and (best is None or s + 2 > best[0]):
            best = (s + 2, {"name": j["name"], "lnglat": j["center"], "kind": "junction"})
    for p in _places():
        s = score(p["n"])
        if s > 0:
            s += _KIND_WEIGHT.get(p["k"], 1)
            if best is None or s > best[0]:
                best = (s, {"name": p["n"], "lnglat": p["c"], "kind": "place"})
    return best[1] if best else None


# ---------------------------------------------------------------- tools


TOOL_SPECS = [
    {
        "type": "function",
        "function": {
            "name": "get_live_status",
            "description": "Current traffic state of every watched junction in Bali (label, how fresh the data is, each approach with its queue). Use for any question about now.",
            "parameters": {"type": "object", "properties": {}, "required": []},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_today_history",
            "description": "Today's traffic history since 00:00 WITA: minutes per label per junction and the longest padat/macet periods. Pass junction_id for one junction with an hour-by-hour view.",
            "parameters": {
                "type": "object",
                "properties": {"junction_id": {"type": "string", "description": "Optional junction id from get_live_status."}},
                "required": [],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "plan_route",
            "description": "Routes between two named places in Bali (up to 3), each with its length and the watched junctions it passes with their live state. No travel times exist.",
            "parameters": {
                "type": "object",
                "properties": {
                    "from_place": {"type": "string", "description": "Start, e.g. 'Kuta' or 'Simpang Patung Kuda'."},
                    "to_place": {"type": "string", "description": "Destination, e.g. 'Bandara' or 'Nusa Dua'."},
                },
                "required": ["from_place", "to_place"],
            },
        },
    },
]


class Tools:
    """The data the model may use. Every number in an answer comes from here."""

    def __init__(self, corridor: dict[str, Any], router: Router, lang: str, now: float | None = None) -> None:
        self.corridor = corridor
        self.router = router
        self.lang = lang
        self.now = time.time() if now is None else now
        self.snapshot = live.snapshot(corridor, self.now)
        self.synthetic = self.snapshot.get("source") == "synthetic"
        self.actions: list[dict[str, Any]] = []
        self.by_id = {j["id"]: j for j in corridor.get("junctions", [])}

    def run(self, name: str, args: dict[str, Any]) -> dict[str, Any]:
        fn: Callable[..., dict[str, Any]] | None = {
            "get_live_status": self.get_live_status,
            "get_today_history": self.get_today_history,
            "plan_route": self.plan_route,
        }.get(name)
        if fn is None:
            return {"error": f"unknown tool {name}"}
        try:
            return fn(**{k: v for k, v in args.items() if isinstance(v, str)})
        except TypeError as exc:
            return {"error": f"bad arguments: {exc}"}

    def _arm_from(self, jid: str, arm_id: str | None) -> str | None:
        arm = next((a for a in self.by_id.get(jid, {}).get("arms", []) if a["id"] == arm_id), None)
        return _compass(arm["bearing"], self.lang) if arm else None

    def get_live_status(self) -> dict[str, Any]:
        out = []
        for s in self.snapshot["junctions"]:
            j = self.by_id.get(s["id"], {})
            age = max(0, round(self.now - datetime.fromisoformat(s["updated_at"].replace("Z", "+00:00")).timestamp()))
            approaches = [
                {
                    "from": self._arm_from(s["id"], a["arm"]),
                    "label": a["label"],
                    "vehicles_stopped": a["stopped"],
                    "queue_seconds": a["stopped_for_s"] if a["label"] != "lancar" else 0,
                    "passing_per_min": a["flow_per_min"],
                }
                for a in s["approaches"]
            ]
            out.append({
                "id": s["id"],
                "name": j.get("name", s["id"]),
                "roads": j.get("roads", []),
                "label": s["label"] if s["camera_state"] != "offline" else "no data (camera offline)",
                "camera": s["camera_state"],
                "data_age_seconds": age,
                "approaches": approaches,
                "vehicles_last_15min": s.get("classes_15min"),
            })
        return {
            "source": "SYNTHETIC development data, not real traffic" if self.synthetic else "Bali Satu Data CCTV",
            "time_wita": _clock(self.now),
            "watched_junctions": out,
            "coverage": f"Only these {len(out)} junctions (south Bali airport corridor) are watched. Nothing is known about other places.",
        }

    def get_today_history(self, junction_id: str = "") -> dict[str, Any]:
        local = datetime.fromtimestamp(self.now, WITA)
        midnight = local.replace(hour=0, minute=0, second=0, microsecond=0).timestamp()
        first, last = int(midnight // 60), int(self.now // 60)
        if not self.synthetic:
            return {"error": "Today's history is only recorded for the synthetic feed so far."}
        if junction_id and junction_id not in self.by_id:
            return {"error": f"unknown junction id '{junction_id}'", "known_ids": list(self.by_id)}
        juncs = [self.by_id[junction_id]] if junction_id else list(self.by_id.values())

        def period(run: tuple[int, int]) -> str:
            a, b = run
            return f"{_clock((first + a) * 60)}-{_clock((first + b) * 60) if b < last - first + 1 else 'sekarang/now'} ({b - a} min)"

        result = []
        macet_by_hour = [0] * (local.hour + 1)
        for j in juncs:
            labels = [live.label_at(j, m) for m in range(first, last + 1)]
            runs: dict[str, list[tuple[int, int]]] = {"padat": [], "macet": []}
            start_i = 0
            for i in range(1, len(labels) + 1):
                if i == len(labels) or labels[i] != labels[start_i]:
                    if labels[start_i] in runs:
                        runs[labels[start_i]].append((start_i, i))
                    start_i = i
            for i, lab in enumerate(labels):
                if lab == "macet":
                    macet_by_hour[min(i // 60, len(macet_by_hour) - 1)] += 1
            entry: dict[str, Any] = {
                "id": j["id"],
                "name": j["name"],
                "label_now": labels[-1] if labels else "none",
                "minutes_macet_today": labels.count("macet"),
                "minutes_padat_today": labels.count("padat"),
                "minutes_lancar_today": labels.count("lancar"),
                "minutes_without_data_today": labels.count("none"),
                "times_macet_today": len(runs["macet"]),
                "longest_macet": period(max(runs["macet"], key=lambda r: r[1] - r[0])) if runs["macet"] else None,
                "latest_macet": period(runs["macet"][-1]) if runs["macet"] else None,
            }
            if junction_id:
                entry["by_hour"] = [
                    {"hour": f"{h:02d}:00-{h:02d}:59", "macet_min": labels[h * 60:(h + 1) * 60].count("macet"), "padat_min": labels[h * 60:(h + 1) * 60].count("padat")}
                    for h in range(local.hour + 1)
                ]
            result.append(entry)
        result.sort(key=lambda e: (e["minutes_macet_today"], e["minutes_padat_today"]), reverse=True)
        busiest_hour = max(range(len(macet_by_hour)), key=lambda h: macet_by_hour[h])
        return {
            "source": "SYNTHETIC development data, not real traffic",
            "period": f"today 00:00-{_clock(self.now)} WITA",
            "summary": {
                "busiest_junction_today": result[0]["name"] if result and result[0]["minutes_macet_today"] + result[0]["minutes_padat_today"] else None,
                "hour_with_most_macet_minutes": f"{busiest_hour:02d}:00-{busiest_hour:02d}:59" if any(macet_by_hour) else None,
            },
            "junctions_busiest_first": result,
            "how_to_read": "Each macet period is short and repeats; describe totals and the longest/latest period, not every period.",
        }

    def plan_route(self, from_place: str = "", to_place: str = "") -> dict[str, Any]:
        a = find_place(from_place, self.corridor)
        b = find_place(to_place, self.corridor)
        if not a or not b:
            missing = [p for p, f in ((from_place, a), (to_place, b)) if not f]
            return {"error": f"place not found: {', '.join(missing)}. Ask the visitor for a better-known place name, or to use the route planner (button RUTE)."}
        try:
            res = self.router.route(tuple(a["lnglat"]), tuple(b["lnglat"]), self.corridor, self.snapshot)
        except RouteError as exc:
            return {"error": str(exc), "code": exc.code}
        self.actions = [{"type": "route", "from": a, "to": b}]
        labels = {s["id"]: s for s in self.snapshot["junctions"]}
        routes = []
        for i, r in enumerate(res["routes"]):
            passed = []
            for p in r["junctions"]:
                s = labels.get(p["id"])
                lab = "no data"
                if s and s["camera_state"] != "offline":
                    lab = next((x["label"] for x in s["approaches"] if x["arm"] == p["arm"]), s["label"])
                passed.append({"name": self.by_id.get(p["id"], {}).get("name", p["id"]), "entering_from": self._arm_from(p["id"], p["arm"]), "label": lab})
            routes.append({"letter": "ABC"[i], "via": r["via"], "km": round(r["distance_m"] / 1000, 1), "watched_junctions": passed})
        # Facts the model would otherwise have to work out (and small models get wrong): which route we
        # recommend, which is shortest, and one ready sentence per route.
        shortest = min(routes, key=lambda r: r["km"])["letter"]
        en = self.lang == "en"
        for r in routes:
            km = f'{r["km"]:g}' if en else f'{r["km"]:g}'.replace(".", ",")
            busy = [f'{w["name"]} {w["label"]}' for w in r["watched_junctions"] if w["label"] in ("padat", "macet")]
            clear = [w["name"] for w in r["watched_junctions"] if w["label"] == "lancar"]
            if en:
                parts = [f'via {r["via"] or "minor roads"}, {km} km']
                if not r["watched_junctions"]:
                    parts.append("passes no watched junction")
                if busy:
                    parts.append("passes " + ", ".join(busy))
                if clear:
                    parts.append(("also " if busy else "passes ") + ", ".join(clear) + " (lancar)")
            else:
                parts = [f'lewat {r["via"] or "jalan kecil"}, {km} km']
                if not r["watched_junctions"]:
                    parts.append("tidak lewat simpang yang dipantau")
                if busy:
                    parts.append("melewati " + ", ".join(busy))
                if clear:
                    parts.append(("juga " if busy else "melewati ") + ", ".join(clear) + " yang lancar")
            r["summary"] = f'Rute {r["letter"]} ' + ", ".join(parts)
        return {
            "from": a["name"],
            "to": b["name"],
            "recommended": "A",
            "shortest": shortest,
            "routes_recommended_first": routes,
            "note": "Distances only; travel times are not measured. Route A is recommended: it avoids padat/macet approaches when it can, so it is not always the shortest. Each junction label is for the approach this route uses. The visitor can open these routes on the map with the button under this answer.",
        }


# ---------------------------------------------------------------- the conversation


def _system_prompt(lang: str, tools: Tools) -> str:
    names = ", ".join(j["name"] for j in tools.corridor.get("junctions", []))
    language = "English" if lang == "en" else "Bahasa Indonesia (santai tapi sopan, sapa dengan \"kamu\", tanpa tanda seru)"
    synthetic = (
        "IMPORTANT: all traffic data is SYNTHETIC development data, not real traffic. Say so briefly in every answer that gives traffic facts (e.g. 'menurut data sintetis')."
        if tools.synthetic else ""
    )
    return f"""You are "Tanya lalu lintas", the assistant of Bali StreetLens, a public 3D map of Bali that watches a few junctions through provincial CCTV.
Answer in {language}. Today is {datetime.fromtimestamp(tools.now, WITA).strftime('%d-%m-%Y')}, now {_clock(tools.now)} WITA.

Rules:
- Use the tools for every traffic fact. Never invent numbers, junctions, roads, times or causes. If a tool doesn't give it, say you don't know.
- Watched junctions (the only places with traffic data): {names}. For anywhere else say plainly that no camera watches it yet; you may still plan a route there.
- Labels: lancar (moving), padat (heavy), macet (jammed). Use exactly these words; never call padat "macet" or "agak macet". Mention how fresh the data is when it matters.
- After plan_route succeeds, the app shows a button under your answer that opens the routes on the map; point to it ("tombol di bawah").
- Never give travel times or predictions of the future; they are not measured. Today's history is fine.
- For "how do I get to X" questions call plan_route, then recommend route A first and mention the others briefly, based on each route's "summary" (keep its facts, phrase it naturally). Say route A is the shortest only if "shortest" is "A"; never call any route fastest.
- Asked how long a trip takes: say travel times aren't measured yet, then call plan_route and give the distances instead. This is on-topic.
- Don't greet; answer straight away. If the start is unknown, ask where they start from, or suggest the RUTE button (it can use their location).
- Keep answers short: at most 5 sentences or a short list. Write junction names exactly as the tools give them.
- Off-topic questions: answer in one sentence that you only help with Bali traffic on this map.
{synthetic}"""


def _clean(text: str) -> str:
    text = re.sub(r"<think>.*?</think>", "", text or "", flags=re.S)
    # Some models write no-break spaces and hyphens; plain ones keep junction names findable.
    text = re.sub(r"[   ]", " ", text)
    text = re.sub(r"[‐‑]", "-", text)
    return text.strip()


def _post(url: str, key: str, body: dict[str, Any], timeout: float = 45) -> dict[str, Any]:
    req = urllib.request.Request(
        url,
        data=json.dumps(body).encode(),
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json", "User-Agent": "BaliStreetLens/0.1"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as res:
            return json.loads(res.read())
    except urllib.error.HTTPError as exc:
        raise _ProviderError(exc.code, exc.read().decode("utf-8", "replace")) from None
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise _ProviderError(0, str(exc)) from None


_retired: set[tuple[str, str]] = set()  # (provider, model) pairs the provider said don't exist


def _converse(post: Callable[..., dict[str, Any]], provider: dict[str, Any], key: str, model: str,
              messages: list[dict[str, Any]], tools: Tools) -> str:
    msgs = list(messages)
    for round_ in range(MAX_TOOL_ROUNDS + 1):
        last = round_ == MAX_TOOL_ROUNDS
        body: dict[str, Any] = {"model": model, "messages": msgs, "temperature": 0.2, "max_tokens": 700}
        if not last:
            body["tools"] = TOOL_SPECS
            body["tool_choice"] = "auto"
        msg = post(provider["url"], key, body)["choices"][0]["message"]
        calls = msg.get("tool_calls") or []
        if not calls or last:
            return _clean(msg.get("content") or "")
        msgs.append({"role": "assistant", "content": msg.get("content") or "", "tool_calls": calls})
        for c in calls:
            try:
                args = json.loads(c["function"].get("arguments") or "{}")
            except ValueError:
                args = {}
            result = tools.run(c["function"]["name"], args if isinstance(args, dict) else {})
            msgs.append({"role": "tool", "tool_call_id": c["id"], "content": json.dumps(result, ensure_ascii=False)})
    return ""


def chat(history: list[dict[str, str]], lang: str, corridor: dict[str, Any], router: Router, client: str,
         post: Callable[..., dict[str, Any]] = _post, env: dict[str, str] | None = None,
         now: float | None = None) -> dict[str, Any]:
    """One answer to the last user message. Raises AssistantError with a code the app can explain."""
    env = read_env() if env is None else env
    providers = configured_providers(env)
    if not providers:
        raise AssistantError("no_key", "Asisten belum diaktifkan: isi GROQ_API_KEY (gratis) di file .env.", 503)
    turns = [m for m in history if m.get("role") in ("user", "assistant") and isinstance(m.get("content"), str)][-MAX_TURNS:]
    if not turns or turns[-1]["role"] != "user" or not turns[-1]["content"].strip():
        raise AssistantError("bad_request", "Pertanyaan kosong.", 400)
    if any(len(m["content"]) > MAX_CHARS for m in turns if m["role"] == "user"):
        raise AssistantError("too_long", f"Pertanyaan terlalu panjang (maks {MAX_CHARS} huruf).", 400)
    limiter.check(client, now)

    tools = Tools(corridor, router, lang, now)
    messages = [{"role": "system", "content": _system_prompt(lang, tools)}] + [{"role": m["role"], "content": m["content"]} for m in turns]
    last_error = "busy"
    for p in providers:
        key = env[p["key_env"]]
        models = [m for m in [env.get(p["model_env"], ""), *p["models"]] if m]
        for model in dict.fromkeys(models):
            if (p["id"], model) in _retired:
                continue
            try:
                try:
                    reply = _converse(post, p, key, model, messages, tools)
                except _ProviderError as first:
                    # Models now and then emit a malformed tool call (Groq: 400 tool_use_failed);
                    # the same question usually works on a second try.
                    if not (first.status == 400 and "tool" in (first.body or "").lower()):
                        raise
                    log.warning("assistant: %s %s fumbled a tool call, retrying once", p["name"], model)
                    reply = _converse(post, p, key, model, messages, tools)
            except _ProviderError as exc:
                body = exc.body.lower() if exc.body else ""
                if exc.status in (404,) or (exc.status == 400 and "model" in body and ("not found" in body or "decommission" in body or "does not exist" in body)):
                    _retired.add((p["id"], model))
                    continue  # try this provider's next model
                if exc.status == 400 and "tool" in body:
                    log.warning("assistant: %s %s failed its tool call twice, trying the next model", p["name"], model)
                    continue  # this model fumbled the tool format; another may not
                log.warning("assistant: %s %s answered %s: %s", p["name"], model, exc.status or "no connection", exc.body[:200])
                if exc.status in (413, 429):
                    last_error = "busy"
                    continue  # limits are per model: the next model has its own quota
                last_error = "bad_key" if exc.status in (401, 403) else "offline" if exc.status == 0 else "busy"
                break  # bad key, outage: next provider
            if not reply:
                continue
            mentioned = [j["id"] for j in corridor.get("junctions", []) if j["name"].lower() in reply.lower()
                         or j["name"].lower().removeprefix("simpang ") in reply.lower()]
            return {
                "reply": reply,
                "junctions": mentioned,
                "actions": tools.actions,
                "provider": p["name"],
                "model": model,
                "synthetic": tools.synthetic,
            }
    messages_by_code = {
        "busy": ("busy", "Layanan AI gratis sedang penuh atau mencapai batasnya. Coba lagi sebentar.", 429),
        "bad_key": ("bad_key", "Kunci API ditolak. Periksa GROQ_API_KEY / NVIDIA_API_KEY di file .env.", 503),
        "offline": ("offline", "Tidak bisa menghubungi layanan AI. Asisten butuh internet; peta dan rute tetap jalan.", 503),
    }
    code, message, status = messages_by_code.get(last_error, messages_by_code["busy"])
    raise AssistantError(code, message, status)
