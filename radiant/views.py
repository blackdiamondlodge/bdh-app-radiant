"""
Views for the radiant system app.

  - radiant_view:     the single-screen page (three layouts as tabs)
  - radiant_states:   JSON snapshot of the plant, normalized from HA
  - radiant_history:  JSON 24 h trend + electrical energy since local midnight
  - radiant_setpoint: POST a zone setpoint (the page debounces these because
                      the Nest integration is rate limited)
"""

import json
import logging
from bisect import bisect_right
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

from django.http import JsonResponse
from django.shortcuts import render
from django.utils import timezone
from django.views.decorators.http import require_GET, require_POST

from bdh_sdk.ha import call_service, get_entity_states, get_history
from bdh_sdk.settings import app_setting

from . import config as cfg

logger = logging.getLogger(__name__)

UNAVAILABLE = {"unknown", "unavailable", "", None}


def _num(states, entity_id):
    s = states.get(entity_id)
    if not s or s.get("state") in UNAVAILABLE:
        return None
    try:
        return round(float(s["state"]), 2)
    except (TypeError, ValueError):
        return None


def _str(states, entity_id, default=None):
    s = states.get(entity_id)
    if not s or s.get("state") in UNAVAILABLE:
        return default
    return s["state"]


def _on(states, entity_id):
    return _str(states, entity_id) == "on"


def _season(states):
    if _on(states, cfg.AECO["heat_demand"]):
        return "heat"
    if _on(states, cfg.AECO["cool_demand"]):
        return "cool"
    mode = _str(states, cfg.AECO["climate"])
    return mode if mode in ("heat", "cool") else "off"


def _heat_pump(states, hp):
    op = _str(states, hp["operation"], "unavailable")
    if not _on(states, hp["connected"]) and hp["connected"] in states:
        op = "offline"
    power = _num(states, hp["power"]) or 0.0
    thermal = _num(states, hp["thermal"]) or 0.0
    cop = _num(states, hp["cop"])
    if cop is None and power > 0 and thermal > 0:
        cop = round(thermal / power, 2)
    running = op in cfg.HP_RUNNING_OPS or _on(states, hp["compressor"])
    # Loop supply and ΔT come from the controller (same sensors as its COP).
    # The controller reports ΔT only while its pump runs.
    supply = _num(states, hp["supply"])
    delta_t = _num(states, hp["delta_t"])
    # Inlet/outlet sensors sit outdoors, so they only read loop water while running.
    return {
        "key": hp["key"],
        "name": hp["name"],
        "op": op,
        "running": running,
        "hz": _num(states, hp["frequency"]) or 0,
        "w": power,
        "therm": thermal,
        "cop": cop,
        "inlet": _num(states, hp["inlet"]) if running else None,
        "outlet": _num(states, hp["outlet"]) if running else None,
        "flow": _num(states, hp["flow"]),
        "fault": _str(states, hp["fault"], "unknown"),
        "defrost": _on(states, hp["defrost"]),
        "sup": supply,
        "dT": delta_t,
    }


def _zone(states, z):
    climate = states.get(z["climate"]) or {}
    attrs = climate.get("attributes", {})
    mode = climate.get("state", "unavailable")
    action = attrs.get("hvac_action") or ("off" if mode == "off" else "idle")
    if mode in UNAVAILABLE:
        action = "unavailable"
    return {
        "id": z["id"],
        "name": z["name"],
        "floor": z["floor"],
        "entity": z["climate"],
        "mode": mode,
        "cur": attrs.get("current_temperature"),
        "tgt": attrs.get("temperature"),
        "low": attrs.get("target_temp_low"),
        "high": attrs.get("target_temp_high"),
        "humidity": attrs.get("current_humidity"),
        "act": action,
        "ret": _num(states, z["return"]),
        "min": attrs.get("min_temp", cfg.SETPOINT_MIN),
        "max": attrs.get("max_temp", cfg.SETPOINT_MAX),
    }


def build_state(states):
    """Normalize raw HA states into the structure the page renders."""
    return {
        "outdoor": _num(states, cfg.OUTDOOR),
        "season": _season(states),
        "vacation": _on(states, cfg.AWAY_MODE),
        "tank": _num(states, cfg.AECO["tank"]),
        "tankTarget": _num(states, cfg.AECO["tank_target"]),
        "stage1": _on(states, cfg.AECO["stage1"]),
        "stage2": _on(states, cfg.AECO["stage2"]),
        "backup": _on(states, cfg.AECO["backup"]),
        "hp": [_heat_pump(states, hp) for hp in cfg.HEAT_PUMPS],
        "backupSup": _num(states, cfg.THERMUX["backup_supply"]),
        "hpReturn": _num(states, cfg.THERMUX["hp_return"]),
        "radSupply": _num(states, cfg.THERMUX["radiant_supply"]),
        "zones": {z["id"]: _zone(states, z) for z in cfg.ZONES},
    }


