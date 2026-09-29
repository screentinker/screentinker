"""Display power schedule — Android power/PowerScheduleManager.kt, on the Qt thread.

The panel is handed a DEFINITION (set_power_schedule, or `power_schedule` on every playlist payload)
and evaluates it locally with logic/power_window.py (held to shared/power-window-vectors.json), so it
keeps sleeping and waking with the WAN down. A 60 s tick re-evaluates; nothing schedules itself from a
computed edge, which is what makes DST unable to strand it. A manual screen_on inside an off-window
exempts the panel until that window ends; a NEW schedule ends any exemption.
"""

import json
import logging
import time

from PySide6.QtCore import QTimer

from ..logic import power_window

log = logging.getLogger("power")

TICK_MS = 60_000


def decide(scheduled_off, manual_override):
    """(off, clear_override) — Android PowerScheduleManager.decide."""
    if not scheduled_off:
        return False, True
    if manual_override:
        return False, False
    return True, False


class PowerSchedule:
    def __init__(self, config, on_apply, on_state_changed=None):
        self.config = config
        self.on_apply = on_apply                 # (off: bool) -> None
        self.on_state_changed = on_state_changed
        self.schedule = config.get("power_schedule")
        self.manual_override = False
        self.applied_off = None
        self.timer = QTimer()
        self.timer.setInterval(TICK_MS)
        self.timer.timeout.connect(lambda: self.apply_now(False))

    @property
    def state(self):
        return "scheduled_off" if self.applied_off else "on"

    def _now(self):
        return int(time.time() * 1000)

    def start(self):
        self.timer.start()
        self.apply_now(True)

    def update(self, schedule):
        schedule = schedule if isinstance(schedule, dict) else None
        if json.dumps(schedule, sort_keys=True) == json.dumps(self.schedule, sort_keys=True):
            return                                # idempotent: every payload carries this field
        self.schedule = schedule
        self.config.set("power_schedule", schedule)
        self.manual_override = False
        log.info("schedule updated: %s", "none" if not schedule else "%d window(s)" % len(schedule.get("windows") or []))
        self.apply_now(True)

    def note_manual_screen_on(self):
        if not power_window.is_off(self.schedule, self._now()):
            return False
        self.manual_override = True
        self.applied_off = False
        log.info("manual screen_on inside a scheduled-off window: schedule resumes at the next edge")
        if self.on_state_changed:
            self.on_state_changed(self.state)
        return True

    def note_manual_screen_off(self):
        self.manual_override = False

    def apply_now(self, force):
        scheduled_off = power_window.is_off(self.schedule, self._now())
        off, clear = decide(scheduled_off, self.manual_override)
        if not scheduled_off:
            self.manual_override = False
        if not force and self.applied_off == off:
            return
        # A forced re-apply with no schedule and nothing ever applied must not touch the screen:
        # the operator may have turned it off by hand.
        if force and self.applied_off is None and not off and not self.schedule:
            self.applied_off = False
            return
        self.applied_off = off
        if clear:
            self.manual_override = False
        try:
            self.on_apply(off)
        except Exception:
            log.exception("apply(%s)", off)
        if self.on_state_changed:
            self.on_state_changed(self.state)
        log.info("power state -> %s%s", self.state, " (manual override)" if self.manual_override else "")
