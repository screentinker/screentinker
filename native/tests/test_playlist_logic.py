"""Ports of android PlaylistSelectionTest, PlaybackResumeTest, PendingSwapTest/ItemTimingTest,
PlaybackStallTest and PlaybackFaultTest (pure logic only)."""
import pytest

from screentinker_native.logic import playlist_logic as pl
from screentinker_native.logic.playlist_logic import (Claim, NonePlayable, PlaybackFault, PlaybackStall,
                                                  PreloadSlot, Recovery)


def ready(*idx):
    s = set(idx)
    return lambda i: i in s


# ================= PlaylistSelection =================

def test_a_stalled_download_of_the_next_item_loops_what_it_has():
    assert pl.next_playable_index(2, 0, ready(0)) == 0


def test_once_the_download_completes_the_next_item_is_picked_up():
    assert pl.next_playable_index(2, 0, ready(0, 1)) == 1


def test_an_unready_item_is_never_chosen():
    assert pl.first_playable_index(3, ready(0, 2)) == 0
    assert pl.next_playable_index(3, 0, ready(0, 2)) == 2
    assert pl.next_playable_index(3, 2, ready(0, 2)) == 0


def test_no_item_ready_returns_minus_1():
    assert pl.first_playable_index(3, ready()) == -1
    assert pl.next_playable_index(3, 1, ready()) == -1


def test_nothing_playable_keeps_current_content_when_something_is_on_screen():
    assert pl.when_none_playable(True) is NonePlayable.KEEP_CURRENT
    assert pl.when_none_playable(False) is NonePlayable.SHOW_WAITING


def test_a_single_downloaded_item_loops():
    assert pl.next_playable_index(1, 0, ready(0)) == 0


def test_cold_start_recheck_begins_at_the_seeded_index():
    assert pl.recheck_index(4, 0, False, ready(0, 1, 2, 3)) == 0


def test_recheck_with_content_on_screen_advances():
    assert pl.recheck_index(4, 0, True, ready(0, 1, 2, 3)) == 1


def test_cold_start_recheck_still_skips_undownloaded():
    assert pl.recheck_index(4, 0, False, ready(2, 3)) == 2


def test_cold_start_recheck_with_no_position_starts_at_the_top():
    assert pl.recheck_index(3, -1, False, ready(0, 1, 2)) == 0


def test_cold_start_recheck_returns_minus_1_while_nothing_downloaded():
    assert pl.recheck_index(3, 0, False, ready()) == -1


def test_playable_from_index_is_inclusive_and_wraps():
    assert pl.playable_from_index(4, 1, ready(1, 3)) == 1
    assert pl.playable_from_index(4, 2, ready(1, 3)) == 3
    assert pl.playable_from_index(4, 3, ready(1)) == 1
    assert pl.playable_from_index(0, 0, ready(0)) == -1


def test_negative_from_wraps_like_the_kotlin_double_mod():
    assert pl.next_playable_index(3, -1, ready(0, 1, 2)) == 0


def test_strict_always_wins_over_stale():
    assert pl.first_playable_or_stale(3, ready(2), ready(0, 1, 2)) == 2
    assert pl.next_playable_or_stale(3, 0, ready(2), ready(1, 2)) == 2


def test_stale_is_the_last_resort_only():
    assert pl.first_playable_or_stale(3, ready(), ready(1)) == 1
    assert pl.next_playable_or_stale(3, 1, ready(), ready(0)) == 0
    assert pl.first_playable_or_stale(3, ready(), ready()) == -1


# ================= PlaybackResume (#234) =================
NOW = 1_000_000
W = pl.RESUME_WINDOW_MS


def test_THE_BUG_a_reload_moments_after_playing_continues():
    assert pl.resume_index(1, NOW - 5_000, NOW, 2) == 1


