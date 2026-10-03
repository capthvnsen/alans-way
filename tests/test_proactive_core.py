"""Contract tests for the companion-owned, metadata-only decision store."""
from __future__ import annotations

import importlib.util
import json
from pathlib import Path
import sqlite3
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier


CORE_PATH = Path(__file__).resolve().parents[1] / "plugins" / "proactive-primary" / "proactive_core.py"


def load_core():
    if not CORE_PATH.exists():
        raise AssertionError("The companion proactivity core has not been implemented")
    spec = importlib.util.spec_from_file_location("companion_proactive_core", CORE_PATH)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


class PolicyTests(unittest.TestCase):
    def test_policy_defaults_are_disabled_and_round_trip(self):
        core = load_core()
        expected = {
            "enabled": False,
            "primary_profile": "default",
            "session_key": "",
            "timezone": "America/Denver",
            "quiet_start": 22,
            "quiet_end": 8,
            "max_daily_wakes": 3,
            "max_low_purpose_wakes": 1,
            "min_interval_seconds": 7200,
            "event_ttl_seconds": 259200,
            "max_pending": 64,
            "debounce_seconds": 120,
        }
        policy = core.Policy.from_dict({})
        self.assertEqual(policy.to_dict(), expected)
        self.assertEqual(core.Policy.from_dict(policy.to_dict()), policy)

    def test_malformed_policy_never_coerces_or_exceeds_safety_caps(self):
        core = load_core()
        bad = [
            None, [], {"unknown": 1}, {"enabled": "false"},
            {"enabled": 1}, {"primary_profile": "secondary"},
            {"session_key": 123}, {"session_key": "route\ntext"},
            {"timezone": "No/SuchZone"}, {"quiet_start": 24},
            {"quiet_end": -1}, {"quiet_start": True},
            {"max_daily_wakes": 4}, {"max_low_purpose_wakes": 2},
            {"min_interval_seconds": -1}, {"event_ttl_seconds": 0},
            {"max_pending": 0}, {"max_pending": 1025},
            {"debounce_seconds": 1.5}, {"debounce_seconds": -1},
            {"min_interval_seconds": 2**64},
        ]
        for settings in bad:
            with self.subTest(settings=settings):
                with self.assertRaises(ValueError):
                    core.Policy.from_dict(settings)
        with self.assertRaises(ValueError):
            core.Policy(enabled="true")


