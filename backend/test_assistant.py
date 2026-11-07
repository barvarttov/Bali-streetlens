"""Tests for the traffic assistant, with a fake model API: no network, no keys, no cost.

Run from the repo root: .venv\\Scripts\\python -m unittest backend.test_assistant
"""

import json
import unittest
from pathlib import Path

from backend import assistant
from backend.routing import Router

ROOT = Path(__file__).resolve().parent.parent
CORRIDOR = json.loads((ROOT / "config" / "corridor.json").read_text(encoding="utf-8"))
ROUTER = Router(ROOT / "config" / "roads.json.gz")
NOON = 1_793_664_000.0  # 2026-11-03 08:00 WITA
GROQ_ONLY = {"GROQ_API_KEY": "gsk_test"}
BOTH = {"GROQ_API_KEY": "gsk_test", "NVIDIA_API_KEY": "nvapi-test"}
ASK = [{"role": "user", "content": "Simpang mana yang macet sekarang?"}]


def tool_call(name, args=None, cid="c1"):
    return {"choices": [{"message": {"content": "", "tool_calls": [{"id": cid, "type": "function", "function": {"name": name, "arguments": json.dumps(args or {})}}]}}]}


def answer(text):
    return {"choices": [{"message": {"content": text}}]}


class FakeApi:
    """Plays back scripted responses per URL and records every request."""

    def __init__(self, script):
        self.script = script  # url substring -> list of responses (dict) or exceptions
        self.calls = []

    def __call__(self, url, key, body, timeout=45):
        self.calls.append((url, key, body))
        for part, queue in self.script.items():
            if part in url:
                item = queue.pop(0)
                if isinstance(item, Exception):
                    raise item
                return item
        raise AssertionError(f"unexpected call to {url}")