def test_resume_fallbacks():
    assert pl.resume_index(-1, 0, NOW, 3) == 0  # cold start
    assert pl.resume_index(2, NOW - (W + 1), NOW, 3) == 0  # stale save
    assert pl.resume_index(2, NOW - (W - 1), NOW, 3) == 2  # just inside
    assert pl.resume_index(7, NOW - 1_000, NOW, 3) == 0  # playlist shrank
    assert pl.resume_index(3, NOW - 1_000, NOW, 3) == 0
    assert pl.resume_index(1, NOW - 1_000, NOW, 0) == 0  # empty
    assert pl.resume_index(1, NOW + 60_000, NOW, 2) == 0  # clock jumped backwards
    assert pl.resume_index(1, 0, NOW, 2) == 0  # zero timestamp = no save
    assert pl.resume_index(0, NOW - 1_000, NOW, 2) == 0


# ================= PendingSwap (#157) =================
LIVE = "content-on-screen"


def defer(new_ids, current=LIVE, is_running=True, wall_follower=False, has_content=True):
    return pl.should_defer_swap(is_running, wall_follower, has_content, current, new_ids)


def test_THE_BUG_selecting_no_playlist_is_not_deferred():
    assert defer([]) is False


def test_a_genuine_rotation_still_defers():
    assert defer(["other-a", "other-b"]) is True


def test_swap_apply_immediately_cases():
    assert defer([LIVE, "other-a"]) is False
    assert defer(["other-a"], has_content=False) is False
    assert defer(["other-a"], current=None) is False
    assert defer(["other-a"], is_running=False) is False
    assert defer(["other-a"], wall_follower=True) is False


def test_the_deferral_deadline_is_sane():
    assert 30_000 < pl.PENDING_SWAP_DEADLINE_MS <= 120_000


# ================= ItemTiming =================

def test_youtube_images_widgets_and_bundles_end_on_a_timer():
    assert pl.ends_on_timer("video/youtube", False)
    assert pl.ends_on_timer("image/jpeg", False)
    assert pl.ends_on_timer("image/png", False)
    assert pl.ends_on_timer("text/html", True)
    assert pl.ends_on_timer(pl.BUNDLE_MIME, False)
    assert pl.BUNDLE_MIME == "application/vnd.screentinker.bundle+zip"


def test_unknown_types_and_real_video_are_not_timed():
    assert not pl.ends_on_timer("application/pdf", False)
    assert not pl.ends_on_timer("video/mp4", False)
    assert not pl.ends_on_timer("video/webm", False)


# ================= PlaybackStall (#297) =================
READY, BUFFERING = PlaybackStall.STATE_READY, PlaybackStall.STATE_BUFFERING
ENDED, IDLE = PlaybackStall.STATE_ENDED, PlaybackStall.STATE_IDLE


def test_THE_BUG_a_wedged_decoder_is_reported_after_the_threshold():
    s = PlaybackStall(ready_stall_ms=10_000)
    assert not s.tick(0, READY, True, 1_000)
    assert not s.tick(2_000, READY, True, 3_000)
    assert not s.tick(4_000, READY, True, 3_000)
    assert not s.tick(9_000, READY, True, 3_000)
    assert s.tick(15_000, READY, True, 3_000)


def test_it_reports_only_once():
    s = PlaybackStall(ready_stall_ms=1_000)
    s.tick(0, READY, True, 500)
    assert s.tick(5_000, READY, True, 500)
    assert not s.tick(6_000, READY, True, 500)


def test_normal_playback_never_reports():
    s = PlaybackStall(ready_stall_ms=1_000)
    pos = 0
    for t in range(61):
        pos += 1_000
        assert not s.tick(t * 1_000, READY, True, pos)


def test_a_looping_single_video_is_not_stalled_when_it_wraps():
    s = PlaybackStall(ready_stall_ms=1_000)
    assert not s.tick(0, READY, True, 9_000)
    assert not s.tick(2_000, READY, True, 0)
    assert not s.tick(4_000, READY, True, 500)


def test_a_paused_item_is_not_a_stall():
    s = PlaybackStall(ready_stall_ms=1_000)
    for t in range(21):
        assert not s.tick(t * 5_000, READY, False, 4_000)


