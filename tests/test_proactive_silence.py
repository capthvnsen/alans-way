"""Read-only review must precede any primary notification."""
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace
import importlib.util
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]


def load_plugin():
    name = "companion_proactive_silence_test"
    plugin = ROOT / "plugins/proactive-primary"
    spec = importlib.util.spec_from_file_location(name, plugin / "__init__.py", submodule_search_locations=[str(plugin)])
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


class SilenceTests(unittest.TestCase):
    def test_no_useful_opportunity_means_no_native_turn(self):
        class Facade:
            def inject_message(self, *args, **kwargs):
                raise AssertionError("No useful opportunity must stay silent")
        class Store:
            def __init__(self):
                self.finished = []
            def load_policy(self):
                return SimpleNamespace(enabled=True, session_key="agent:main:telegram:dm:123456789")
            def claim(self, now=None):
                return {"id": "test-no-op", "kind": "context_changed", "evidence": "a" * 64,
                        "purpose": False, "session_key": self.load_policy().session_key}
            def finish(self, event_id, status):
                self.finished.append((event_id, status))
        module = load_plugin()
        guard = sys.modules[module.__name__ + ".gateway_guard"]
        with tempfile.TemporaryDirectory() as directory:
            home, store = Path(directory), Store()
            runtime = module.Runtime(Facade(), home, store=store, appraiser=lambda *_: {"useful": False})
            guard.mark_gateway_ready(home)
            result = runtime.tick()
            self.assertEqual(result["status"], "no_op")
            self.assertEqual(store.finished, [("test-no-op", "rejected")])
            runtime.close()


if __name__ == "__main__":
    unittest.main()
