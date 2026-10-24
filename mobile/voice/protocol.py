"""Small, durable protocol primitives shared by the Mini App and plugin."""
from __future__ import annotations

import hashlib
import hmac
import json
import secrets
import sqlite3
import time
import urllib.parse
from contextlib import contextmanager
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Any


@dataclass(frozen=True)
class LaunchBinding:
    profile: str
    bot_id: str
    user_id: str
    chat_id: str
    session_key: str
    thread_id: str | None = None
    session_generation: str | None = None


def verify_telegram_init_data(
    raw: str, bot_token: str, *, now: float | None = None, max_age: int = 600
) -> dict[str, Any] | None:
    """Validate Telegram Mini App initData and return only the trusted identity.

    Duplicate query keys, malformed/ambiguous values, stale data, future data,
    bad signatures and missing user IDs all fail closed.
    """
    if not raw or not bot_token:
        return None
    try:
        pairs = urllib.parse.parse_qsl(raw, keep_blank_values=True, strict_parsing=True)
    except (ValueError, UnicodeError):
        return None
    if len({key for key, _ in pairs}) != len(pairs):
        return None
    values = dict(pairs)
    supplied = values.pop("hash", "")
    if not supplied:
        return None
    check = "\n".join(f"{key}={value}" for key, value in sorted(values.items()))
    secret = hmac.new(b"WebAppData", bot_token.encode(), hashlib.sha256).digest()
    expected = hmac.new(secret, check.encode(), hashlib.sha256).hexdigest()
    try:
        signature_ok = hmac.compare_digest(expected, supplied)
    except TypeError:
        return None
    if not signature_ok:
        return None
    try:
        auth_date = int(values["auth_date"])
        stamp = time.time() if now is None else now
        if auth_date > stamp + 30 or stamp - auth_date > max_age:
            return None
        user = json.loads(values["user"])
        user_id = str(int(user["id"]))
    except (KeyError, TypeError, ValueError, OverflowError, json.JSONDecodeError):
        return None
    return {"user_id": user_id, "auth_date": auth_date}


