"""Operator-only route binding and native-model probe contracts."""
from pathlib import Path
from types import SimpleNamespace
import importlib
import json
import tempfile
import unittest
from test_proactive_plugin import load_plugin


class OperatorTests(unittest.TestCase):
    def test_empty_review_is_successful_silence_without_a_provider_call(self):
        module = load_plugin()
        operator = importlib.import_module(module.__name__ + ".proactive_operator")
        with tempfile.TemporaryDirectory() as directory:
            runtime = module.Runtime(SimpleNamespace(), Path(directory))
            result = operator.probe(runtime)
            self.assertTrue(result["ok"])
            self.assertTrue(result["skipped_no_evidence"])
            self.assertEqual(result["call_count"], 0)
            self.assertFalse(result["injected"])
            runtime.close()

    def test_binding_requires_existing_direct_telegram_route_and_leaves_paused(self):
        module = load_plugin()
        operator = importlib.import_module(module.__name__ + ".proactive_operator")
        route = "agent:main:telegram:dm:123456789"
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            runtime = module.Runtime(None, home)
            with self.assertRaises(ValueError): operator.bind(runtime, route)
            (home / "sessions").mkdir()
            index = home / "sessions/sessions.json"
            index.write_text(json.dumps({route: {"session_key": route, "platform": "telegram", "chat_type": "dm", "session_id": "sample"}}))
            operator.bind(runtime, route)
            self.assertEqual(runtime.store.load_policy().session_key, route)
            self.assertFalse(runtime.store.load_policy().enabled)
            with self.assertRaises(ValueError): operator.bind(runtime, "invented-route")
            runtime.close()

    def test_probe_confirms_a_real_facade_response_without_injecting(self):
        module = load_plugin()
        operator = importlib.import_module(module.__name__ + ".proactive_operator")
        class LLM:
            def complete_structured(self, **kwargs):
                return SimpleNamespace(content_type="json", parsed={"useful": False, "action": "ask", "task_id": None})
        with tempfile.TemporaryDirectory() as directory:
            runtime = module.Runtime(SimpleNamespace(llm=LLM()), Path(directory))
            runtime.ledger.record_task({"id": "handoff", "title": "Handoff", "scope": "Draft approved test matrix",
                                       "next_action": "Draft acceptance cases", "owner": "primary", "status": "active", "approved": True})
            result = operator.probe(runtime)
            self.assertTrue(result["provider_completion_returned"])
            self.assertTrue(result["structured_result_valid"])
            self.assertEqual(result["call_count"], 1)
            self.assertFalse(result["appraisal"]["useful"])
            self.assertEqual(runtime.store.status()["counts"], {})
            runtime.close()


if __name__ == "__main__": unittest.main()
