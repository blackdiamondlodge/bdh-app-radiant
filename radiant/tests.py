import json
from datetime import datetime, timedelta, timezone as dt_tz
from unittest.mock import patch

from django.contrib.staticfiles.testing import StaticLiveServerTestCase
from django.test import TestCase, override_settings, tag
from django.urls import reverse

from . import config as cfg
from .views import build_history, build_state, energy_since


def _s(entity_id, state, **attrs):
    return {"entity_id": entity_id, "state": str(state), "attributes": attrs}


def make_states(**overrides):
    """A plausible HA snapshot: heating, HP1 running, main floor calling."""
    hp1, hp2 = cfg.HEAT_PUMPS
    items = [
        _s(cfg.OUTDOOR, "-7.5"),
        _s(cfg.AWAY_MODE, "off"),
        _s(cfg.AECO["tank"], "38.61111"),
        _s(cfg.AECO["tank_target"], "40.0"),
        _s(cfg.AECO["heat_demand"], "on"),
        _s(cfg.AECO["cool_demand"], "off"),
        _s(cfg.AECO["stage1"], "on"),
        _s(cfg.AECO["stage2"], "off"),
        _s(cfg.AECO["backup"], "off"),
        _s(cfg.THERMUX["radiant_supply"], "37.9"),
        _s(cfg.THERMUX["hp_return"], "33.0"),
        _s(cfg.THERMUX["backup_supply"], "22.0"),
        _s(hp1["operation"], "heating"), _s(hp1["power"], "2350"), _s(hp1["thermal"], "7900"),
        _s(hp1["cop"], "unknown"), _s(hp1["connected"], "on"), _s(hp1["frequency"], "62"),
        _s(hp1["fault"], "ok"), _s(hp1["supply"], "43.1"), _s(hp1["delta_t"], "8.3"),
        _s(hp1["inlet"], "33.2"), _s(hp1["outlet"], "41.0"),
        _s(hp2["operation"], "idle"), _s(hp2["power"], "0"), _s(hp2["thermal"], "0"),
        _s(hp2["supply"], "22.8"), _s(hp2["delta_t"], "unknown"),
        _s(hp2["inlet"], "-6.0"), _s(hp2["outlet"], "-5.5"),
        _s(hp2["connected"], "off"), _s(hp2["fault"], "ok"),
        # HP tank sensors are deliberately present but must never be used.
        _s("sensor.mechanical_room_macon_heat_pump_controller_fcec_hp_1_tank_temperature", "99"),
    ]
    for z in cfg.ZONES:
        items.append(_s(z["climate"], "heat", current_temperature=19.0, temperature=20.0,
                        hvac_action="idle", min_temp=10, max_temp=32))
        items.append(_s(z["return"], "25.0"))
    states = {i["entity_id"]: i for i in items}
    states["climate.main_floor"]["attributes"]["hvac_action"] = "heating"
    states.update(overrides)
    return states


class BuildStateTests(TestCase):
    def test_tank_comes_from_aeco(self):
        data = build_state(make_states())
        self.assertEqual(data["tank"], 38.61)
        self.assertEqual(data["tankTarget"], 40.0)

    def test_season_and_stages(self):
        data = build_state(make_states())
        self.assertEqual(data["season"], "heat")
        self.assertTrue(data["stage1"])
        self.assertFalse(data["backup"])
        cool = build_state(make_states(**{
            cfg.AECO["heat_demand"]: _s(cfg.AECO["heat_demand"], "off"),
            cfg.AECO["cool_demand"]: _s(cfg.AECO["cool_demand"], "on"),
        }))
        self.assertEqual(cool["season"], "cool")

    def test_heat_pumps(self):
        hp1, hp2 = build_state(make_states())["hp"]
        self.assertTrue(hp1["running"])
        self.assertEqual(hp1["cop"], round(7900 / 2350, 2))  # derived when sensor unknown
        self.assertFalse(hp2["running"])
        self.assertEqual(hp2["op"], "offline")

    def test_inlet_outlet_hidden_when_idle(self):
        hp1, hp2 = build_state(make_states())["hp"]
        self.assertEqual((hp1["inlet"], hp1["outlet"]), (33.2, 41.0))
        self.assertEqual((hp2["inlet"], hp2["outlet"]), (None, None))

    def test_supply_and_delta_t_from_controller(self):
        hp1, hp2 = build_state(make_states())["hp"]
        self.assertEqual((hp1["sup"], hp1["dT"]), (43.1, 8.3))
        self.assertEqual(hp2["sup"], 22.8)  # supply still shown while idle
        self.assertIsNone(hp2["dT"])  # controller sends no ΔT with the pump off

    def test_zones(self):
        zones = build_state(make_states())["zones"]
        self.assertEqual(list(zones), [z["id"] for z in cfg.ZONES])
        self.assertEqual(zones["main_floor"]["act"], "heating")
        self.assertEqual(zones["ski_room"]["act"], "idle")
        self.assertEqual(zones["ski_room"]["ret"], 25.0)
        self.assertEqual(zones["ski_room"]["floor"], "main")

    def test_unavailable_values_are_none(self):
        data = build_state(make_states(**{
            cfg.AECO["tank"]: _s(cfg.AECO["tank"], "unavailable"),
            "climate.ski_room": _s("climate.ski_room", "unavailable"),
        }))
        self.assertIsNone(data["tank"])
        self.assertEqual(data["zones"]["ski_room"]["act"], "unavailable")