class LaunchTicketStore:
    """One-use, short-lived launch tickets. The DB contains server bindings only."""

    def __init__(self, path: Path, *, ttl_seconds: int = 300):
        self.path = Path(path)
        self.ttl_seconds = ttl_seconds
        self.path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        self._db().close()

    def _db(self):
        db = sqlite3.connect(self.path, timeout=10)
        db.execute("PRAGMA journal_mode=WAL")
        db.execute("PRAGMA foreign_keys=ON")
        db.execute("CREATE TABLE IF NOT EXISTS launch_tickets (ticket_hash TEXT PRIMARY KEY, binding TEXT NOT NULL, expires_at INTEGER NOT NULL, consumed_at INTEGER)")
        db.execute("CREATE TABLE IF NOT EXISTS calls (call_id TEXT PRIMARY KEY, token_hash TEXT NOT NULL, binding TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, closed_at INTEGER)")
        db.execute("CREATE TABLE IF NOT EXISTS turns (call_id TEXT NOT NULL, turn_id TEXT NOT NULL, session_key TEXT NOT NULL, marker TEXT NOT NULL, injected_text TEXT NOT NULL, transcript TEXT NOT NULL, reply_text TEXT NOT NULL DEFAULT '', audio BLOB, audio_mime TEXT, status TEXT NOT NULL, error TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, playback_interrupted INTEGER NOT NULL DEFAULT 0, transcript_delivery_claimed INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(call_id, turn_id), FOREIGN KEY(call_id) REFERENCES calls(call_id))")
        for table, column in (("calls", "closed_at INTEGER"), ("turns", "playback_interrupted INTEGER NOT NULL DEFAULT 0"), ("turns", "transcript_delivery_claimed INTEGER NOT NULL DEFAULT 0")):
            try:
                db.execute(f"ALTER TABLE {table} ADD COLUMN {column}")
            except sqlite3.OperationalError as exc:
                if "duplicate column" not in str(exc).lower():
                    raise
        db.commit()
        return db

    @contextmanager
    def _connection(self):
        db = self._db()
        try:
            yield db
            db.commit()
        except Exception:
            db.rollback()
            raise
        finally:
            db.close()

    @staticmethod
    def _binding_json(binding: LaunchBinding) -> str:
        return json.dumps(binding.__dict__, separators=(",", ":"), sort_keys=True)

    @staticmethod
    def _binding_from_json(payload: str) -> LaunchBinding:
        return LaunchBinding(**json.loads(payload))

    def issue(self, binding: LaunchBinding, *, now: int | None = None) -> str:
        stamp = int(time.time() if now is None else now)
        ticket = secrets.token_urlsafe(32)
        digest = hashlib.sha256(ticket.encode()).hexdigest()
        with self._connection() as db:
            db.execute("INSERT INTO launch_tickets(ticket_hash,binding,expires_at) VALUES(?,?,?)", (digest, self._binding_json(binding), stamp + self.ttl_seconds))
        return ticket

    def consume(self, ticket: str, *, user_id: str, now: int | None = None) -> LaunchBinding | None:
        if not ticket:
            return None
        stamp = int(time.time() if now is None else now)
        digest = hashlib.sha256(ticket.encode()).hexdigest()
        with self._connection() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT binding, expires_at, consumed_at FROM launch_tickets WHERE ticket_hash=?", (digest,)).fetchone()
            if not row or row[2] is not None or row[1] < stamp:
                db.rollback()
                return None
            binding = self._binding_from_json(row[0])
            if not hmac.compare_digest(binding.user_id, str(user_id)):
                db.rollback()
                return None
            db.execute("UPDATE launch_tickets SET consumed_at=? WHERE ticket_hash=? AND consumed_at IS NULL", (stamp, digest))
            db.commit()
        return binding

    def create_call(self, call_id: str, token: str, binding: LaunchBinding, *, now: int | None = None, ttl_seconds: int = 3600) -> None:
        stamp = int(time.time() if now is None else now)
        digest = hashlib.sha256(token.encode()).hexdigest()
        with self._connection() as db:
            db.execute("INSERT INTO calls(call_id,token_hash,binding,created_at,expires_at) VALUES(?,?,?,?,?)", (call_id, digest, self._binding_json(binding), stamp, stamp + ttl_seconds))

    def get_call(self, call_id: str, token: str, *, now: int | None = None) -> LaunchBinding | None:
        stamp = int(time.time() if now is None else now)
        with self._connection() as db:
            row = db.execute("SELECT token_hash,binding,expires_at,closed_at FROM calls WHERE call_id=?", (call_id,)).fetchone()
        if not row or row[2] < stamp or row[3] is not None or not hmac.compare_digest(row[0], hashlib.sha256(token.encode()).hexdigest()):
            return None
        return self._binding_from_json(row[1])

    def token_active(self, token: str, *, now: int | None = None) -> bool:
        stamp = int(time.time() if now is None else now)
        digest = hashlib.sha256(token.encode()).hexdigest()
        with self._connection() as db:
            return db.execute("SELECT 1 FROM calls WHERE token_hash=? AND expires_at>=? AND closed_at IS NULL", (digest, stamp)).fetchone() is not None

    def purge_older_than(self, seconds: int = 24 * 3600, *, now: int | None = None) -> None:
        """Drop calls, their turns and stale launch tickets so audio blobs do not pile up."""
        cutoff = int(time.time() if now is None else now) - seconds
        with self._connection() as db:
            db.execute("DELETE FROM turns WHERE created_at<?", (cutoff,))
            db.execute("DELETE FROM turns WHERE call_id IN (SELECT call_id FROM calls WHERE created_at<?)", (cutoff,))
            db.execute("DELETE FROM calls WHERE created_at<?", (cutoff,))
            db.execute("DELETE FROM launch_tickets WHERE expires_at<?", (cutoff,))

    def close_call(self, call_id: str, token: str) -> bool:
        digest = hashlib.sha256(token.encode()).hexdigest()
        with self._connection() as db:
            cur = db.execute("UPDATE calls SET closed_at=? WHERE call_id=? AND token_hash=? AND closed_at IS NULL", (int(time.time()), call_id, digest))
        return cur.rowcount == 1

    def invalidate_generation(self, generation: str) -> int:
        """Retire launch tickets and active call credentials after /new or /reset."""
        if not generation:
            return 0
        now = int(time.time())
        with self._connection() as db:
            tickets = db.execute("SELECT ticket_hash,binding FROM launch_tickets WHERE consumed_at IS NULL").fetchall()
            calls = db.execute("SELECT call_id,binding FROM calls WHERE closed_at IS NULL").fetchall()
            ticket_hashes = [key for key, raw in tickets if (binding := self._binding_from_json(raw)).session_generation == generation or binding.session_key == generation]
            call_ids = [key for key, raw in calls if (binding := self._binding_from_json(raw)).session_generation == generation or binding.session_key == generation]
            db.executemany("UPDATE launch_tickets SET consumed_at=? WHERE ticket_hash=?", [(now, key) for key in ticket_hashes])
            db.executemany("UPDATE calls SET closed_at=? WHERE call_id=?", [(now, key) for key in call_ids])
        return len(ticket_hashes) + len(call_ids)

    def invalidate_all(self) -> int:
        """Conservatively retire this profile's calls at a session boundary.

        Gateway slash handlers do not currently receive a generation ID, and
        reset hooks do not include the canonical key. Never guess which call
        survived: close all calls owned by this profile's broker instead.
        """
        now = int(time.time())
        with self._connection() as db:
            tickets = db.execute("UPDATE launch_tickets SET consumed_at=? WHERE consumed_at IS NULL", (now,)).rowcount
            calls = db.execute("UPDATE calls SET closed_at=? WHERE closed_at IS NULL", (now,)).rowcount
        return tickets + calls