class StoreTests(unittest.TestCase):
    def setUp(self):
        self.core = load_core()
        self.temp = tempfile.TemporaryDirectory(prefix="proactive-core-")
        self.addCleanup(self.temp.cleanup)
        self.state_dir = Path(self.temp.name) / "companion-state"
        self.now = datetime(2026, 6, 1, 15, tzinfo=timezone.utc)  # Denver 09:00

    def store(self):
        self.assertTrue(hasattr(self.core, "Store"), "Durable Store is missing")
        return self.core.Store(self.state_dir)

    def configured(self, **changes):
        store = self.store()
        settings = {"enabled": True, "session_key": "gateway:existing-route", "debounce_seconds": 0}
        settings.update(changes)
        store.update_policy(settings)
        return store

    def test_events_dedupe_durably_by_route_kind_and_evidence(self):
        store = self.configured()
        self.assertTrue(hasattr(store, "record_event"), "Event admission is missing")
        self.assertTrue(store.record_event("task_changed", "task:opaque-001", purpose=True, now=self.now))
        self.assertFalse(store.record_event("task_changed", "task:opaque-001", purpose=True, now=self.now))
        restarted = self.store()
        self.assertFalse(restarted.record_event("task_changed", "task:opaque-001", now=self.now))
        self.assertTrue(restarted.record_event("worker_update", "task:opaque-001", now=self.now))
        claim = restarted.claim(now=self.now)
        self.assertEqual(claim["kind"], "task_changed")
        self.assertEqual(claim["evidence"], "task:opaque-001")
        self.assertIs(claim["purpose"], True)
        self.assertEqual(claim["session_key"], "gateway:existing-route")
        self.assertEqual(claim["policy_revision"], 1)
        self.assertTrue(claim["id"])
        self.assertFalse(restarted.record_event("task_changed", "task:opaque-001", now=self.now))

    def test_admission_accepts_only_opaque_local_metadata_and_aware_times(self):
        store = self.configured()
        for kind, evidence, purpose in [
            ("network_message", "opaque-1", False),
            ("task_changed", "private conversation text", False),
            ("task_changed", "https://host/path", False),
            ("task_changed", "", False),
            ("task_changed", "x" * 257, False),
            ("task_changed", {"text": "secret"}, False),
            ("task_changed", "opaque-2", "true"),
            ("task_changed", "opaque-2", 1),
        ]:
            with self.subTest(kind=kind, evidence=evidence, purpose=purpose):
                self.assertIs(store.record_event(kind, evidence, purpose=purpose, now=self.now), False)
        for method in (lambda: store.record_event("task_changed", "opaque-naive", now=datetime(2026, 6, 1)),
                       lambda: store.claim(now=datetime(2026, 6, 1))):
            with self.assertRaises(ValueError):
                method()
        self.assertIsNone(store.claim(now=self.now))
        unbound = self.core.Store(Path(self.temp.name) / "unbound")
        self.assertFalse(unbound.record_event("manual_review", "opaque-unbound", now=self.now))
        unbound.update_policy({"enabled": True})
        self.assertIsNone(unbound.claim(now=self.now))

    def test_pause_is_durable_and_each_claim_reads_live_policy(self):
        store = self.configured(enabled=False)
        self.assertTrue(store.record_event("task_changed", "opaque-pause", purpose=True, now=self.now))
        self.assertIsNone(store.claim(now=self.now))
        restarted = self.store()
        self.assertIsNone(restarted.claim(now=self.now))
        restarted.update_policy({"enabled": True})
        claim = store.claim(now=self.now)
        self.assertEqual(claim["evidence"], "opaque-pause")
        self.assertEqual(claim["policy_revision"], 2)
        restarted.update_policy({"enabled": False})
        self.assertTrue(store.record_event("worker_update", "opaque-paused-again", now=self.now))
        self.assertIsNone(store.claim(now=self.now))

    def test_quiet_hours_follow_denver_boundaries_and_dst(self):
        # UTC probes: Denver 21:59 -> 22:00 -> 07:59 -> 08:00.
        for year, month, day, utc_start in [(2026, 6, 1, 4), (2026, 1, 1, 5)]:
            with self.subTest(month=month):
                store = self.core.Store(Path(self.temp.name) / f"quiet-{month}")
                store.update_policy({"enabled": True, "session_key": "route:quiet", "debounce_seconds": 0})
                quiet = datetime(year, month, day + 1, utc_start, tzinfo=timezone.utc)
                store.record_event("manual_review", "opaque-quiet", purpose=True, now=quiet - timedelta(minutes=1))
                self.assertIsNone(store.claim(now=quiet))
                self.assertIsNone(store.claim(now=quiet + timedelta(hours=9, minutes=59)))
                self.assertIsNotNone(store.claim(now=quiet + timedelta(hours=10)))
        for name, beginning, ending in [
            ("spring", datetime(2026, 3, 8, 8, 59, tzinfo=timezone.utc), datetime(2026, 3, 8, 14, tzinfo=timezone.utc)),
            ("fall", datetime(2026, 11, 1, 7, 30, tzinfo=timezone.utc), datetime(2026, 11, 1, 15, tzinfo=timezone.utc)),
        ]:
            with self.subTest(transition=name):
                store = self.core.Store(Path(self.temp.name) / name)
                store.update_policy({"enabled": True, "session_key": "route:dst", "debounce_seconds": 0})
                store.record_event("task_changed", "opaque-dst", purpose=True, now=beginning)
                self.assertIsNone(store.claim(now=beginning))
                self.assertIsNone(store.claim(now=beginning + timedelta(hours=1)))
                self.assertIsNotNone(store.claim(now=ending))

    def test_claim_waits_for_debounce_and_tombstones_stale_events(self):
        store = self.configured(debounce_seconds=120, event_ttl_seconds=300)
        store.record_event("task_changed", "opaque-debounce", purpose=True, now=self.now)
        self.assertIsNone(store.claim(now=self.now - timedelta(seconds=1)))
        self.assertIsNone(store.claim(now=self.now + timedelta(seconds=119)))
        self.assertEqual(store.claim(now=self.now + timedelta(seconds=120))["evidence"], "opaque-debounce")
        store.record_event("worker_update", "opaque-stale", purpose=True, now=self.now)
        self.assertIsNone(store.claim(now=self.now + timedelta(seconds=300)))
        self.assertFalse(self.store().record_event("worker_update", "opaque-stale", purpose=True, now=self.now + timedelta(seconds=301)))
        self.assertEqual(store.status()["counts"]["expired"], 1)

    def test_purpose_then_kind_priority_then_fifo_selects_work(self):
        store = self.configured(min_interval_seconds=0)
        for kind, evidence, purpose in [
            ("context_changed", "opaque-low", False),
            ("worker_update", "opaque-worker", True),
            ("task_changed", "opaque-task", True),
            ("manual_review", "opaque-manual", True),
        ]:
            store.record_event(kind, evidence, purpose=purpose, now=self.now)
        self.assertEqual([store.claim(now=self.now)["evidence"] for _ in range(3)],
                         ["opaque-manual", "opaque-task", "opaque-worker"])
        fifo = self.core.Store(Path(self.temp.name) / "fifo")
        fifo.update_policy({"enabled": True, "session_key": "route:fifo", "debounce_seconds": 0, "min_interval_seconds": 0})
        for evidence in ("opaque-first", "opaque-second"):
            fifo.record_event("task_changed", evidence, purpose=True, now=self.now)
        self.assertEqual(fifo.claim(now=self.now)["evidence"], "opaque-first")
        self.assertEqual(fifo.claim(now=self.now)["evidence"], "opaque-second")

    def test_spacing_reserves_before_dispatch_and_survives_restart(self):
        store = self.configured()
        store.record_event("task_changed", "opaque-spacing-1", purpose=True, now=self.now)
        store.record_event("task_changed", "opaque-spacing-2", purpose=True, now=self.now)
        self.assertIsNotNone(store.claim(now=self.now))
        restarted = self.store()
        self.assertIsNone(restarted.claim(now=self.now + timedelta(seconds=7199)))
        self.assertIsNone(restarted.claim(now=self.now - timedelta(seconds=1)))
        self.assertEqual(restarted.claim(now=self.now + timedelta(seconds=7200))["evidence"], "opaque-spacing-2")

    def test_daily_caps_count_reservations_not_quota_targets(self):
        store = self.configured(min_interval_seconds=0)
        for index in range(5):
            store.record_event("task_changed", f"opaque-purpose-{index}", purpose=True, now=self.now)
        claims = [store.claim(now=self.now) for _ in range(5)]
        self.assertEqual(sum(item is not None for item in claims), 3)
        self.assertIsNone(self.store().claim(now=self.now + timedelta(hours=8)))
        self.assertIsNotNone(store.claim(now=self.now + timedelta(days=1)))
        low = self.core.Store(Path(self.temp.name) / "low-budget")
        low.update_policy({"enabled": True, "session_key": "route:low", "debounce_seconds": 0, "min_interval_seconds": 0})
        for index in range(3):
            low.record_event("context_changed", f"opaque-low-{index}", now=self.now)
        self.assertIsNotNone(low.claim(now=self.now))
        self.assertIsNone(low.claim(now=self.now))
        low.record_event("worker_update", "opaque-useful-after-low", purpose=True, now=self.now)
        self.assertIsNotNone(low.claim(now=self.now))
        low.update_policy({"max_daily_wakes": 1})
        self.assertIsNone(low.claim(now=self.now))
        empty = self.core.Store(Path(self.temp.name) / "no-events")
        empty.update_policy({"enabled": True, "session_key": "route:empty"})
        for hours in range(0, 72, 3):
            self.assertIsNone(empty.claim(now=self.now + timedelta(hours=hours)))
        self.assertEqual(sum(empty.status()["counts"].values()), 0)

    def test_route_changes_tombstone_pending_never_retarget_them(self):
        store = self.configured(min_interval_seconds=0)
        store.record_event("task_changed", "opaque-keep-route", purpose=True, now=self.now)
        store.update_policy({"debounce_seconds": 15})
        self.assertIsNone(store.claim(now=self.now))
        original = store.claim(now=self.now + timedelta(seconds=15))
        self.assertEqual(original["session_key"], "gateway:existing-route")
        self.assertEqual(original["policy_revision"], 2)
        store.record_event("worker_update", "opaque-old-pending", purpose=True, now=self.now)
        store.update_policy({"session_key": "gateway:new-existing-route", "debounce_seconds": 0})
        self.assertIsNone(store.claim(now=self.now + timedelta(minutes=1)))
        self.assertEqual(store.status()["counts"]["dropped"], 1)
        self.assertTrue(store.record_event("worker_update", "opaque-old-pending", purpose=True, now=self.now + timedelta(minutes=1)))
        newer = store.claim(now=self.now + timedelta(minutes=1))
        self.assertEqual(newer["session_key"], "gateway:new-existing-route")
        self.assertNotEqual(original["id"], newer["id"])
        store.update_policy({"session_key": "gateway:existing-route"})
        self.assertFalse(store.record_event("worker_update", "opaque-old-pending", purpose=True, now=self.now))
        self.assertIsNone(self.store().claim(now=self.now + timedelta(hours=1)))

    def test_pending_queue_is_bounded_even_after_live_shrink(self):
        store = self.configured(max_pending=2, min_interval_seconds=0, event_ttl_seconds=300)
        self.assertTrue(store.record_event("task_changed", "opaque-q1", purpose=True, now=self.now))
        self.assertTrue(store.record_event("worker_update", "opaque-q2", purpose=True, now=self.now))
        self.assertFalse(store.record_event("manual_review", "opaque-q3", purpose=True, now=self.now))
        self.assertEqual(store.status()["counts"]["pending"], 2)
        store.update_policy({"max_pending": 1})
        self.assertEqual(store.status()["counts"]["pending"], 1)
        self.assertEqual(store.status()["counts"]["dropped"], 1)
        self.assertEqual(store.claim(now=self.now)["evidence"], "opaque-q1")
        self.assertTrue(store.record_event("manual_review", "opaque-q3", purpose=True, now=self.now))
        self.assertFalse(store.record_event("worker_update", "opaque-q2", purpose=True, now=self.now))
        store.update_policy({"enabled": False})
        self.assertTrue(store.record_event("context_changed", "opaque-after-expiry", now=self.now + timedelta(seconds=300)))
        self.assertEqual(store.status()["counts"]["pending"], 1)
        self.assertEqual(store.status()["counts"]["expired"], 1)

    def test_crashed_dispatch_is_uncertain_and_never_automatically_retried(self):
        store = self.configured(min_interval_seconds=0)
        store.record_event("task_changed", "opaque-crash", purpose=True, now=self.now)
        claim = store.claim(now=self.now)
        self.assertEqual(store.status()["counts"]["dispatching"], 1)
        restarted = self.store()
        self.assertEqual(restarted.status()["counts"].get("uncertain", 0), 1)
        self.assertNotIn("dispatching", restarted.status()["counts"])
        self.assertIsNone(restarted.claim(now=self.now + timedelta(days=1)))
        self.assertFalse(restarted.record_event("task_changed", "opaque-crash", purpose=True, now=self.now + timedelta(days=1)))
        self.assertTrue(claim["id"])

    def test_finish_requires_explicit_status_not_truthy_acceptance(self):
        store = self.configured(min_interval_seconds=0, max_daily_wakes=2)
        self.assertTrue(hasattr(store, "finish"), "Explicit dispatch completion is missing")
        store.record_event("task_changed", "opaque-finish", purpose=True, now=self.now)
        claim = store.claim(now=self.now)
        for result in (True, 1, "true", "accepted", {"accepted": True}, ["accepted_unverified"]):
            with self.subTest(result=result):
                with self.assertRaises(ValueError):
                    store.finish(claim["id"], result)
        self.assertEqual(store.status()["counts"]["dispatching"], 1)
        store.finish(claim["id"], "accepted_unverified")
        self.assertEqual(store.status()["counts"]["accepted_unverified"], 1)
        self.assertNotIn("resolved", store.status()["counts"])
        store.finish(claim["id"], "resolved")
        store.finish(claim["id"], "resolved")  # Idempotent acknowledgement.
        with self.assertRaises(ValueError):
            store.finish(claim["id"], "accepted_unverified")
        with self.assertRaises(ValueError):
            store.finish("not-an-event", "resolved")
        store.record_event("worker_update", "opaque-rejection", purpose=True, now=self.now)
        rejected = store.claim(now=self.now)
        store.finish(rejected["id"], "rejected")
        self.assertFalse(store.record_event("worker_update", "opaque-rejection", now=self.now))
        store.record_event("worker_update", "opaque-distinct-after-rejection", purpose=True, now=self.now)
        self.assertIsNone(store.claim(now=self.now))  # Rejection never refunds budget.
        self.assertIsNotNone(self.store().claim(now=self.now + timedelta(days=1)))
        self.assertEqual(store.status()["counts"]["rejected"], 1)

    def test_concurrent_claims_atomically_reserve_one_shared_daily_budget(self):
        store = self.configured(min_interval_seconds=0)
        for index in range(12):
            store.record_event("task_changed", f"opaque-concurrent-{index}", purpose=True, now=self.now)
        stores = [self.store() for _ in range(12)]
        barrier = Barrier(len(stores))

        def reserve(instance):
            barrier.wait(timeout=10)
            return instance.claim(now=self.now)

        with ThreadPoolExecutor(max_workers=len(stores)) as pool:
            claims = [claim for claim in pool.map(reserve, stores) if claim is not None]
        self.assertEqual(len(claims), 3)
        self.assertEqual(len({claim["id"] for claim in claims}), 3)
        self.assertEqual(store.status().get("reservation_count"), 3)
        self.assertEqual(store.status()["counts"]["pending"], 9)
        self.assertIsNone(store.claim(now=self.now))

    def test_public_status_and_bounded_audit_never_disclose_private_metadata(self):
        store = self.configured(session_key="route:private-opaque-target")
        self.assertIs(store.status().get("route_bound"), True)
        self.assertNotIn("session_key", store.status()["policy"])
        self.assertTrue(store.record_event("task_changed", "task:private-opaque-evidence", purpose=True, now=self.now))
        raw_context = "secret conversation never admitted"
        self.assertFalse(store.record_event("context_changed", raw_context, now=self.now))
        claim = store.claim(now=self.now)
        store.finish(claim["id"], "accepted_unverified")
        for index in range(300):
            store.update_policy({"enabled": index % 2 == 0})
        status = self.store().status()
        self.assertGreater(len(status["audit"]), 0)
        self.assertLessEqual(len(status["audit"]), 256)
        public = json.dumps(status)
        for private in ("route:private-opaque-target", "task:private-opaque-evidence", raw_context, claim["id"]):
            self.assertNotIn(private, public)
        for entry in status["audit"]:
            self.assertEqual(set(entry), {"sequence", "action", "policy_revision", "count"})
        with sqlite3.connect(self.state_dir / "proactivity.sqlite3") as db:
            audit_text = repr(db.execute("SELECT * FROM audit").fetchall())
        self.assertNotIn(raw_context, audit_text)
        self.assertNotIn("private-opaque", audit_text)

    def test_corrupt_persisted_policy_fails_closed_without_silent_repair(self):
        store = self.configured()
        store.record_event("task_changed", "opaque-before-corruption", purpose=True, now=self.now)
        corrupt_values = ["not-json", json.dumps({"enabled": "true"}), json.dumps({"enabled": True})]
        for corrupt in corrupt_values:
            with self.subTest(corrupt=corrupt):
                with sqlite3.connect(self.state_dir / "proactivity.sqlite3") as db:
                    db.execute("UPDATE policy SET settings=? WHERE singleton=1", (corrupt,))
                try:
                    loaded = store.load_policy()
                except ValueError as exc:
                    self.fail(f"Malformed persisted policy must load disabled, not escape: {exc}")
                self.assertFalse(loaded.enabled)
                self.assertIsNone(store.claim(now=self.now))
                self.assertFalse(store.record_event("manual_review", "opaque-after-corruption", now=self.now))
                restarted = self.store()
                self.assertIs(restarted.status()["policy_valid"], False)
                self.assertFalse(restarted.status()["enabled"])
                with self.assertRaises(ValueError):
                    restarted.update_policy({"enabled": True})
                with sqlite3.connect(self.state_dir / "proactivity.sqlite3") as db:
                    self.assertEqual(db.execute("SELECT settings FROM policy").fetchone()[0], corrupt)

    def test_history_bound_fails_closed_without_forgetting_dedupe_tombstones(self):
        store = self.configured(enabled=False, event_ttl_seconds=1)
        for index in range(4096):
            self.assertTrue(store.record_event("context_changed", f"opaque-history-{index}", now=self.now + timedelta(seconds=index * 2)))
        self.assertFalse(store.record_event("manual_review", "opaque-over-capacity", now=self.now + timedelta(seconds=8192)))
        status = self.store().status()
        self.assertIs(status["storage_full"], True)
        self.assertEqual(sum(status["counts"].values()), 4096)
        self.assertLessEqual(len(status["audit"]), 256)
        self.assertFalse(store.record_event("context_changed", "opaque-history-0", now=self.now + timedelta(seconds=8193)))

    def test_private_sqlite_file_is_isolated_and_never_follows_a_symlink(self):
        self.state_dir.mkdir(mode=0o700)
        native = self.state_dir / "state.db"
        native.write_bytes(b"native-state-must-stay-untouched")
        store = self.configured()
        self.assertEqual((self.state_dir / "proactivity.sqlite3").stat().st_mode & 0o077, 0)
        self.assertEqual(native.read_bytes(), b"native-state-must-stay-untouched")
        linked = Path(self.temp.name) / "linked-state"
        linked.mkdir()
        target = Path(self.temp.name) / "foreign-db"
        target.write_bytes(b"not-a-companion-database")
        (linked / "proactivity.sqlite3").symlink_to(target)
        with self.assertRaises(OSError):
            self.core.Store(linked)
        self.assertEqual(target.read_bytes(), b"not-a-companion-database")
        store.update_policy({"enabled": False})
        self.assertEqual(native.read_bytes(), b"native-state-must-stay-untouched")

    def test_policy_updates_are_durable_validated_and_revisioned(self):
        store = self.store()
        self.assertFalse(store.load_policy().enabled)
        self.assertEqual(store.status()["policy_revision"], 0)
        store.update_policy({"enabled": True, "session_key": "gateway:existing-route"})
        restarted = self.store()
        self.assertTrue(restarted.load_policy().enabled)
        self.assertEqual(restarted.load_policy().session_key, "gateway:existing-route")
        self.assertEqual(restarted.status()["policy_revision"], 1)
        with self.assertRaises(ValueError):
            restarted.update_policy({"enabled": "false"})
        self.assertTrue(store.load_policy().enabled)
        self.assertEqual(store.status()["policy_revision"], 1)
        restarted.update_policy({"enabled": False})
        self.assertFalse(store.load_policy().enabled)
        self.assertEqual(store.status()["policy_revision"], 2)


if __name__ == "__main__":
    unittest.main()
