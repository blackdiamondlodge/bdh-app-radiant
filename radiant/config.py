"""
Home Assistant entity map for the radiant / heat pump system.

Plant topology:
  HP1, HP2 and a backup heat source charge the buffer tank (primary loop).
  The buffer tank feeds one shared radiant supply to five Nest-controlled
  zones (secondary loop). Each zone has its own Thermux return sensor.
  The AECO-1988 (ECO-0600) controller stages the heat pumps and does the
  heat/cool changeover. The AECO tank sensor is the source of truth for the
  buffer tank. The heat pumps' own tank sensors are unreliable and are not used.
"""

OUTDOOR = "sensor.usl_environmental_temperature_3"
AWAY_MODE = "input_boolean.home_away_mode_enabled"

AECO = {
    "tank": "sensor.aeco_1988_tank_temperature",
    "tank_target": "sensor.aeco_1988_tank_target_temperature",
    "climate": "climate.aeco_1988_climate",
    "heat_demand": "switch.aeco_1988_permanent_heat_demand",
    "cool_demand": "switch.aeco_1988_permanent_cool_demand",
    "stage1": "binary_sensor.aeco_1988_hp_stage_1_running",
    "stage2": "binary_sensor.aeco_1988_hp_stage_2_running",
    "backup": "binary_sensor.aeco_1988_backup_running",
}

THERMUX = {
    "hp_return": "sensor.thermux_hp_return",
    "backup_supply": "sensor.thermux_backup_supply",
    "radiant_supply": "sensor.thermux_radiant_supply",
}


def _macon(prefix):
    base = f"mechanical_room_macon_heat_pump_controller_{prefix}"
    return {
        "operation": f"sensor.{base}_operation",
        "frequency": f"sensor.{base}_compressor_frequency",
        "power": f"sensor.{base}_power",
        "thermal": f"sensor.{base}_thermal_output",
        "cop": f"sensor.{base}_coefficient_of_performance",
        "inlet": f"sensor.{base}_inlet_temperature",
        "outlet": f"sensor.{base}_outlet_temperature",
        "fault": f"sensor.{base}_fault_code",
        "defrost": f"binary_sensor.{base}_defrosting",
        "compressor": f"binary_sensor.{base}_compressor",
        "connected": f"binary_sensor.{base}_heat_pump_connected",
    }


HEAT_PUMPS = [
    {
        "key": "hp1",
        "name": "Heat Pump 1",
        **_macon("fcec_hp_1"),
        "supply": "sensor.thermux_hp_1_supply",
        "delta_t": "sensor.hp_1_delta_t",
        "flow": "sensor.mechanical_room_arctic_heatpump_1_loop_flow",
        "energy": "sensor.mechanical_room_arctic_heatpump_1_electrical_energy",
    },
    {
        "key": "hp2",
        "name": "Heat Pump 2",
        **_macon("e540_hp_2"),
        "supply": "sensor.thermux_hp_2_supply",
        "delta_t": "sensor.hp_2_delta_t",
        "flow": "sensor.mechanical_room_arctic_heatpump_2_loop_flow",
        "energy": "sensor.mechanical_room_arctic_heatpump_2_electrical_energy",
    },
]

# Order here is the display order. "floor" drives the house-section layout.
ZONES = [
    {"id": "master_bedroom", "name": "Master Bedroom", "floor": "upper",
     "climate": "climate.master_bedroom", "return": "sensor.thermux_master_return"},
    {"id": "main_floor", "name": "Main Floor", "floor": "main",
     "climate": "climate.main_floor", "return": "sensor.thermux_main_floor_return"},
    {"id": "ski_room", "name": "Ski Room", "floor": "main",
     "climate": "climate.ski_room", "return": "sensor.thermux_ski_room_return"},
    {"id": "basement_master", "name": "Basement Master", "floor": "basement",
     "climate": "climate.basement_master", "return": "sensor.thermux_basement_master_return_ada"},
    {"id": "basement_bunk_rooms", "name": "Basement + Bunks", "floor": "basement",
     "climate": "climate.basement_bunk_rooms", "return": "sensor.thermux_basement_return"},
]

ZONE_CLIMATES = {z["climate"] for z in ZONES}

# Setpoint guard rails (Nest reports 10-32 °C). Values are rounded to this step.
SETPOINT_MIN = 10.0
SETPOINT_MAX = 32.0
SETPOINT_STEP = 0.5

# HP operation states that count as "running".
HP_RUNNING_OPS = {"heating", "cooling", "defrost", "hot_water"}

# The lodge is in Sun Peaks, BC. Used for "energy today" (since local midnight).
LOCAL_TZ = "America/Vancouver"

# Trend chart: 24 h in 15-minute buckets.
HISTORY_HOURS = 24
HISTORY_BUCKETS = 96


def all_entity_ids():
    ids = {OUTDOOR, AWAY_MODE, *AECO.values(), *THERMUX.values()}
    for hp in HEAT_PUMPS:
        ids.update(v for k, v in hp.items() if k not in ("key", "name"))
    for z in ZONES:
        ids.update((z["climate"], z["return"]))
    return sorted(ids)


def history_entity_ids():
    """Entities pulled for the 24 h trend + energy-today calculation."""
    return [
        AECO["tank"],
        THERMUX["radiant_supply"],
        *(z["return"] for z in ZONES),
        *(hp["operation"] for hp in HEAT_PUMPS),
        *(hp["energy"] for hp in HEAT_PUMPS),
    ]