class HistoryTests(TestCase):
    def test_energy_since_handles_reset(self):
        since = datetime(2026, 1, 1, 8, tzinfo=dt_tz.utc)
        series = [
            ("2026-01-01T07:00:00+00:00", "10.0"),   # before since -> baseline
            ("2026-01-01T09:00:00+00:00", "11.5"),   # +1.5
            ("2026-01-01T10:00:00+00:00", "unknown"),
            ("2026-01-01T11:00:00+00:00", "0.4"),    # reset -> +0.4
            ("2026-01-01T12:00:00+00:00", "1.0"),    # +0.6
        ]
        self.assertEqual(energy_since(series, since), 2.5)

    def test_build_history_resamples(self):
        now = datetime(2026, 1, 2, 20, tzinfo=dt_tz.utc)
        start = now - timedelta(hours=24)
        hp1 = cfg.HEAT_PUMPS[0]
        hist = {
            cfg.AECO["tank"]: [(start.isoformat(), "30"), ((now - timedelta(hours=1)).isoformat(), "40")],
            hp1["operation"]: [(start.isoformat(), "idle"),
                               ((now - timedelta(minutes=20)).isoformat(), "heating")],
            cfg.ZONES[0]["return"]: [(start.isoformat(), "20")],
            cfg.ZONES[1]["return"]: [(start.isoformat(), "24")],
        }
        h = build_history(hist, now)
        self.assertEqual(len(h["tank"]), cfg.HISTORY_BUCKETS)
        self.assertEqual(h["tank"][0], 30.0)
        self.assertEqual(h["tank"][-1], 40.0)
        self.assertEqual(h["avgReturn"][-1], 22.0)
        self.assertEqual(h["hpRunning"][-1], True)
        self.assertEqual(h["hpRunning"][0], False)
        self.assertIsNone(h["supply"][0])


class ViewTests(TestCase):
    def test_page_renders(self):
        resp = self.client.get(reverse("radiant"))
        self.assertEqual(resp.status_code, 200)
        self.assertContains(resp, "Mechanical room")
        self.assertContains(resp, 'data-debounce-ms="10000"')

    def test_landing_page_links_to_radiant(self):
        resp = self.client.get(reverse("landing_page"))
        self.assertContains(resp, reverse("radiant"))

    @patch("radiant.views.get_entity_states", return_value={})
    def test_states_ha_down(self, _):
        resp = self.client.get(reverse("radiant_states"))
        self.assertEqual(resp.status_code, 502)
        self.assertFalse(resp.json()["ok"])

    @patch("radiant.views.get_entity_states")
    def test_states_ok(self, mock_states):
        mock_states.return_value = make_states()
        resp = self.client.get(reverse("radiant_states"))
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.json()["tank"], 38.61)