def test_a_slow_stream_gets_a_longer_rope_while_buffering():
    s = PlaybackStall(ready_stall_ms=10_000, buffering_stall_ms=30_000)
    s.tick(0, BUFFERING, True, 2_000)
    assert not s.tick(15_000, BUFFERING, True, 2_000)
    assert s.tick(40_000, BUFFERING, True, 2_000)


def test_ended_and_idle_are_somebody_elses_business():
    s = PlaybackStall(ready_stall_ms=1_000)
    for t in range(11):
        assert not s.tick(t * 2_000, ENDED, True, 5_000)
        assert not s.tick(t * 2_000, IDLE, True, 5_000)


def test_the_timer_restarts_when_playback_recovers():
    s = PlaybackStall(ready_stall_ms=10_000)
    s.tick(0, READY, True, 1_000)
    s.tick(5_000, READY, True, 1_000)
    assert not s.tick(6_000, READY, True, 1_500)
    assert not s.tick(12_000, READY, True, 1_500)
    assert s.tick(20_000, READY, True, 1_500)


def test_a_pause_clears_the_stall_timer():
    s = PlaybackStall(ready_stall_ms=5_000)
    s.tick(0, READY, True, 1_000)
    s.tick(3_000, READY, False, 1_000)
    assert not s.tick(4_000, READY, True, 1_000)
    assert s.tick(10_000, READY, True, 1_000)


# ================= PlaybackFault (#333) =================

def test_THE_BUG_a_fault_in_follower_mode_replays():
    assert PlaybackFault().recovery(True, 0, 0) is Recovery.REPLAY_CURRENT


def test_a_fault_in_follower_mode_never_advances():
    f = PlaybackFault()
    for t in range(11):
        assert f.recovery(True, 1, t * 1_000) is not Recovery.ADVANCE


def test_solo_playback_still_skips_the_broken_item():
    f = PlaybackFault()
    assert f.recovery(False, 0, 0) is Recovery.ADVANCE
    assert f.recovery(False, 0, 10) is Recovery.ADVANCE


def test_an_instantly_faulting_clip_is_held_not_replayed_in_a_loop():
    f = PlaybackFault(replay_cooldown_ms=5_000)
    assert f.recovery(True, 2, 0) is Recovery.REPLAY_CURRENT
    assert f.recovery(True, 2, 300) is Recovery.HOLD
    assert f.recovery(True, 2, 4_999) is Recovery.HOLD


def test_the_hold_lifts_after_the_cooldown():
    f = PlaybackFault(replay_cooldown_ms=5_000)
    f.recovery(True, 2, 0)
    assert f.recovery(True, 2, 1_000) is Recovery.HOLD
    assert f.recovery(True, 2, 5_000) is Recovery.REPLAY_CURRENT


def test_a_new_item_gets_a_fresh_replay():
    f = PlaybackFault(replay_cooldown_ms=5_000)
    f.recovery(True, 2, 0)
    assert f.recovery(True, 3, 100) is Recovery.REPLAY_CURRENT


def test_a_fault_at_time_zero_is_a_real_observation():
    f = PlaybackFault(replay_cooldown_ms=5_000)
    assert f.recovery(True, 0, 0) is Recovery.REPLAY_CURRENT
    assert f.recovery(True, 0, 1) is Recovery.HOLD


# ================= PreloadSlot (#333) =================

def test_preload_slot_claims():
    s = PreloadSlot()
    assert s.claim("/a.mp4", False) is Claim.COLD
    s.park("/a.mp4")
    assert s.is_parked("/a.mp4")
    assert s.claim("/b.mp4", False) is Claim.COLD, "COLD leaves the parked clip in place"
    assert s.is_parked("/a.mp4")
    assert s.claim("/a.mp4", False) is Claim.WARM
    assert not s.is_parked("/a.mp4"), "a claim consumes the slot"


def test_THE_0_00_FREEZE_a_failed_preload_is_not_promoted_warm():
    s = PreloadSlot()
    s.park("/a.mp4")
    s.fail()
    assert s.claim("/a.mp4", True) is Claim.COLD
    s.park("/a.mp4")
    assert s.claim("/a.mp4", True) is Claim.WARM_NEEDS_PREPARE
