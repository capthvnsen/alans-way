"""Fixed own-profile context sources, hashed locally and bounded for review."""
from datetime import datetime, timezone
from hashlib import sha256
from pathlib import Path
import json
import os
import stat

SOURCES = ("memories/MEMORY.md", "memories/USER.md", "cron/jobs.json")


def read_source(home: Path, relative: str):
    if relative not in SOURCES:
        raise ValueError("unsupported observation source")
    path = home / relative
    try:
        if path.parent.is_symlink() or path.is_symlink():
            return None
        path.resolve(strict=True).relative_to(home.resolve(strict=True))
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
        try:
            before = os.fstat(fd)
            if not stat.S_ISREG(before.st_mode) or before.st_size > 65536 or before.st_nlink != 1:
                return None
            body = os.read(fd, 65537)
            after = os.fstat(fd)
            if (before.st_ino, before.st_size, before.st_mtime_ns) != (after.st_ino, after.st_size, after.st_mtime_ns):
                return None
        finally:
            os.close(fd)
        text = body.decode("utf-8")
        if any(ord(c) < 32 and c not in "\n\t\r" for c in text):
            return None
        return {"digest": sha256(body).hexdigest(), "text": text}
    except (OSError, UnicodeError, ValueError):
        return None


def collect(home: Path, ledger, ctx=None):
    memory, schedule, signatures = [], [], {}
    for source in SOURCES:
        value = read_source(home, source)
        if value is None:
            continue
        signatures[source] = value["digest"]
        if source.startswith("memories/"):
            memory.append({"source": Path(source).name, "text": value["text"][:3072]})
        else:
            try:
                document = json.loads(value["text"])
                jobs = document.get("jobs", []) if isinstance(document, dict) else document
                if isinstance(jobs, list):
                    for job in jobs[:12]:
                        if not isinstance(job, dict):
                            continue
                        row = {}
                        for key in ("name", "enabled", "schedule", "next_run", "status"):
                            v = job.get(key)
                            if isinstance(v, (str, bool, int, float)):
                                row[key] = v[:160] if isinstance(v, str) else v
                        if row:
                            schedule.append(row)
            except (ValueError, TypeError):
                pass
    snapshot = ledger.snapshot()
    from .proactive_native import collect as collect_native
    native = collect_native(ctx, snapshot["tasks"]) if ctx is not None else {}
    for watch_id, value in native.items():
        signatures["task:" + watch_id] = sha256(json.dumps(value, sort_keys=True).encode()).hexdigest()
    tasks = []
    now = datetime.now(timezone.utc)
    for task in snapshot["tasks"]:
        try:
            approved_at = datetime.fromisoformat(task["approved_at"])
            if (task.get("approved") is not True or task.get("status") in {"done", "cancelled"}
                    or approved_at.tzinfo is None or (now - approved_at).total_seconds() > 2592000):
                continue
        except (KeyError, ValueError, TypeError):
            continue
        allowed = {"id", "title", "scope", "next_action", "status", "owner", "approved",
                   "native_task_id", "next_review_at", "execution_host"}
        tasks.append({k: (v[:300] if isinstance(v, str) and k not in {"id", "native_task_id"} else v)
                      for k, v in task.items() if k in allowed})
        if task.get("native_task_id"):
            current = native.get(task["id"])
            if current is None or current["status"] == "blocked":
                tasks[-1]["status"] = "blocked"
            elif current["status"] in {"done", "archived"}:
                tasks[-1]["status"] = "done"
        if len(tasks) == 4:
            break
    preferences = dict(snapshot["preferences"])
    for key in ("focus", "ignore"):
        preferences[key] = [value[:100] for value in preferences[key][:8]]
    preferences["reviewed_at_utc"] = now.isoformat()
    preferences["native_task_status"] = native
    by_id = {task["id"]: task for task in snapshot["tasks"]}
    goals = [{"source": "approved-watch", "summary": task["scope"], "watch_id": task["id"],
              "approved_at": by_id[task["id"]]["approved_at"], "status": task["status"]}
             for task in tasks]
    return {"memory": memory, "schedule": schedule, "tasks": tasks,
            "preferences": preferences, "goals": goals}, signatures


def observe(runtime):
    context, signatures = collect(runtime.home, runtime.ledger, runtime.ctx)
    purposeful = bool(context["tasks"])
    counts = runtime.store.status()["counts"]
    active = any(counts.get(name, 0) for name in ("dispatching", "accepted_unverified", "uncertain"))
    admitted = 0
    with runtime.ledger.transaction() as state:
        previous = state["observations"]
        for source, digest in signatures.items():
            old = previous.get(source)
            if old is not None and old != digest and not active:
                evidence = sha256((source + ":" + digest).encode()).hexdigest()
                kind = "task_changed" if source.startswith("task:") else "context_changed"
                admitted += int(runtime.store.record_event(kind, evidence, purpose=purposeful))
            previous[source] = digest
    return admitted
