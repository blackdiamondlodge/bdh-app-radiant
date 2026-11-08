from bdh_sdk.ha import get_entity_states
from bdh_sdk import INFO, ON, WARN, Status

from . import config as cfg
from .views import build_state

ACTIVE_ACTIONS = {"heating", "cooling"}


def status():
    raw = get_entity_states(cfg.all_entity_ids())
    if not raw:
        raise RuntimeError("Home Assistant unreachable")
    state = build_state(raw)
    zones = list(state["zones"].values())
    calling = sum(1 for z in zones if z["act"] in ACTIVE_ACTIONS)
    if any(hp["op"] == "offline" for hp in state["hp"]):
        return Status("Heat pump offline", WARN)
    if state["vacation"]:
        return Status("Away mode", INFO)
    if calling:
        verb = "cooling" if state["season"] == "cool" else "heating"
        return Status(f"{calling} of {len(zones)} zones {verb}", ON)
    return Status("All zones at temperature", INFO)
