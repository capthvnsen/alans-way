"""Native gateway event hook; placement is an explicit opt-in, not a sandbox."""
from pathlib import Path
import importlib.util
import os


def handle(event_type, context, *, home=None):
    if event_type != "gateway:startup":
        return
    source_home = Path(__file__).resolve().parents[2]
    target_home = Path(home) if home is not None else source_home
    actual_home = Path(os.environ.get("HERMES_HOME") or Path.home() / ".hermes").expanduser().absolute()
    if home is None and target_home.absolute() != actual_home:
        return
    path = source_home / "plugins/proactive-primary/gateway_guard.py"
    if not path.is_file() or path.is_symlink():
        return
    spec = importlib.util.spec_from_file_location("companion_gateway_guard_hook", path)
    if spec is None or spec.loader is None:
        return
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    module.mark_gateway_ready(target_home)
