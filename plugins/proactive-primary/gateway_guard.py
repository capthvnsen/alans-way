"""Gateway-only arming marker; no messages or native state modification."""
from datetime import datetime, timezone
from pathlib import Path
import json
import os
import tempfile


def hermes_home() -> Path:
    """Honor the profile's explicit environment, with Hermes' default home."""
    return Path(os.environ.get("HERMES_HOME") or Path.home() / ".hermes").expanduser().absolute()


def write_private_json(path: Path, value: dict) -> None:
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    if path.parent.is_symlink() or path.is_symlink():
        raise ValueError("Companion state must not be symlinked")
    fd, temporary = tempfile.mkstemp(prefix=".proactive-", dir=path.parent)
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(value, handle, ensure_ascii=False, sort_keys=True)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def mark_gateway_ready(home: Path, *, now: datetime | None = None) -> None:
    """Called ONLY by the native gateway:startup hook in that gateway process."""
    now = now or datetime.now(timezone.utc)
    write_private_json(home / "companion" / "proactivity" / "gateway-owner.json",
                       {"pid": os.getpid(), "started_at": now.isoformat()})


def gateway_ready(home: Path, registered_at: datetime) -> bool:
    """A CLI process must never borrow another process's startup marker."""
    path = home / "companion" / "proactivity" / "gateway-owner.json"
    try:
        if path.is_symlink() or path.stat().st_size > 4096:
            return False
        value = json.loads(path.read_text(encoding="utf-8"))
        stamped = datetime.fromisoformat(value["started_at"])
        return (type(value.get("pid")) is int and value["pid"] == os.getpid()
                and stamped.tzinfo is not None and registered_at <= stamped
                and stamped <= datetime.now(timezone.utc))
    except (OSError, ValueError, KeyError, TypeError):
        return False
