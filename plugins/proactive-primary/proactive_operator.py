"""Public plugin CLI: explicit operator binding, controls and read-only probe."""
from pathlib import Path
from types import SimpleNamespace
import json


def bind(runtime, session_key):
    """Read routing metadata only; never create or change a native session."""
    from .proactive_core import Policy
    Policy(session_key=session_key)
    if not session_key:
        raise ValueError("an existing route is required")
    index = runtime.home / "sessions" / "sessions.json"
    if not index.is_file() or index.is_symlink() or index.stat().st_size > 16777216:
        raise ValueError("unsupported routing index")
    data = json.loads(index.read_text(encoding="utf-8"))
    entry = data.get(session_key) if type(data) is dict else None
    if (type(entry) is not dict or entry.get("session_key") != session_key
            or entry.get("platform") != "telegram" or entry.get("chat_type") != "dm"
            or type(entry.get("session_id")) is not str or not entry["session_id"]
            or entry.get("suspended") is True):
        raise ValueError("bind only a verified existing direct Telegram route in this profile")
    runtime.store.update_policy({"enabled": False, "primary_profile": "default", "session_key": session_key})


def probe(runtime):
    """Operator-requested model check; no event admission or injection."""
    from .proactive_review import review, _context_json, _validate_snapshot, _has_evidence
    context = runtime.review_context()
    context = json.loads(_context_json(context))
    _validate_snapshot(context)
    known = {task["id"] for task in context["tasks"] if task["approved"] is True and task["status"] == "active"}
    counters = {"call_count": 0, "provider_completion_returned": False,
                "json_result": False, "structured_result_valid": False}
    if not _has_evidence(context, known):
        return {"ok": True, **counters, "skipped_no_evidence": True,
                "appraisal": {"useful": False, "action": "ask", "task_id": None}, "injected": False}
    class ObservedFacade:
        def complete_structured(self, **kwargs):
            counters["call_count"] += 1
            result = runtime.ctx.llm.complete_structured(**kwargs)
            counters["provider_completion_returned"] = True
            counters["json_result"] = result.content_type == "json"
            parsed = result.parsed
            counters["structured_result_valid"] = (
                counters["json_result"] and type(parsed) is dict
                and set(parsed) == {"useful", "action", "task_id"}
                and type(parsed["useful"]) is bool
                and parsed["action"] in {"research", "draft", "continue_approved", "ask", "follow_up"}
                and (parsed["task_id"] is None or (type(parsed["task_id"]) is str and parsed["task_id"] in known))
                and (parsed["useful"] is False or parsed["action"] not in {"continue_approved", "follow_up"}
                     or parsed["task_id"] is not None))
            return result
    appraisal = review(SimpleNamespace(llm=ObservedFacade()), context, "manual_review")
    return {"ok": counters["structured_result_valid"], **counters, "appraisal": appraisal,
            "injected": False}


def setup(parser):
    parser.add_argument("action", nargs="?", default="status",
                        choices=["status", "pause", "resume", "configure", "review", "bind", "probe"])
    parser.add_argument("--session-key", help="Exact existing private route; bind only, never echoed")
    parser.add_argument("--settings", help="JSON policy/preferences object for configure")


def execute(runtime, args):
    try:
        if args.action == "bind":
            bind(runtime, args.session_key)
            result = json.loads(runtime.control({"action": "status"}))
        elif args.action == "probe":
            result = probe(runtime)
        else:
            payload = {"action": args.action}
            if args.action == "configure":
                payload["settings"] = json.loads(args.settings or "{}")
            result = json.loads(runtime.control(payload))
        print(json.dumps(result, sort_keys=True))
        return 0 if result.get("ok") is True else 1
    except Exception:
        print(json.dumps({"ok": False, "error": "Operator action failed; inspect locally without exposing routing or credentials"}))
        return 1