def radiant_view(request):
    zones = [{k: z[k] for k in ("id", "name", "floor")} for z in cfg.ZONES]
    return render(request, "radiant/radiant.html", {
        "zones": zones,
        "debounce_ms": int(app_setting("radiant", "setpoint_debounce_s", 10, legacy=("RADIANT_SETPOINT_DEBOUNCE_S",), cast=float) * 1000),
        "setpoint_step": cfg.SETPOINT_STEP,
    })


@require_GET
def radiant_states(request):
    raw = get_entity_states(cfg.all_entity_ids())
    if not raw:
        return JsonResponse({"ok": False, "error": "Home Assistant unreachable"}, status=502)
    data = build_state(raw)
    data["ok"] = True
    data["updated"] = timezone.now().isoformat()
    return JsonResponse(data)


# ── History ──────────────────────────────────────────────────────────────

def _parse_ts(ts):
    return datetime.fromisoformat(ts.replace("Z", "+00:00"))


def _float(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def _step_sample(series, times):
    """Sample a step-wise HA history series at each time (last value at or before)."""
    if not series:
        return [None] * len(times)
    stamps = [_parse_ts(ts) for ts, _ in series]
    out = []
    for t in times:
        i = bisect_right(stamps, t) - 1
        out.append(series[i][1] if i >= 0 else None)
    return out


def energy_since(series, since):
    """kWh accumulated by a total_increasing sensor since ``since``.

    Handles meter resets: a drop is treated as a reset to zero.
    """
    total = 0.0
    prev = None
    for ts, raw in series:
        v = _float(raw)
        if v is None:
            continue
        if _parse_ts(ts) <= since:
            prev = v
            continue
        if prev is None:
            prev = v
            continue
        total += v - prev if v >= prev else v
        prev = v
    return round(total, 2)


def build_history(hist, now):
    n = cfg.HISTORY_BUCKETS
    start = now - timedelta(hours=cfg.HISTORY_HOURS)
    step = (now - start) / n
    times = [start + step * (i + 1) for i in range(n)]

    def floats(eid):
        return [_float(v) for v in _step_sample(hist.get(eid, []), times)]

    returns = [floats(z["return"]) for z in cfg.ZONES]
    avg_ret = []
    for i in range(n):
        vals = [r[i] for r in returns if r[i] is not None]
        avg_ret.append(round(sum(vals) / len(vals), 2) if vals else None)

    running = [False] * n
    for hp in cfg.HEAT_PUMPS:
        for i, op in enumerate(_step_sample(hist.get(hp["operation"], []), times)):
            if op in cfg.HP_RUNNING_OPS:
                running[i] = True

    midnight = now.astimezone(ZoneInfo(cfg.LOCAL_TZ)).replace(
        hour=0, minute=0, second=0, microsecond=0)
    energy = {hp["key"]: energy_since(hist.get(hp["energy"], []), midnight)
              for hp in cfg.HEAT_PUMPS}

    return {
        "start": start.isoformat(),
        "end": now.isoformat(),
        "tank": floats(cfg.AECO["tank"]),
        "supply": floats(cfg.THERMUX["radiant_supply"]),
        "avgReturn": avg_ret,
        "hpRunning": running,
        "energyToday": energy,
        "energyTodayTotal": round(sum(energy.values()), 2),
    }


@require_GET
def radiant_history(request):
    now = timezone.now()
    hist = get_history(cfg.history_entity_ids(),
                       now - timedelta(hours=cfg.HISTORY_HOURS), now)
    if not hist:
        return JsonResponse({"ok": False, "error": "History unavailable"}, status=502)
    data = build_history(hist, now)
    data["ok"] = True
    return JsonResponse(data)


# ── Setpoint ─────────────────────────────────────────────────────────────

@require_POST
def radiant_setpoint(request):
    """Set a zone thermostat's target temperature.

    Body: { entity_id, temperature }. The page sends only the final value
    after the user stops pressing +/- (Nest rate limiting).
    """
    try:
        body = json.loads(request.body)
    except (json.JSONDecodeError, ValueError):
        return JsonResponse({"error": "Invalid JSON"}, status=400)

    entity_id = body.get("entity_id")
    if entity_id not in cfg.ZONE_CLIMATES:
        return JsonResponse({"error": "Entity not allowed"}, status=403)

    temp = body.get("temperature")
    if isinstance(temp, bool) or not isinstance(temp, (int, float)):
        return JsonResponse({"error": "temperature must be a number"}, status=400)
    temp = round(temp / cfg.SETPOINT_STEP) * cfg.SETPOINT_STEP
    if not cfg.SETPOINT_MIN <= temp <= cfg.SETPOINT_MAX:
        return JsonResponse(
            {"error": f"temperature must be {cfg.SETPOINT_MIN}-{cfg.SETPOINT_MAX}"}, status=400)

    ok, err = call_service("climate", "set_temperature", entity_id, {"temperature": temp})
    if not ok:
        return JsonResponse({"ok": False, "error": err}, status=502)
    logger.info("Radiant: set %s to %.1f", entity_id, temp)
    return JsonResponse({"ok": True, "entity_id": entity_id, "temperature": temp})
