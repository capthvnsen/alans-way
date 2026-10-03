"""The observer is passive outside an explicitly armed gateway."""
from pathlib import Path
from types import SimpleNamespace
import tempfile
import threading
import unittest
from test_proactive_plugin import load_plugin


class WorkerTests(unittest.TestCase):
    def test_concurrent_ticks_cannot_dispatch_two_turns(self):
        from concurrent.futures import ThreadPoolExecutor
        module = load_plugin()
        entered, release = threading.Event(), threading.Event()
        injected = []
        def appraise(*_):
            entered.set()
            release.wait(2)
            return {"useful": True, "action": "ask", "task_id": None}
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            runtime = module.Runtime(SimpleNamespace(inject_message=lambda *a, **k: injected.append(k) or True), home, appraiser=appraise)
            runtime.store.update_policy({"enabled": True, "session_key": "agent:main:telegram:dm:123456789",
                "quiet_start": 0, "quiet_end": 0, "debounce_seconds": 0, "min_interval_seconds": 0})
            runtime.store.record_event("manual_review", "first", purpose=True)
            runtime.store.record_event("manual_review", "second", purpose=True)
            guard = __import__(module.__name__ + ".gateway_guard", fromlist=["mark_gateway_ready"])
            guard.mark_gateway_ready(home)
            with ThreadPoolExecutor(max_workers=2) as pool:
                first = pool.submit(runtime.tick)
                self.assertTrue(entered.wait(1))
                second = pool.submit(runtime.tick)
                self.assertIsNone(second.result(timeout=1))
                release.set()
                self.assertEqual(first.result(timeout=2)["status"], "accepted_unverified")
            self.assertEqual(len(injected), 1)
            self.assertEqual(runtime.store.status()["counts"]["pending"], 1)
            runtime.close()

    def test_background_observer_uses_no_model_without_an_armed_gateway(self):
        module = load_plugin()
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            runtime = module.Runtime(SimpleNamespace(), home)
            runtime.start(interval=0.01)
            self.assertTrue(runtime.worker.is_alive())
            self.assertFalse((home / "companion").exists())
            runtime.close()
            self.assertFalse(runtime.worker.is_alive())

    def test_unresolved_native_acceptance_prevents_a_second_wake(self):
        module = load_plugin()
        with tempfile.TemporaryDirectory() as directory:
            runtime = module.Runtime(SimpleNamespace(), Path(directory), appraiser=lambda *_: {"useful": True})
            runtime.store.update_policy({"enabled": True, "session_key": "agent:main:telegram:dm:123456789",
                                         "quiet_start": 0, "quiet_end": 0, "debounce_seconds": 0,
                                         "min_interval_seconds": 0})
            runtime.store.record_event("manual_review", "first", purpose=True)
            event = runtime.store.claim()
            runtime.store.finish(event["id"], "accepted_unverified")
            runtime.store.record_event("manual_review", "second", purpose=True)
            guard = __import__(module.__name__ + ".gateway_guard", fromlist=["mark_gateway_ready"])
            guard.mark_gateway_ready(Path(directory))
            self.assertIsNone(runtime.tick())
            self.assertEqual(runtime.store.status()["counts"]["pending"], 1)
            runtime.close()

    def test_revoked_watch_cannot_be_continued_after_appraisal(self):
        module = load_plugin()
        with tempfile.TemporaryDirectory() as directory:
            runtime = module.Runtime(SimpleNamespace(inject_message=lambda *a, **k: True), Path(directory))
            runtime.store.update_policy({"enabled": True, "session_key": "agent:main:telegram:dm:123456789",
                                         "quiet_start": 0, "quiet_end": 0, "debounce_seconds": 0})
            runtime.ledger.record_task({"id": "watch", "title": "Approved work", "scope": "Draft test cases",
                                       "next_action": "Draft", "owner": "primary", "status": "active", "approved": True})
            def appraise(*args):
                runtime.ledger.finish_task("watch", "cancelled")
                return {"useful": True, "action": "continue_approved", "task_id": "watch"}
            runtime._appraiser = appraise
            runtime.store.record_event("manual_review", "approval-revoked", purpose=True)
            guard = __import__(module.__name__ + ".gateway_guard", fromlist=["mark_gateway_ready"])
            guard.mark_gateway_ready(Path(directory))
            self.assertEqual(runtime.tick()["status"], "rejected")
            runtime.close()

    def test_worker_observes_once_after_real_gateway_gate_and_shuts_down(self):
        module = load_plugin()
        observed = threading.Event()
        with tempfile.TemporaryDirectory() as directory:
            runtime = module.Runtime(SimpleNamespace(), Path(directory))
            runtime.store.update_policy({"enabled": True, "session_key": "agent:main:telegram:dm:123456789"})
            runtime.observe = lambda: observed.set()
            runtime.tick = lambda: None
            module.mark_gateway_ready = __import__(module.__name__ + ".gateway_guard", fromlist=["mark_gateway_ready"]).mark_gateway_ready
            module.mark_gateway_ready(Path(directory))
            runtime.start(interval=0.01)
            self.assertTrue(observed.wait(1))
            runtime.close()
            self.assertFalse(runtime.worker.is_alive())


if __name__ == "__main__":
    unittest.main()
