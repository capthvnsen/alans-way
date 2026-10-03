"""Real companion state backs chat controls; no native profile is touched."""
from pathlib import Path
import importlib.util
import json
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]


def plugin():
    name = "companion_proactive_controls_test"
    path = ROOT / "plugins/proactive-primary"
    spec = importlib.util.spec_from_file_location(name, path / "__init__.py", submodule_search_locations=[str(path)])
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


class ControlTests(unittest.TestCase):
    def test_chat_controls_read_back_effective_preferences_without_private_audit(self):
        module = plugin()
        with tempfile.TemporaryDirectory() as directory:
            runtime = module.Runtime(None, Path(directory))
            route = "agent:main:telegram:dm:123456789"
            runtime.store.update_policy({"session_key": route})
            self.assertIn("Proactivity: enabled", runtime.command("resume"))
            configured = runtime.command('configure {"quiet_start":23}')
            self.assertIn("23:00–08:00", configured)
            self.assertNotIn(route, configured)
            self.assertNotIn('"audit"', configured)
            self.assertIn("Proactivity: paused", runtime.command("pause"))
            self.assertIn("no useful opportunity", runtime.command("review"))
            runtime.close()

    def test_interactive_review_returns_now_while_paused_without_queue_or_injection(self):
        from types import SimpleNamespace
        class LLM:
            calls = 0
            def complete_structured(self, **kwargs):
                self.calls += 1
                return SimpleNamespace(content_type="json", parsed={"useful": False, "action": "ask", "task_id": None})
        module = plugin()
        with tempfile.TemporaryDirectory() as directory:
            llm = LLM()
            runtime = module.Runtime(SimpleNamespace(llm=llm), Path(directory))
            runtime.ledger.record_task({"id": "watch", "title": "Draft", "scope": "Draft approved test cases",
                "next_action": "Draft", "owner": "primary", "status": "active", "approved": True})
            result = json.loads(runtime.control({"action": "review"}))
            self.assertTrue(result["ok"])
            self.assertFalse(result["injected"])
            self.assertEqual(llm.calls, 1)
            self.assertFalse(runtime.store.load_policy().enabled)
            self.assertEqual(runtime.store.status()["counts"], {})
            runtime.close()

    def test_task_scope_and_focus_survive_restart_without_self_generated_wakes(self):
        module = plugin()
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            runtime = module.Runtime(None, home)
            runtime.store.update_policy({"session_key": "agent:main:telegram:dm:123456789"})
            task = {"id": "companion-build", "title": "Companion", "scope": "Review approved handoff research",
                    "next_action": "Draft the next acceptance tests", "owner": "primary", "status": "active", "approved": True}
            self.assertTrue(json.loads(runtime.control({"action": "record_task", "task": task}))["ok"])
            self.assertTrue(json.loads(runtime.control({"action": "configure", "changes": {"preferences": {"focus": ["approved projects"]}}}))["ok"])
            self.assertEqual(runtime.store.status()["counts"], {})
            runtime.close()
            restarted = module.Runtime(None, home)
            status = json.loads(restarted.control({"action": "status"}))
            self.assertEqual(status["tasks"][0]["id"], "companion-build")
            self.assertEqual(status["preferences"]["focus"], ["approved projects"])
            self.assertTrue(json.loads(restarted.control({"action": "finish_task", "task_id": "companion-build", "status": "cancelled"}))["ok"])
            self.assertFalse(json.loads(restarted.control({"action": "record_task", "task": task}))["ok"])
            self.assertFalse(json.loads(restarted.control({"action": "configure", "changes": {"preferences": {"autonomy": "unrestricted"}}}))["ok"])
            restarted.close()

    def test_registered_tool_schema_can_express_the_live_task_controls(self):
        module = plugin()
        class Facade:
            def register_tool(self, **kwargs): self.schema = kwargs["schema"]
            def register_command(self, *args, **kwargs): pass
            def register_skill(self, *args, **kwargs): pass
            def on_unload(self, *args): pass
        with tempfile.TemporaryDirectory() as directory:
            facade = Facade()
            runtime = module.register(facade, home=Path(directory), background=False)
            parameters = facade.schema["parameters"]
            self.assertIn("record_task", parameters["properties"]["action"]["enum"])
            self.assertIn("task", parameters["properties"])
            self.assertIn("event_id", parameters["properties"])
            self.assertIn("preferences", parameters["properties"]["settings"]["properties"])
            runtime.close()

    def test_mac_execution_binding_cannot_silently_move_to_cloud(self):
        module = plugin()
        with tempfile.TemporaryDirectory() as directory:
            runtime = module.Runtime(None, Path(directory))
            task = {"id": "mac-work", "title": "Local work", "scope": "Read an approved Mac file",
                    "next_action": "Read it", "owner": "primary", "status": "active", "approved": True,
                    "execution_host": "mac"}
            runtime.ledger.record_task(task)
            with self.assertRaises(ValueError):
                runtime.ledger.record_task({**task, "execution_host": "cloud"})
            self.assertEqual(runtime.ledger.snapshot()["tasks"][0]["execution_host"], "mac")
            runtime.close()

    def test_omitting_host_in_a_watch_update_preserves_the_mac_binding(self):
        module = plugin()
        with tempfile.TemporaryDirectory() as directory:
            runtime = module.Runtime(None, Path(directory))
            task = {"id": "mac-work", "title": "Local work", "scope": "Read an approved Mac file",
                    "next_action": "Read it", "owner": "primary", "status": "active", "approved": True,
                    "execution_host": "mac"}
            runtime.ledger.record_task(task)
            update = {key: value for key, value in task.items() if key != "execution_host"}
            update["next_action"] = "Wait for the Mac to reconnect"
            runtime.ledger.record_task(update)
            self.assertEqual(runtime.ledger.snapshot()["tasks"][0]["execution_host"], "mac")
            runtime.close()

    def test_effective_chat_preferences_persist_across_runtime_restart(self):
        module = plugin()
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            runtime = module.Runtime(None, home)
            result = json.loads(runtime.control({"action": "status"}))
            self.assertTrue(result["ok"])
            self.assertFalse(result["enabled"])
            self.assertTrue(json.loads(runtime.control({"action": "configure", "changes": {"quiet_start": 23}}))["ok"])
            runtime.close()
            restarted = module.Runtime(None, home)
            status = json.loads(restarted.control({"action": "status"}))
            self.assertEqual(status["policy"]["quiet_start"], 23)
            self.assertFalse(status["enabled"])
            self.assertFalse(json.loads(restarted.control({"action": "configure", "changes": {"session_key": "foreign"}}))["ok"])
            restarted.close()


if __name__ == "__main__":
    unittest.main()
