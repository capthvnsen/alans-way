"""Durable, metadata-only admission and dispatch decisions for the companion.

There is no agent loop, Hermes import, native-state access, network access or
message delivery here. Trusted local callers supply opaque event ids; this
module cannot establish their provenance or verify that a route exists.
"""
from __future__ import annotations

from contextlib import contextmanager
from dataclasses import asdict, dataclass, fields
from datetime import datetime, timedelta, timezone
from hashlib import sha256
import json
import os
from pathlib import Path
import re
import sqlite3
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError


@dataclass(frozen=True)
class Policy:
    """Immutable settings; unknown keys and coercions are rejected.

    Caps can be lowered, never raised above three total/one low-purpose wake.
    Equal quiet-hour endpoints disable the quiet window. Integer durations
    are bounded to one year and queues to 1024 to reject unreasonable inputs.
    A nonempty session_key must identify a route validated by the adapter.
    """

    enabled: bool = False
    primary_profile: str = "default"
    session_key: str = ""
    timezone: str = "America/Denver"
    quiet_start: int = 22
    quiet_end: int = 8
    max_daily_wakes: int = 3
    max_low_purpose_wakes: int = 1
    min_interval_seconds: int = 7200
    event_ttl_seconds: int = 259200
    max_pending: int = 64
    debounce_seconds: int = 120

    def __post_init__(self) -> None:
        if type(self.enabled) is not bool:
            raise ValueError("enabled must be a boolean")
        if self.primary_profile != "default":
            raise ValueError("only the default primary profile is supported")
        if (type(self.session_key) is not str or len(self.session_key) > 1024
                or any(ord(c) < 33 or ord(c) == 127 for c in self.session_key)):
            raise ValueError("session_key must be an opaque existing route")
        if type(self.timezone) is not str:
            raise ValueError("timezone must be an IANA timezone")
        try:
            ZoneInfo(self.timezone)
        except (ValueError, ZoneInfoNotFoundError) as exc:
            raise ValueError("timezone must be an available IANA timezone") from exc
        bounds = {
            "quiet_start": (0, 23), "quiet_end": (0, 23),
            "max_daily_wakes": (0, 3), "max_low_purpose_wakes": (0, 1),
            "min_interval_seconds": (0, 31536000),
            "event_ttl_seconds": (1, 31536000),
            "max_pending": (1, 1024), "debounce_seconds": (0, 31536000),
        }
        for name, (low, high) in bounds.items():
            value = getattr(self, name)
            if type(value) is not int or not low <= value <= high:
                raise ValueError(f"{name} must be an integer in [{low}, {high}]")

    @classmethod
    def from_dict(cls, settings: dict) -> Policy:
        if type(settings) is not dict or set(settings) - {f.name for f in fields(cls)}:
            raise ValueError("policy must be a dictionary of known settings")
        return cls(**settings)

    def to_dict(self) -> dict:
        return asdict(self)


