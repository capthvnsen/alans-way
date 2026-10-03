"""Private preferences and authorized task watches, not a task executor."""
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
import copy
import fcntl
import json
import os
import re

from .gateway_guard import write_private_json

DEFAULT_PREFERENCES = {
    "focus": [], "ignore": [], "max_work_minutes": 20,
    "autonomy": "read_research_draft_continue_approved",
}
TASK_FIELDS = {"id", "title", "scope", "next_action", "owner", "status", "approved",
               "native_task_id", "native_board", "next_review_at", "artifact", "verification",
               "consent_reference", "execution_host"}


def _text(value, maximum=2000):
    if not isinstance(value, str) or not value or len(value) > maximum or any(ord(c) < 32 and c not in "\n\t" for c in value):
        raise ValueError("invalid task text")
    return value


class Ledger:
    def __init__(self, state_dir: Path):
        self.root = Path(state_dir)
        self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.path = self.root / "ledger.json"

    @contextmanager
    def transaction(self):
        if self.root.is_symlink() or self.path.is_symlink():
            raise ValueError("symlinked state is unsupported")
        fd = os.open(self.root / "ledger.lock", os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX)
            if self.path.exists():
                if self.path.stat().st_size > 1048576:
                    raise ValueError("ledger exceeds bound")
                data = json.loads(self.path.read_text(encoding="utf-8"))
                if not isinstance(data, dict) or data.get("schema") != 1:
                    raise ValueError("unsupported ledger")
            else:
                data = {"schema": 1, "preferences": copy.deepcopy(DEFAULT_PREFERENCES), "tasks": {}, "observations": {}}
            before = copy.deepcopy(data)
            yield data
            if data != before:
                write_private_json(self.path, data)
        finally:
            fcntl.flock(fd, fcntl.LOCK_UN)
            os.close(fd)

    def snapshot(self):
        with self.transaction() as data:
            return {"preferences": copy.deepcopy(data["preferences"]),
                    "tasks": copy.deepcopy(list(data["tasks"].values()))}

    def preferences(self, changes):
        if not isinstance(changes, dict) or set(changes) - set(DEFAULT_PREFERENCES):
            raise ValueError("unsupported preferences")
        with self.transaction() as data:
            proposed = {**data["preferences"], **changes}
            for name in ("focus", "ignore"):
                if not isinstance(proposed[name], list) or len(proposed[name]) > 20:
                    raise ValueError("invalid preferences")
                for item in proposed[name]:
                    _text(item, 300)
            if (type(proposed["max_work_minutes"]) is not int or not 1 <= proposed["max_work_minutes"] <= 20
                    or proposed["autonomy"] != DEFAULT_PREFERENCES["autonomy"]):
                raise ValueError("autonomy cannot be expanded by preferences")
            data["preferences"] = proposed

    def record_task(self, task):
        if not isinstance(task, dict) or set(task) - TASK_FIELDS or task.get("approved") is not True:
            raise ValueError("record only explicitly authorized scope")
        if re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,79}", task.get("id", "")) is None:
            raise ValueError("invalid watch id")
        for name in ("title", "scope", "next_action", "owner"):
            _text(task.get(name), 300 if name in ("title", "owner") else 2000)
        if task.get("status") not in {"active", "waiting", "blocked", "done", "cancelled"}:
            raise ValueError("unsupported task status")
        if task.get("execution_host", "cloud") not in {"cloud", "mac"}:
            raise ValueError("unsupported execution host")
        for name in ("native_task_id", "native_board", "artifact", "verification", "consent_reference"):
            if name in task:
                _text(task[name], 1000)
        if task.get("next_review_at"):
            moment = datetime.fromisoformat(task["next_review_at"])
            if moment.tzinfo is None:
                raise ValueError("review time needs timezone")
        with self.transaction() as data:
            old = data["tasks"].get(task["id"])
            if old and (old["status"] in {"done", "cancelled"} or old["scope"] != task["scope"]
                        or old.get("execution_host", "cloud") != task.get("execution_host", old.get("execution_host", "cloud"))):
                raise ValueError("terminal, changed scopes or changed execution hosts need a new authorized watch id")
            if old is None and len(data["tasks"]) >= 64:
                raise ValueError("watch limit reached")
            saved = copy.deepcopy(task)
            saved["execution_host"] = task.get("execution_host", old.get("execution_host", "cloud") if old else "cloud")
            saved["approved_at"] = old["approved_at"] if old else datetime.now(timezone.utc).isoformat()
            data["tasks"][task["id"]] = saved

    def finish_task(self, task_id, status, *, artifact=None, verification=None):
        if status not in {"done", "cancelled", "waiting", "blocked"}:
            raise ValueError("invalid final status")
        with self.transaction() as data:
            task = data["tasks"].get(task_id)
            if not task or task["status"] in {"done", "cancelled"}:
                raise ValueError("unknown or terminal watch")
            for name, value in (("artifact", artifact), ("verification", verification)):
                if value is not None:
                    task[name] = _text(value, 1000)
            task["status"] = status