class AssistantTest(unittest.TestCase):
    def setUp(self):
        assistant.limiter = assistant._Limiter()
        assistant._retired.clear()

    def test_only_free_providers(self):
        # The app may only ever call these two free APIs.
        self.assertEqual(
            [p["url"] for p in assistant.PROVIDERS],
            ["https://api.groq.com/openai/v1/chat/completions", "https://integrate.api.nvidia.com/v1/chat/completions"],
        )

    def test_no_key_is_explained(self):
        with self.assertRaises(assistant.AssistantError) as ctx:
            assistant.chat(ASK, "id", CORRIDOR, ROUTER, "t", post=FakeApi({}), env={}, now=NOON)
        self.assertEqual(ctx.exception.code, "no_key")

    def test_answers_through_the_live_tool(self):
        api = FakeApi({"groq.com": [tool_call("get_live_status"), answer("Menurut data sintetis, Simpang Patung Kuda sedang macet.")]})
        out = assistant.chat(ASK, "id", CORRIDOR, ROUTER, "t", post=api, env=GROQ_ONLY, now=NOON)
        self.assertEqual(out["provider"], "Groq")
        self.assertIn("patung-kuda", out["junctions"])
        tool_msg = api.calls[1][2]["messages"][-1]
        self.assertEqual(tool_msg["role"], "tool")
        data = json.loads(tool_msg["content"])
        self.assertEqual(len(data["watched_junctions"]), len(CORRIDOR["junctions"]))
        self.assertIn("SYNTHETIC", data["source"])
        self.assertIn("sample data for testing, not real traffic", api.calls[0][2]["messages"][0]["content"])  # the model is told

    def test_rate_limit_tries_the_next_groq_model_first(self):
        # Groq's limits are per model, so another Groq model still has quota.
        api = FakeApi({"groq.com": [assistant._ProviderError(429, "rate limit"), answer("ok")]})
        out = assistant.chat(ASK, "id", CORRIDOR, ROUTER, "t", post=api, env=BOTH, now=NOON)
        self.assertEqual((out["provider"], out["model"]), ("Groq", assistant.PROVIDERS[0]["models"][1]))

    def test_rate_limited_groq_falls_back_to_nvidia(self):
        groq_models = len(assistant.PROVIDERS[0]["models"])
        api = FakeApi({
            "groq.com": [assistant._ProviderError(429, "rate limit")] * groq_models,
            "nvidia.com": [answer("Halo dari cadangan.")],
        })
        out = assistant.chat(ASK, "id", CORRIDOR, ROUTER, "t", post=api, env=BOTH, now=NOON)
        self.assertEqual(out["provider"], "NVIDIA")

    def test_fumbled_tool_call_is_retried_on_the_same_model(self):
        api = FakeApi({"groq.com": [assistant._ProviderError(400, '{"error":{"code":"tool_use_failed"}}'), answer("ok")]})
        out = assistant.chat(ASK, "id", CORRIDOR, ROUTER, "t", post=api, env=GROQ_ONLY, now=NOON)
        self.assertEqual(out["model"], assistant.PROVIDERS[0]["models"][0])

    def test_bandara_means_ngurah_rai(self):
        for q in ("Bandara", "airport", "bandara ngurah rai"):
            self.assertIn("Ngurah Rai", assistant.find_place(q, CORRIDOR)["name"])
        self.assertIn("Wisnu", assistant.find_place("Letkol Wisnu", CORRIDOR)["name"])

    def test_retired_model_is_skipped(self):
        api = FakeApi({"groq.com": [assistant._ProviderError(404, "model not found"), answer("ok")]})
        out = assistant.chat(ASK, "id", CORRIDOR, ROUTER, "t", post=api, env=GROQ_ONLY, now=NOON)
        self.assertNotEqual(out["model"], assistant.PROVIDERS[0]["models"][0])
        self.assertEqual(api.calls[1][2]["model"], assistant.PROVIDERS[0]["models"][1])

    def test_all_down_says_so(self):
        api = FakeApi({"groq.com": [assistant._ProviderError(0, "no route to host")]})
        with self.assertRaises(assistant.AssistantError) as ctx:
            assistant.chat(ASK, "id", CORRIDOR, ROUTER, "t", post=api, env=GROQ_ONLY, now=NOON)
        self.assertEqual(ctx.exception.code, "offline")

    def test_route_question_returns_a_map_action(self):
        api = FakeApi({"groq.com": [tool_call("plan_route", {"from_place": "Kuta", "to_place": "Nusa Dua"}), answer("Rute A lewat tol.")]})
        out = assistant.chat([{"role": "user", "content": "Dari Kuta ke Nusa Dua lewat mana?"}], "id", CORRIDOR, ROUTER, "t", post=api, env=GROQ_ONLY, now=NOON)
        self.assertEqual(out["actions"][0]["type"], "route")
        self.assertEqual(out["actions"][0]["from"]["name"], "Kuta")
        routes = json.loads(api.calls[1][2]["messages"][-1]["content"])["routes_recommended_first"]
        self.assertGreaterEqual(len(routes), 1)
        self.assertTrue(all("km" in r and "minutes" not in r for r in routes))

    def test_today_history_counts_every_minute(self):
        tools = assistant.Tools(CORRIDOR, ROUTER, "id", NOON)
        day = tools.get_today_history()
        for j in day["junctions_busiest_first"]:
            total = sum(j[f"minutes_{k}_today"] for k in ("macet", "padat", "lancar", "without_data"))
            self.assertEqual(total, 8 * 60 + 1)  # 00:00 through 08:00 WITA
        self.assertEqual(day["summary"]["busiest_junction_today"], day["junctions_busiest_first"][0]["name"])
        one = tools.get_today_history("patung-kuda")["junctions_busiest_first"][0]
        self.assertEqual(len(one["by_hour"]), 9)
        self.assertEqual(sum(h["macet_min"] for h in one["by_hour"]), one["minutes_macet_today"])

    def test_rate_limit(self):
        api = FakeApi({"groq.com": [answer("ok")] * 10})
        for _ in range(assistant.CHATS_PER_MINUTE_PER_CLIENT):
            assistant.chat(ASK, "id", CORRIDOR, ROUTER, "same", post=api, env=GROQ_ONLY, now=NOON)
        with self.assertRaises(assistant.AssistantError) as ctx:
            assistant.chat(ASK, "id", CORRIDOR, ROUTER, "same", post=api, env=GROQ_ONLY, now=NOON)
        self.assertEqual(ctx.exception.code, "busy")

    def test_long_question_refused_before_any_call(self):
        api = FakeApi({})
        with self.assertRaises(assistant.AssistantError):
            assistant.chat([{"role": "user", "content": "x" * 2000}], "id", CORRIDOR, ROUTER, "t", post=api, env=GROQ_ONLY, now=NOON)
        self.assertEqual(api.calls, [])


if __name__ == "__main__":
    unittest.main()