class Store:
    """Companion-owned SQLite state; policy is never cached between calls.

    Claims commit their reservation before returning and are never retried.
    Reopening conservatively marks all unfinished dispatches uncertain,
    including those owned by another still-live Store; late explicit receipts
    may finish them, but cannot requeue them. Rejected/expired/dropped ids are
    retained too. At 4096 unique admitted events, new admissions stop rather
    than evicting tombstones and making old uncertain events retryable.
    Audit history is capped at 256 metadata-only entries.
    """

    # Never evict dedupe/uncertain records: saturation stops new admissions.
    _MAX_EVENTS = 4096

    def __init__(self, state_dir: Path):
        self.state_dir = Path(state_dir)
        self.state_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        self._db_path = self.state_dir / "proactivity.sqlite3"
        descriptor = os.open(self._db_path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        try:
            os.fchmod(descriptor, 0o600)
        finally:
            os.close(descriptor)
        with self._transaction() as db:
            db.execute("CREATE TABLE IF NOT EXISTS policy (singleton INTEGER PRIMARY KEY CHECK(singleton=1), settings TEXT NOT NULL, revision INTEGER NOT NULL)")
            db.execute("INSERT OR IGNORE INTO policy VALUES (1, ?, 0)", (json.dumps(Policy().to_dict()),))
            db.execute("""CREATE TABLE IF NOT EXISTS events (
                sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL,
                kind TEXT NOT NULL, evidence TEXT NOT NULL, purpose INTEGER NOT NULL,
                session_key TEXT NOT NULL, created_at REAL NOT NULL,
                policy_revision INTEGER NOT NULL, status TEXT NOT NULL,
                claimed_at REAL)""")
            db.execute("""CREATE TABLE IF NOT EXISTS audit (
                sequence INTEGER PRIMARY KEY AUTOINCREMENT, action TEXT NOT NULL,
                policy_revision INTEGER NOT NULL, count INTEGER NOT NULL)""")
            recovered = db.execute("UPDATE events SET status='uncertain' WHERE status='dispatching'").rowcount
            self._audit(db, "uncertain", self._policy(db)[1], recovered)

    @contextmanager
    def _transaction(self):
        db = sqlite3.connect(self._db_path, timeout=30, isolation_level=None)
        db.row_factory = sqlite3.Row
        try:
            db.execute("BEGIN IMMEDIATE")
            yield db
            db.commit()
        except BaseException:
            db.rollback()
            raise
        finally:
            db.close()

    @staticmethod
    def _audit(db, action: str, revision: int, count: int = 1) -> None:
        if count <= 0:
            return
        db.execute("INSERT INTO audit (action,policy_revision,count) VALUES (?,?,?)", (action, revision, count))
        db.execute("DELETE FROM audit WHERE sequence NOT IN (SELECT sequence FROM audit ORDER BY sequence DESC LIMIT 256)")

    def _expire(self, db, timestamp: float, policy: Policy, revision: int) -> None:
        expired = db.execute("UPDATE events SET status='expired' WHERE status='pending' AND created_at<=?", (timestamp - policy.event_ttl_seconds,)).rowcount
        self._audit(db, "expired", revision, expired)

    @staticmethod
    def _policy(db, *, strict: bool = False):
        row = db.execute("SELECT settings, revision FROM policy WHERE singleton=1").fetchone()
        revision = row["revision"] if row is not None and type(row["revision"]) is int and row["revision"] >= 0 else 0
        try:
            if row is None or row["revision"] != revision:
                raise ValueError("invalid persisted policy revision")
            settings = json.loads(row["settings"])
            if type(settings) is not dict or set(settings) != {f.name for f in fields(Policy)}:
                raise ValueError("persisted policy must contain all settings")
            return Policy.from_dict(settings), revision
        except (ValueError, TypeError, UnicodeError) as exc:
            if strict:
                raise ValueError("invalid persisted policy; explicit local repair required") from exc
            return Policy(), revision

    def load_policy(self) -> Policy:
        with self._transaction() as db:
            return self._policy(db)[0]

    def update_policy(self, changes: dict) -> Policy:
        if type(changes) is not dict:
            raise ValueError("changes must be a dictionary")
        with self._transaction() as db:
            old, revision = self._policy(db, strict=True)
            settings = old.to_dict()
            settings.update(changes)
            new = Policy.from_dict(settings)
            if new != old:
                if new.session_key != old.session_key:
                    dropped = db.execute("UPDATE events SET status='dropped' WHERE status='pending'").rowcount
                    self._audit(db, "route_dropped", revision + 1, dropped)
                dropped = db.execute("""UPDATE events SET status='dropped' WHERE sequence IN (
                    SELECT sequence FROM events WHERE status='pending' ORDER BY purpose DESC,
                    CASE kind WHEN 'manual_review' THEN 0 WHEN 'task_changed' THEN 1
                    WHEN 'worker_update' THEN 2 ELSE 3 END, created_at, sequence LIMIT -1 OFFSET ?)""", (new.max_pending,)).rowcount
                self._audit(db, "queue_dropped", revision + 1, dropped)
                db.execute("UPDATE policy SET settings=?, revision=? WHERE singleton=1", (json.dumps(new.to_dict()), revision + 1))
                self._audit(db, "policy_changed", revision + 1)
            return new

    @staticmethod
    def _timestamp(now: datetime | None) -> float:
        value = now if now is not None else datetime.now(timezone.utc)
        if not isinstance(value, datetime) or value.tzinfo is None or value.utcoffset() is None:
            raise ValueError("now must be an aware datetime")
        return value.timestamp()

    def record_event(self, kind: str, evidence: str, *, purpose: bool = False,
                     now: datetime | None = None) -> bool:
        """Admit an opaque id (ASCII alphanumerics plus ``_.:-``, max 256).

        Paused but bound stores may collect events. Duplicates, invalid
        metadata, unbound/corrupt policy or capacity exhaustion return False;
        a non-aware clock is a caller error and raises ValueError.
        """
        timestamp = self._timestamp(now)
        if (type(kind) is not str or kind not in {"task_changed", "worker_update", "context_changed", "manual_review"}
                or type(evidence) is not str or re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}", evidence) is None
                or type(purpose) is not bool):
            return False
        with self._transaction() as db:
            policy, revision = self._policy(db)
            if not policy.session_key:
                return False
            self._expire(db, timestamp, policy, revision)
            if db.execute("SELECT COUNT(*) FROM events WHERE status='pending'").fetchone()[0] >= policy.max_pending:
                return False
            if db.execute("SELECT COUNT(*) FROM events").fetchone()[0] >= self._MAX_EVENTS:
                return False
            event_id = sha256(json.dumps([policy.session_key, kind, evidence], separators=(",", ":")).encode()).hexdigest()
            cursor = db.execute("""INSERT OR IGNORE INTO events
                (id,kind,evidence,purpose,session_key,created_at,policy_revision,status)
                VALUES (?,?,?,?,?,?,?,'pending')""",
                (event_id, kind, evidence, purpose, policy.session_key, timestamp, revision))
            self._audit(db, "admitted", revision, cursor.rowcount)
            return cursor.rowcount == 1

    def claim(self, now: datetime | None = None) -> dict | None:
        """Reserve one eligible existing event, or do nothing.

        Purpose wins, followed by manual_review, task_changed, worker_update,
        context_changed, then oldest admission. Daily/spacing reservations
        apply across route changes and every finish status; none are refunded.
        Quiet hours and local calendar-day boundaries use real IANA offsets.
        """
        timestamp = self._timestamp(now)
        with self._transaction() as db:
            policy, revision = self._policy(db)
            if not policy.enabled or not policy.session_key:
                return None
            self._expire(db, timestamp, policy, revision)
            hour = datetime.fromtimestamp(timestamp, ZoneInfo(policy.timezone)).hour
            if policy.quiet_start <= policy.quiet_end:
                quiet = policy.quiet_start <= hour < policy.quiet_end
            else:
                quiet = hour >= policy.quiet_start or hour < policy.quiet_end
            if quiet:
                return None
            last_claim = db.execute("SELECT MAX(claimed_at) FROM events").fetchone()[0]
            if last_claim is not None and timestamp - last_claim < policy.min_interval_seconds:
                return None
            local = datetime.fromtimestamp(timestamp, ZoneInfo(policy.timezone))
            midnight = local.replace(hour=0, minute=0, second=0, microsecond=0)
            next_midnight = midnight + timedelta(days=1)
            budget = db.execute("""SELECT COUNT(*) AS total, COALESCE(SUM(purpose=0),0) AS low
                FROM events WHERE claimed_at>=? AND claimed_at<?""",
                (midnight.timestamp(), next_midnight.timestamp())).fetchone()
            if budget["total"] >= policy.max_daily_wakes:
                return None
            allow_low = budget["low"] < policy.max_low_purpose_wakes
            event = db.execute("""SELECT * FROM events WHERE status='pending' AND created_at<=?
                AND (purpose=1 OR ?)
                ORDER BY purpose DESC, CASE kind WHEN 'manual_review' THEN 0
                WHEN 'task_changed' THEN 1 WHEN 'worker_update' THEN 2 ELSE 3 END,
                created_at, sequence LIMIT 1""", (timestamp - policy.debounce_seconds, allow_low)).fetchone()
            if event is None:
                return None
            db.execute("UPDATE events SET status='dispatching', claimed_at=? WHERE id=?", (timestamp, event["id"]))
            self._audit(db, "claimed", revision)
            return {"id": event["id"], "kind": event["kind"], "evidence": event["evidence"],
                    "purpose": bool(event["purpose"]), "session_key": event["session_key"],
                    "policy_revision": revision}

    def finish(self, event_id: str, status: str) -> None:
        """Record a caller's explicit outcome, not an injection return value.

        Only the adapter can inspect injection acceptance (it must be ``is True``).
        An accepted queue request is never proof that the review completed.
        """
        allowed = {"accepted_unverified", "rejected", "uncertain", "resolved"}
        if type(event_id) is not str or type(status) is not str or status not in allowed:
            raise ValueError("finish requires an event id and an explicit allowed status")
        with self._transaction() as db:
            event = db.execute("SELECT status FROM events WHERE id=?", (event_id,)).fetchone()
            if event is None:
                raise ValueError("unknown event")
            old = event["status"]
            if old == status:
                return
            if old not in {"dispatching", "uncertain"} and not (old == "accepted_unverified" and status == "resolved"):
                raise ValueError("invalid dispatch status transition")
            db.execute("UPDATE events SET status=? WHERE id=?", (status, event_id))
            self._audit(db, status, self._policy(db)[1])

    def status(self) -> dict:
        with self._transaction() as db:
            policy, revision = self._policy(db)
            try:
                self._policy(db, strict=True)
                policy_valid = True
            except ValueError:
                policy_valid = False
            counts = {row["status"]: row["n"] for row in db.execute("SELECT status,COUNT(*) AS n FROM events GROUP BY status")}
            reservations = db.execute("SELECT COUNT(*) FROM events WHERE claimed_at IS NOT NULL").fetchone()[0]
            metadata = policy.to_dict()
            metadata.pop("session_key")
            audit = [dict(row) for row in db.execute("SELECT sequence,action,policy_revision,count FROM audit ORDER BY sequence")]
            return {"enabled": policy.enabled, "policy_revision": revision,
                    "policy_valid": policy_valid,
                    "storage_full": sum(counts.values()) >= self._MAX_EVENTS,
                    "route_bound": bool(policy.session_key), "policy": metadata,
                    "counts": counts, "reservation_count": reservations, "audit": audit}
