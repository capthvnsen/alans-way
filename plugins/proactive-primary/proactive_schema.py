"""Actual advertised schema; route bindings stay operator-only."""
ACTIONS = ["status", "pause", "resume", "configure", "review", "record_task", "finish_task", "resolve"]
TEXT = {"type": "string"}
PREFERENCES = {
    "type": "object", "additionalProperties": False,
    "properties": {
        "focus": {"type": "array", "items": TEXT, "maxItems": 20},
        "ignore": {"type": "array", "items": TEXT, "maxItems": 20},
        "max_work_minutes": {"type": "integer", "minimum": 1, "maximum": 20},
        "autonomy": {"type": "string", "enum": ["read_research_draft_continue_approved"]},
    },
}
SETTINGS = {
    "type": "object", "additionalProperties": False,
    "properties": {
        "timezone": TEXT,
        "quiet_start": {"type": "integer", "minimum": 0, "maximum": 23},
        "quiet_end": {"type": "integer", "minimum": 0, "maximum": 23},
        "max_daily_wakes": {"type": "integer", "minimum": 0, "maximum": 3},
        "max_low_purpose_wakes": {"type": "integer", "minimum": 0, "maximum": 1},
        "min_interval_seconds": {"type": "integer", "minimum": 0, "maximum": 31536000},
        "event_ttl_seconds": {"type": "integer", "minimum": 1, "maximum": 31536000},
        "max_pending": {"type": "integer", "minimum": 1, "maximum": 1024},
        "debounce_seconds": {"type": "integer", "minimum": 0, "maximum": 31536000},
        "preferences": PREFERENCES,
    },
}
TASK = {
    "type": "object", "additionalProperties": False,
    "required": ["id", "title", "scope", "next_action", "owner", "status", "approved"],
    "properties": {**{name: TEXT for name in ["id", "title", "scope", "next_action", "owner", "native_task_id",
                                             "native_board", "next_review_at", "artifact", "verification", "consent_reference"]},
                   "status": {"type": "string", "enum": ["active", "waiting", "blocked", "done", "cancelled"]},
                   "approved": {"type": "boolean", "enum": [True]},
                   "execution_host": {"type": "string", "enum": ["cloud", "mac"]}},
}
SCHEMA = {
    "name": "proactive_control",
    "description": "Read live proactivity status/preferences/tasks; persist explicit user controls or approved watch bookkeeping. Approval fields are not new consent. Binding is operator-only. Resolve only after verifying the event's real outcome.",
    "parameters": {
        "type": "object", "additionalProperties": False, "required": ["action"],
        "properties": {
            "action": {"type": "string", "enum": ACTIONS}, "settings": SETTINGS, "changes": SETTINGS,
            "task": TASK, "task_id": TEXT, "event_id": TEXT, "artifact": TEXT, "verification": TEXT,
            "status": {"type": "string", "enum": ["done", "cancelled", "waiting", "blocked"]},
        },
    },
}
