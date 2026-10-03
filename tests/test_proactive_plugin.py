"""Public plugin facade contracts; no Hermes internals in unit tests."""
from pathlib import Path
import importlib.util
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
PLUGIN = ROOT / "plugins" / "proactive-primary"


def load_plugin():
    name = "companion_proactive_test"
    spec = importlib.util.spec_from_file_location(name, PLUGIN / "__init__.py",
                                                submodule_search_locations=[str(PLUGIN)])
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


class PluginTests(unittest.TestCase):
    def test_startup_marker_arms_only_the_same_gateway_process(self):
        from datetime import datetime, timezone, timedelta
        module = load_plugin()
        guard = sys.modules[module.__name__ + ".gateway_guard"]
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            registered = datetime.now(timezone.utc) - timedelta(seconds=1)
            self.assertFalse(guard.gateway_ready(home, registered))
            guard.mark_gateway_ready(home)
            self.assertTrue(guard.gateway_ready(home, registered))
            value = __import__("json").loads((home / "companion/proactivity/gateway-owner.json").read_text())
            value["pid"] += 1
            guard.write_private_json(home / "companion/proactivity/gateway-owner.json", value)
            self.assertFalse(guard.gateway_ready(home, registered))

    def test_gateway_hook_is_passive_for_non_startup_events(self):
        hook = ROOT / "hooks/proactive-primary/handler.py"
        spec = importlib.util.spec_from_file_location("proactive_hook_test", hook)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            module.handle("agent:end", {"response": "Never persist this private text"}, home=home)
            self.assertFalse((home / "companion").exists())
            module.handle("gateway:startup", {"platforms": ["telegram"]}, home=home)
            self.assertTrue((home / "companion/proactivity/gateway-owner.json").exists())

    def test_dispatch_requires_gateway_marker_and_literal_acceptance(self):
        from types import SimpleNamespace
        import json
        class Facade:
            def __init__(self):
                self.acceptance = "yes"
                self.received = []
            def inject_message(self, message, **kwargs):
                self.received.append((message, kwargs))
                return self.acceptance
        class FakeStore:
            def __init__(self):
                self.finished = []
                self.pending = True
            def load_policy(self):
                return SimpleNamespace(enabled=True, primary_profile="default",
                                       session_key="agent:main:telegram:dm:123456789")
            def claim(self, now=None):
                if not self.pending:
                    return None
                self.pending = False
                return {"id": "sample-event", "kind": "manual_review", "evidence": "a" * 64,
                        "purpose": False, "session_key": self.load_policy().session_key}
            def finish(self, event_id, status):
                self.finished.append((event_id, status))
        module = load_plugin()
        guard = sys.modules[module.__name__ + ".gateway_guard"]
        with tempfile.TemporaryDirectory() as directory:
            facade, store = Facade(), FakeStore()
            runtime = module.Runtime(facade, Path(directory), store=store,
                                     appraiser=lambda *_: {"useful": True})
            self.assertIsNone(runtime.tick())
            self.assertEqual(facade.received, [])
            guard.mark_gateway_ready(Path(directory))
            result = runtime.tick()
            self.assertEqual(result["status"], "uncertain")
            self.assertEqual(store.finished, [("sample-event", "uncertain")])
            self.assertEqual(facade.received[0][1]["session_key"], store.load_policy().session_key)
            self.assertNotIn("a" * 64, facade.received[0][0])
            self.assertIsNone(runtime.tick())
            runtime.close()

    def test_registration_does_not_start_another_agent_or_cli_injection(self):
        class Facade:
            def __init__(self):
                self.calls = []
            def get_config(self, name, default=None):
                return default
            def register_tool(self, **kwargs):
                self.calls.append(("tool", kwargs["name"]))
            def register_command(self, name, handler, **kwargs):
                self.calls.append(("command", name))
            def register_skill(self, name, path, **kwargs):
                self.calls.append(("skill", name))
            def register_hook(self, name, callback):
                self.calls.append(("hook", name))
            def on_unload(self, callback):
                self.cleanup = callback
            def inject_message(self, *args, **kwargs):
                raise AssertionError("Plugin registration must never inject")
        module = load_plugin()
        with tempfile.TemporaryDirectory() as directory:
            facade = Facade()
            runtime = module.register(facade, home=Path(directory), background=False)
            self.assertIn(("tool", "proactive_control"), facade.calls)
            self.assertIn(("command", "proactivity"), facade.calls)
            self.assertFalse(runtime.gateway_ready())
            self.assertIsNone(runtime.tick())
            runtime.close()


if __name__ == "__main__":
    unittest.main()
