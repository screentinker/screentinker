// Playlist play-order: sequential (default) | shuffle (no-repeat bag) | weighted.
//
// CONTRACT: players call nextIndex() at every advance. Sequential is the historical
// "from+1, skip ineligible" walk. Shuffle draws from a bag of currently-eligible
// indices and only refills once the bag is empty (no immediate repeats while >1
// eligible). Weighted picks among eligible by playlist_items.weight (default 1),
// avoiding the item just played when another eligible item exists.
//
// FAILS OPEN to sequential: unknown mode, missing state, empty list → sequential
// walk. A blank screen is worse than playing in order.
//
// Wall/group followers MUST NOT call this — the leader's index is the source of
// truth. Shuffle on a follower would desync the wall.
//
// Dependency-free UMD: Node + browser/Tizen (window.PlayOrder).

(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.PlayOrder = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function weightOf(item) {
    var w = item && item.weight;
    if (typeof w !== 'number' || !isFinite(w) || w < 1) return 1;
    return Math.min(1000, Math.floor(w));
  }

  function shuffleInPlace(arr, rnd) {
    for (var i = arr.length - 1; i > 0; i--) {
      var j = Math.floor(rnd() * (i + 1));
      var t = arr[i]; arr[i] = arr[j]; arr[j] = t;
    }
    return arr;
  }

  function sequentialNext(items, from, allows) {
    if (!items || !items.length) return -1;
    var start = (typeof from === 'number' && from >= 0) ? from : -1;
    for (var k = 1; k <= items.length; k++) {
      var idx = (start + k) % items.length;
      if (allows(items[idx], idx)) return idx;
    }
    return -1;
  }

  function eligibleIndices(items, allows) {
    var out = [];
    for (var i = 0; i < items.length; i++) if (allows(items[i], i)) out.push(i);
    return out;
  }

  function bagKey(eligible) {
    return eligible.slice().sort(function (a, b) { return a - b; }).join(',');
  }

  // A full bag holds EVERY eligible index once (so nothing is under-played over a
  // cycle), shuffled. To avoid an immediate repeat across the bag boundary, if the
  // first draw would be the item just played and another can lead, swap it deeper.
  function makeBag(eligible, from, rnd) {
    var bag = shuffleInPlace(eligible.slice(), rnd);
    if (bag.length > 1 && bag[0] === from) {
      var j = 1 + Math.floor(rnd() * (bag.length - 1));
      var t = bag[0]; bag[0] = bag[j]; bag[j] = t;
    }
    return bag;
  }

  function nextShuffle(items, from, allows, state, rnd) {
    var eligible = eligibleIndices(items, allows);
    if (!eligible.length) return -1;
    var key = bagKey(eligible);
    if (!state.bag || state.bagKey !== key) {
      state.bag = makeBag(eligible, from, rnd);
      state.bagKey = key;
    }
    // Drop anything that has since become ineligible (daypart closed mid-bag).
    while (state.bag.length && eligible.indexOf(state.bag[0]) === -1) state.bag.shift();
    if (!state.bag.length) {
      state.bag = makeBag(eligible, from, rnd);
      state.bagKey = key;
    }
    return state.bag.shift();
  }

  function nextWeighted(items, from, allows, rnd) {
    var eligible = eligibleIndices(items, allows);
    if (!eligible.length) return -1;
    var pool = eligible.length > 1 ? eligible.filter(function (i) { return i !== from; }) : eligible;
    var total = 0;
    var weights = [];
    for (var i = 0; i < pool.length; i++) {
      var w = weightOf(items[pool[i]]);
      weights.push(w);
      total += w;
    }
    if (total <= 0) return pool[0];
    var r = rnd() * total;
    var acc = 0;
    for (var j = 0; j < pool.length; j++) {
      acc += weights[j];
      if (r < acc) return pool[j];
    }
    return pool[pool.length - 1];
  }

  // nextIndex(items, from, allowsFn, mode, state)
  //   items    - playlist array
  //   from     - index just played (-1 on first pick)
  //   allowsFn - (item, index) => bool (schedule/window/condition)
  //   mode     - 'sequential' | 'shuffle' | 'weighted'
  //   state    - mutable { bag, bagKey } owned by the caller; one per playlist/zone
  //   rnd      - optional () => [0,1) for tests / seeded e-ink
  function nextIndex(items, from, allowsFn, mode, state, rnd) {
    try {
      var allows = typeof allowsFn === 'function' ? allowsFn : function () { return true; };
      var rand = typeof rnd === 'function' ? rnd : Math.random;
      var st = state || {};
      var m = mode || 'sequential';
      if (m === 'shuffle') return nextShuffle(items, from, allows, st, rand);
      if (m === 'weighted') return nextWeighted(items, from, allows, rand);
      return sequentialNext(items, from, allows);
    } catch (e) {
      return sequentialNext(items, from, typeof allowsFn === 'function' ? allowsFn : function () { return true; });
    }
  }

  function firstIndex(items, allowsFn, mode, state, rnd) {
    return nextIndex(items, -1, allowsFn, mode, state, rnd);
  }

  return { nextIndex: nextIndex, firstIndex: firstIndex, weightOf: weightOf };
});