class SetpointTests(TestCase):
    url = reverse("radiant_setpoint")

    def post(self, body):
        return self.client.post(self.url, json.dumps(body), content_type="application/json")

    @patch("radiant.views.call_service", return_value=(True, None))
    def test_sets_temperature_rounded_to_step(self, mock_call):
        resp = self.post({"entity_id": "climate.main_floor", "temperature": 20.6})
        self.assertEqual(resp.status_code, 200)
        mock_call.assert_called_once_with(
            "climate", "set_temperature", "climate.main_floor", {"temperature": 20.5})

    @patch("radiant.views.call_service")
    def test_rejects_unknown_entity(self, mock_call):
        resp = self.post({"entity_id": "climate.garage_thermostat_thermostat", "temperature": 20})
        self.assertEqual(resp.status_code, 403)
        mock_call.assert_not_called()

    @patch("radiant.views.call_service")
    def test_rejects_bad_temperature(self, mock_call):
        for bad in ("20", None, True, 5, 40):
            resp = self.post({"entity_id": "climate.main_floor", "temperature": bad})
            self.assertEqual(resp.status_code, 400, bad)
        mock_call.assert_not_called()

    @patch("radiant.views.call_service", return_value=(False, "HA returned 500"))
    def test_ha_failure(self, _):
        resp = self.post({"entity_id": "climate.main_floor", "temperature": 20})
        self.assertEqual(resp.status_code, 502)

    def test_get_not_allowed(self):
        self.assertEqual(self.client.get(self.url).status_code, 405)


class RadiantDebounceSettingTests(TestCase):
    def test_debounce_from_env(self):
        with patch.dict("os.environ", {"BDH_RADIANT_SETPOINT_DEBOUNCE_S": "2.5"}):
            resp = self.client.get(reverse("radiant"))
        self.assertEqual(resp.context["debounce_ms"], 2500)


@tag('selenium')
@override_settings(RADIANT_SETPOINT_DEBOUNCE_S=1.5)
class RadiantBrowserTests(StaticLiveServerTestCase):
    """Fits the 1920x1080 hub screen and debounces Nest setpoint changes."""

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        from selenium import webdriver
        from tests.selenium_helpers import get_chrome_options
        cls.browser = webdriver.Chrome(options=get_chrome_options())
        cls.browser.execute_cdp_cmd('Emulation.setDeviceMetricsOverride', {
            'width': 1920, 'height': 1080, 'deviceScaleFactor': 1, 'mobile': False,
        })

    @classmethod
    def tearDownClass(cls):
        cls.browser.quit()
        super().tearDownClass()

    def setUp(self):
        patches = [
            patch("radiant.views.get_entity_states", return_value=make_states()),
            patch("radiant.views.get_history", return_value={}),
        ]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)
        self.call_service = patch("radiant.views.call_service", return_value=(True, None)).start()
        self.addCleanup(patch.stopall)

    def _open(self, layout):
        from selenium.webdriver.common.by import By
        from selenium.webdriver.support.ui import WebDriverWait
        from selenium.webdriver.support import expected_conditions as EC
        self.browser.get(f"{self.live_server_url}{reverse('radiant')}?layout={layout}")
        WebDriverWait(self.browser, 10).until(
            EC.visibility_of_element_located((By.ID, f"rad-view{layout}")))

    def _click(self, zone, d):
        from selenium.webdriver.common.by import By
        self.browser.find_element(
            By.CSS_SELECTOR, f'#rad-viewB [data-bump="{zone}"][data-d="{d}"]').click()

    def test_every_layout_fits_without_scrolling(self):
        for layout in ("A", "B", "C"):
            self._open(layout)
            overflow = self.browser.execute_script(
                "return document.documentElement.scrollHeight - window.innerHeight;")
            self.assertLessEqual(overflow, 0, f"layout {layout} overflows by {overflow}px")

    def test_setpoint_debounced_to_single_call(self):
        import time
        self._open("B")
        for _ in range(3):
            self._click("main_floor", 1)
        time.sleep(0.7)
        self._click("main_floor", 1)   # restarts the debounce window
        time.sleep(1.0)
        self.call_service.assert_not_called()
        deadline = time.time() + 5
        while not self.call_service.called and time.time() < deadline:
            time.sleep(0.1)
        self.call_service.assert_called_once_with(
            "climate", "set_temperature", "climate.main_floor", {"temperature": 22.0})

    def test_returning_to_current_setpoint_sends_nothing(self):
        import time
        self._open("B")
        self._click("ski_room", 1)
        self._click("ski_room", -1)
        time.sleep(2.5)
        self.call_service.assert_not_called()