@dataclass(frozen=True)
class VoiceTurn:
    call_id: str
    turn_id: str
    session_key: str
    marker: str
    injected_text: str
    transcript: str
    reply_text: str = ""
    status: str = "accepted"
    error: str = ""
    playback_interrupted: bool = False


class TurnRegistry:
    """Durable idempotency and exact reply correlation by random turn marker."""

    def __init__(self, path: Path | None = None):
        self.path = Path(path) if path else None
        self._memory: dict[tuple[str, str], VoiceTurn] = {}
        self._memory_transcript_claims: set[tuple[str, str]] = set()
        if self.path:
            self.path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            db = sqlite3.connect(self.path)
            db.execute("CREATE TABLE IF NOT EXISTS turns (call_id TEXT NOT NULL, turn_id TEXT NOT NULL, session_key TEXT NOT NULL, marker TEXT NOT NULL, injected_text TEXT NOT NULL, transcript TEXT NOT NULL, reply_text TEXT NOT NULL DEFAULT '', audio BLOB, audio_mime TEXT, status TEXT NOT NULL, error TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, playback_interrupted INTEGER NOT NULL DEFAULT 0, transcript_delivery_claimed INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(call_id, turn_id))")
            db.commit()
            db.close()

    @contextmanager
    def _connection(self):
        db = sqlite3.connect(self.path, timeout=10)
        try:
            yield db
            db.commit()
        except Exception:
            db.rollback()
            raise
        finally:
            db.close()

    def create(self, call_id: str, turn_id: str, transcript: str, session_key: str) -> tuple[VoiceTurn, bool]:
        key = (call_id, turn_id)
        if self.path:
            with self._connection() as db:
                row = db.execute("SELECT session_key,marker,injected_text,transcript,reply_text,status,error,playback_interrupted FROM turns WHERE call_id=? AND turn_id=?", key).fetchone()
                if row:
                    if row[0] != session_key or row[3] != transcript:
                        raise ValueError("turn_id already exists with different request data")
                    return VoiceTurn(call_id, turn_id, *row), False
                marker = secrets.token_urlsafe(24)
                injected = f"[Voice turn {marker}] {transcript}"
                stamp = int(time.time())
                db.execute("INSERT INTO turns(call_id,turn_id,session_key,marker,injected_text,transcript,status,created_at,updated_at) VALUES(?,?,?,?,?,?, 'accepted',?,?)", (call_id, turn_id, session_key, marker, injected, transcript, stamp, stamp))
                row = (session_key, marker, injected, transcript, "", "accepted", "")
                return VoiceTurn(call_id, turn_id, *row), True
        if key in self._memory:
            turn = self._memory[key]
            if turn.session_key != session_key or turn.transcript != transcript:
                raise ValueError("turn_id already exists with different request data")
            return turn, False
        marker = secrets.token_urlsafe(24)
        turn = VoiceTurn(call_id, turn_id, session_key, marker, f"[Voice turn {marker}] {transcript}", transcript)
        self._memory[key] = turn
        return turn, True

    def recover_pending(self) -> int:
        """Surface interrupted gateway work as unknown; never replay an agent turn."""
        reason = "Gateway restarted before the voice turn completed; execution status is unknown and it was not replayed"
        if self.path:
            with self._connection() as db:
                cur = db.execute(
                    "UPDATE turns SET status='failed',error=?,updated_at=? WHERE status IN ('accepted','synthesizing')",
                    (reason, int(time.time())),
                )
            return cur.rowcount
        count = 0
        for key, old in tuple(self._memory.items()):
            if old.status in ("accepted", "synthesizing"):
                self._memory[key] = VoiceTurn(
                    old.call_id, old.turn_id, old.session_key, old.marker,
                    old.injected_text, old.transcript, old.reply_text,
                    "failed", reason, old.playback_interrupted,
                )
                count += 1
        return count

    def capture(self, session_key: str, user_message: str, reply_text: str) -> VoiceTurn | None:
        if self.path:
            with self._connection() as db:
                row = db.execute("SELECT call_id,turn_id,session_key,marker,injected_text,transcript,playback_interrupted FROM turns WHERE session_key=? AND status='accepted' ORDER BY created_at", (session_key,)).fetchall()
                match = next((r for r in row if r[4] == user_message), None)
                if not match:
                    return None
                now = int(time.time())
                cur = db.execute("UPDATE turns SET reply_text=?,status='synthesizing',updated_at=? WHERE call_id=? AND turn_id=? AND status='accepted'", (reply_text or "", now, match[0], match[1]))
                if cur.rowcount == 0:
                    return None
                return VoiceTurn(match[0], match[1], match[2], match[3], match[4], match[5], reply_text or "", "synthesizing", playback_interrupted=bool(match[6]))
        match = next((t for t in self._memory.values() if t.session_key == session_key and t.status == "accepted" and t.injected_text == user_message), None)
        if not match:
            return None
        done = replace(match, reply_text=reply_text or "", status="completed")
        self._memory[(match.call_id, match.turn_id)] = done
        return done

    def get(self, call_id: str, turn_id: str) -> VoiceTurn | None:
        if self.path:
            with self._connection() as db:
                row = db.execute("SELECT session_key,marker,injected_text,transcript,reply_text,status,error,playback_interrupted FROM turns WHERE call_id=? AND turn_id=?", (call_id, turn_id)).fetchone()
            return VoiceTurn(call_id, turn_id, *row) if row else None
        return self._memory.get((call_id, turn_id))

    def complete_audio(self, call_id: str, turn_id: str, audio: bytes, mime: str) -> None:
        if self.path:
            with self._connection() as db:
                db.execute("UPDATE turns SET audio=CASE WHEN playback_interrupted=0 THEN ? END,audio_mime=CASE WHEN playback_interrupted=0 THEN ? END,status='completed',updated_at=? WHERE call_id=? AND turn_id=? AND status='synthesizing'", (audio, mime, int(time.time()), call_id, turn_id))
            return
        old = self._memory.get((call_id, turn_id))
        if old:
            self._memory[(call_id, turn_id)] = replace(old, status="completed")

    def set_status(self, call_id: str, turn_id: str, status: str) -> None:
        if self.path:
            with self._connection() as db:
                db.execute("UPDATE turns SET status=?,updated_at=? WHERE call_id=? AND turn_id=?", (status, int(time.time()), call_id, turn_id))
        else:
            old = self._memory.get((call_id, turn_id))
            if old:
                self._memory[(call_id, turn_id)] = replace(old, status=status)

    def get_audio(self, call_id: str, turn_id: str) -> tuple[bytes, str] | None:
        if self.path:
            with self._connection() as db:
                row = db.execute("SELECT audio,audio_mime FROM turns WHERE call_id=? AND turn_id=? AND status='completed' AND playback_interrupted=0", (call_id, turn_id)).fetchone()
            return (row[0], row[1]) if row and row[0] is not None else None
        return None

    def interrupt_playback(self, call_id: str, turn_id: str) -> bool:
        if self.path:
            with self._connection() as db:
                cur = db.execute("UPDATE turns SET playback_interrupted=1,audio=NULL,audio_mime=NULL,updated_at=? WHERE call_id=? AND turn_id=?", (int(time.time()), call_id, turn_id))
            return cur.rowcount == 1
        key = (call_id, turn_id)
        if key not in self._memory:
            return False
        self._memory[key] = replace(self._memory[key], playback_interrupted=True)
        return True

    def claim_transcript_delivery(self, call_id: str, turn_id: str) -> bool:
        """Claim the bot-authored transcript side effect once before calling Telegram."""
        if self.path:
            with self._connection() as db:
                cur = db.execute("UPDATE turns SET transcript_delivery_claimed=1 WHERE call_id=? AND turn_id=? AND transcript_delivery_claimed=0", (call_id, turn_id))
            return cur.rowcount == 1
        key = (call_id, turn_id)
        if key not in self._memory or key in self._memory_transcript_claims:
            return False
        self._memory_transcript_claims.add(key)
        return True

    def fail(self, call_id: str, turn_id: str, error: str) -> None:
        if self.path:
            with self._connection() as db:
                db.execute("UPDATE turns SET status='failed',error=?,updated_at=? WHERE call_id=? AND turn_id=? AND status IN ('accepted','synthesizing')", (error[:500], int(time.time()), call_id, turn_id))
        else:
            old = self._memory.get((call_id, turn_id))
            if old:
                self._memory[(call_id, turn_id)] = replace(old, status="failed", error=error[:500])
