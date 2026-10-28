import tempfile
import unittest
from pathlib import Path

from mobile.voice.protocol import (
    LaunchBinding,
    LaunchTicketStore,
    TurnRegistry,
    verify_telegram_init_data,
)


def signed_init_data(token, *, user_id="42", auth_date=1_800_000_000):
    import hashlib
    import hmac
    import json
    import urllib.parse

    values = {
        "auth_date": str(auth_date),
        "query_id": "AAE-test",
        "user": json.dumps({"id": int(user_id), "first_name": "Ada"}, separators=(",", ":")),
    }
    check = "\n".join(f"{key}={values[key]}" for key in sorted(values))
    secret = hmac.new(b"WebAppData", token.encode(), hashlib.sha256).digest()
    values["hash"] = hmac.new(secret, check.encode(), hashlib.sha256).hexdigest()
    return urllib.parse.urlencode(values)


class TelegramInitDataTests(unittest.TestCase):
    def test_valid_and_fresh_data_returns_user_id(self):
        raw = signed_init_data("123:secret", auth_date=1_800_000_000)
        self.assertEqual(
            verify_telegram_init_data(raw, "123:secret", now=1_800_000_100)["user_id"],
            "42",
        )

    def test_rejects_tampering_expiry_and_duplicate_keys(self):
        raw = signed_init_data("123:secret", auth_date=1_800_000_000)
        self.assertIsNone(verify_telegram_init_data(raw.replace("Ada", "Eve"), "123:secret", now=1_800_000_100))
        self.assertIsNone(verify_telegram_init_data(raw, "123:secret", now=1_800_100_000))
        self.assertIsNone(verify_telegram_init_data(raw + "&auth_date=1800000000", "123:secret", now=1_800_000_100))


class LaunchTicketTests(unittest.TestCase):
    def test_ticket_is_one_time_and_user_bound(self):
        with tempfile.TemporaryDirectory() as directory:
            store = LaunchTicketStore(Path(directory) / "voice.sqlite3")
            binding = LaunchBinding(
                profile="default", bot_id="9001", user_id="42", chat_id="42",
                session_key="canonical-existing-key", thread_id=None,
            )
            ticket = store.issue(binding, now=100)
            self.assertIsNone(store.consume(ticket, user_id="43", now=101))
            self.assertEqual(store.consume(ticket, user_id="42", now=101), binding)
            self.assertIsNone(store.consume(ticket, user_id="42", now=102))

    def test_session_reset_invalidates_launches_and_call_tokens(self):
        with tempfile.TemporaryDirectory() as directory:
            store = LaunchTicketStore(Path(directory) / "voice.sqlite3")
            binding = LaunchBinding(
                profile="default", bot_id="9001", user_id="42", chat_id="42",
                session_key="canonical-existing-key", session_generation="generation-1",
            )
            ticket = store.issue(binding, now=100)
            store.create_call("call-1", "secret-call-token", binding, now=100)
            self.assertEqual(store.invalidate_generation("generation-1"), 2)
            self.assertIsNone(store.consume(ticket, user_id="42", now=101))
            self.assertIsNone(store.get_call("call-1", "secret-call-token", now=101))


class TurnRegistryTests(unittest.TestCase):
    def test_idempotency_and_marker_correlation_are_exact(self):
        registry = TurnRegistry()
        first, created = registry.create("call-a", "turn-a", "what time is it?", "session-a")
        again, created_again = registry.create("call-a", "turn-a", "what time is it?", "session-a")
        self.assertTrue(created)
        self.assertFalse(created_again)
        self.assertEqual(first.marker, again.marker)
        self.assertIsNone(registry.capture("session-a", "what time is it?", "wrong"))
        captured = registry.capture("session-a", first.injected_text, "It is noon.")
        self.assertEqual(captured.reply_text, "It is noon.")
        self.assertIsNone(registry.capture("session-a", first.injected_text, "duplicate"))

    def test_different_session_never_captures_reply(self):
        registry = TurnRegistry()
        turn, _ = registry.create("call-a", "turn-a", "hello", "session-a")
        self.assertIsNone(registry.capture("session-b", turn.injected_text, "wrong thread"))

    def test_synthesis_failure_is_terminal_and_transcript_delivery_is_claimed_once(self):
        with tempfile.TemporaryDirectory() as directory:
            registry = TurnRegistry(Path(directory) / "voice.sqlite3")
            registry.create("call-a", "turn-a", "hello", "session-a")
            self.assertTrue(registry.claim_transcript_delivery("call-a", "turn-a"))
            self.assertFalse(registry.claim_transcript_delivery("call-a", "turn-a"))
            turn = registry.get("call-a", "turn-a")
            registry.capture("session-a", turn.injected_text, "reply")
            registry.fail("call-a", "turn-a", "configured speech synthesis failed")
            self.assertEqual(registry.get("call-a", "turn-a").status, "failed")

    def test_gateway_restart_marks_unobserved_turn_unknown_without_replay(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "voice.sqlite3"
            original = TurnRegistry(path)
            original.create("call-a", "turn-a", "hello", "session-a")
            restarted = TurnRegistry(path)
            self.assertEqual(restarted.recover_pending(), 1)
            turn = restarted.get("call-a", "turn-a")
            self.assertEqual(turn.status, "failed")
            self.assertIn("status is unknown", turn.error)
            self.assertEqual(restarted.recover_pending(), 0)

    def test_existing_interruption_flag_suppresses_audio_after_upgrade(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "voice.sqlite3"
            registry = TurnRegistry(path)
            turn, _ = registry.create("call-a", "turn-a", "hello", "session-a")
            registry.capture("session-a", turn.injected_text, "reply")
            registry.complete_audio("call-a", "turn-a", b"old audio", "audio/wav")
            # Older brokers recorded this flag without removing saved audio.
            with registry._connection() as db:
                db.execute("UPDATE turns SET playback_interrupted=1")
            upgraded = TurnRegistry(path)
            self.assertTrue(upgraded.get("call-a", "turn-a").playback_interrupted)
            self.assertIsNone(upgraded.get_audio("call-a", "turn-a"))


if __name__ == "__main__":
    unittest.main()


class RetentionTests(unittest.TestCase):
    def test_purges_calls_and_turns_older_than_a_day_only(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "voice.sqlite3"
            store, turns = LaunchTicketStore(path), TurnRegistry(path)
            binding = LaunchBinding("default", "9001", "42", "42", "session")
            store.create_call("old", "old-token", binding, now=1_000)
            store.create_call("new", "new-token", binding, now=1_000 + 23 * 3600)
            turns.create("old", "t1", "hello", "session")
            turns.create("new", "t2", "hello", "session")
            with store._connection() as db:
                db.execute("UPDATE turns SET created_at=1000 WHERE call_id='old'")
                db.execute("UPDATE turns SET created_at=? WHERE call_id='new'", (1_000 + 23 * 3600,))
            store.purge_older_than(now=1_000 + 25 * 3600)
            self.assertIsNone(turns.get("old", "t1"))
            self.assertIsNotNone(turns.get("new", "t2"))
            with store._connection() as db:
                self.assertEqual(db.execute("SELECT call_id FROM calls").fetchall(), [("new",)])
