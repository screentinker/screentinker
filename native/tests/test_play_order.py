"""Port of server/test/play-order.test.js (seeded RNG so the bag is deterministic)."""
from screentinker_native.logic.play_order import PlayOrderState, first_index, next_index, weight_of


def items(n):
    return [{"id": i, "weight": 1} for i in range(n)]


def ALL(_it, _i):
    return True


def rng(seq):
    state = {"i": 0}

    def r():
        v = seq[state["i"] % len(seq)]
        state["i"] += 1
        return v
    return r


def test_sequential_walks_from_plus_1_and_wraps_skipping_ineligible():
    lst = items(4)
    allows = lambda it, idx: idx != 1  # noqa: E731
    assert next_index(lst, 0, allows, "sequential") == 2
    assert next_index(lst, 2, allows, "sequential") == 3
    assert next_index(lst, 3, allows, "sequential") == 0
    assert first_index(lst, allows, "sequential") == 0


def test_unknown_mode_and_empty_list_fail_open_to_sequential():
    assert next_index(items(3), 0, ALL, "nope") == 1
    assert next_index([], 0, ALL, "shuffle") == -1
    assert next_index(None, 0, ALL, "weighted") == -1


def test_shuffle_draws_a_no_repeat_bag_and_refills_when_empty():
    lst, state = items(3), PlayOrderState()
    rnd = rng([0.9, 0.1, 0.5, 0.2, 0.8, 0.3, 0.7, 0.4])
    seen, frm = [], -1
    for _ in range(6):
        frm = next_index(lst, frm, ALL, "shuffle", state, rnd)
        seen.append(frm)
    assert sorted(seen[:3]) == [0, 1, 2]
    assert all(i in (0, 1, 2) for i in seen)
    for a, b in zip(seen, seen[1:]):
        assert a != b, "no immediate repeat"


def test_shuffle_refills_when_membership_changes():
    lst, state = items(3), PlayOrderState()
    rnd = rng([0.2, 0.8, 0.1, 0.9])
    a = next_index(lst, -1, ALL, "shuffle", state, rnd)
    assert a >= 0
    b = next_index(lst, a, lambda it, idx: idx != a, "shuffle", state, rnd)
    assert b != a and b in (0, 1, 2)


def test_shuffle_bags_are_full_n_every_item_plays_once_per_cycle():
    lst, state = items(4), PlayOrderState()
    rnd = rng([0.9, 0.1, 0.5, 0.2, 0.8, 0.3, 0.7, 0.4, 0.6, 0.05])
    counts, frm = [0, 0, 0, 0], -1
    for _ in range(12):
        frm = next_index(lst, frm, ALL, "shuffle", state, rnd)
        counts[frm] += 1
    assert counts == [3, 3, 3, 3]


def test_single_item_shuffle_weighted_returns_the_lone_item():
    one, s = items(1), PlayOrderState()
    for _ in range(5):
        assert next_index(one, 0, ALL, "shuffle", s) == 0
    for _ in range(5):
        assert next_index(one, 0, ALL, "weighted", PlayOrderState()) == 0


def test_nothing_eligible_returns_minus_1():
    lst = items(3)
    none = lambda it, i: False  # noqa: E731
    assert next_index(lst, 0, none, "shuffle", PlayOrderState()) == -1
    assert next_index(lst, 0, none, "weighted", PlayOrderState()) == -1
    assert next_index(lst, 0, none, "sequential") == -1


def test_weighted_distribution_follows_the_weights():
    lst = [{"weight": 1}, {"weight": 8}, {"weight": 1}]  # cumulative 1, 9, 10
    pick = lambda r: next_index(lst, -1, ALL, "weighted", PlayOrderState(), rng([r]))  # noqa: E731
    assert pick(0.05) == 0
    assert pick(0.5) == 1
    assert pick(0.95) == 2
    # JS band semantics [prev, acc): exactly on a boundary belongs to the NEXT item.
    assert pick(0.1) == 1


def test_weighted_avoids_the_item_just_played():
    lst = [{"weight": 1}, {"weight": 100}, {"weight": 1}]
    assert next_index(lst, 1, ALL, "weighted", PlayOrderState(), rng([0.99])) != 1


def test_weight_of_clamps_and_defaults_to_1():
    assert weight_of({}) == 1
    assert weight_of({"weight": 0}) == 1
    assert weight_of({"weight": 12.9}) == 12
    assert weight_of({"weight": 9999}) == 1000
    assert weight_of({"weight": "5"}) == 1  # JS: typeof !== 'number'
    assert weight_of({"weight": True}) == 1


def test_an_rng_returning_exactly_1_cannot_index_out_of_range():
    lst, s = items(3), PlayOrderState()
    got = [next_index(lst, -1, ALL, "shuffle", s, lambda: 1.0) for _ in range(3)]
    assert sorted(got) == [0, 1, 2]
