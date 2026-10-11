' playorder.brs — playlist play-order: sequential (default) | shuffle (no-repeat bag) | weighted.
'
' Port of tizen/js/play-order.js, draw for draw: given the same random sequence it returns the
' same indices (roku/tests/run-vectors.js checks this against the JS on a seeded LCG).
'
'   sequential  from+1, skipping ineligible items, wrapping
'   shuffle     a bag of every eligible index once, shuffled (Fisher-Yates); refilled only when
'               empty or when the eligible set changes; if the first draw of a new bag would repeat
'               the item just played, it is swapped deeper
'   weighted    by item.weight (default 1, floored, capped at 1000), never the item just played
'               while another is eligible
'
' FAILS OPEN to sequential: unknown mode -> sequential walk. -1 = nothing eligible.
'
' `allows` is an array of booleans, already schedule-filtered; invalid = everything eligible, and
' an index past its end (or a non-boolean entry) counts as eligible too — a blank screen is worse
' than playing an item the caller forgot to rule on.
'
' Randomness: state.rnd, when present, is an object with next() returning a number in [0, 1)
' (tests inject a seeded LCG); otherwise Rnd(0).
'
' repeat_every_sec ("play every N") is NOT handled here: the server weaves those items into the
' published list (server/lib/repeat-every.js) and strips the field, so the player never sees it.
'
' Wall/group followers MUST NOT call this — the leader's index is the source of truth.

function ST_PlayOrderNew() as object
    return { bag: invalid, bagKey: invalid }
end function

function ST_PlayOrderNext(items as object, fromIndex as integer, allows as object, mode as string, state as object) as integer
    if items = invalid then return -1
    if GetInterface(items, "ifArray") = invalid then return -1
    st = state
    if st = invalid then st = {}
    if GetInterface(st, "ifAssociativeArray") = invalid then st = {}
    if mode = "shuffle" then return ST_PoShuffleNext(items, fromIndex, allows, st)
    if mode = "weighted" then return ST_PoWeightedNext(items, fromIndex, allows, st)
    return ST_PoSequentialNext(items, fromIndex, allows)
end function

' firstIndex(): the pick before anything has played.
function ST_PlayOrderFirst(items as object, allows as object, mode as string, state as object) as integer
    return ST_PlayOrderNext(items, -1, allows, mode, state)
end function

' JS weightOf: a finite number >= 1, floored, capped at 1000; anything else 1.
function ST_PlayOrderWeightOf(item as dynamic) as integer
    if item = invalid then return 1
    if GetInterface(item, "ifAssociativeArray") = invalid then return 1
    w = item.weight
    if w = invalid then return 1
    t = LCase(type(w))
    if t = "integer" or t = "roint" or t = "rointeger" or t = "longinteger" or t = "rolonginteger"
        if w < 1 then return 1
        if w > 1000 then return 1000
        return ST_PoToInt(w)
    end if
    if t = "float" or t = "rofloat" or t = "double" or t = "rodouble"
        d# = w
        if d# <> d# then return 1                       ' NaN
        if d# < 1 then return 1
        if d# >= 1000 then return 1000                  ' also catches +Infinity
        return Int(d#)
    end if
    return 1
end function

' ---------------------------------------------------------------------------------------------
' Helpers (ST_Po*)
' ---------------------------------------------------------------------------------------------

function ST_PoToInt(v as dynamic) as integer
    i% = v
    return i%
end function

function ST_PoAllows(allows as dynamic, i as integer) as boolean
    if allows = invalid then return true
    if GetInterface(allows, "ifArray") = invalid then return true
    if i >= allows.Count() then return true
    a = allows[i]
    if a = invalid then return true
    t = LCase(type(a))
    if t = "boolean" or t = "roboolean" then return a
    return true
end function

function ST_PoRand(st as object) as double
    r = st.rnd
    if r <> invalid
        if GetInterface(r, "ifAssociativeArray") <> invalid
            if r.next <> invalid
                v# = r.next()
                return v#
            end if
        end if
    end if
    v# = Rnd(0)
    return v#
end function

function ST_PoSequentialNext(items as object, fromIndex as integer, allows as dynamic) as integer
    n = items.Count()
    if n = 0 then return -1
    start = -1
    if fromIndex >= 0 then start = fromIndex
    for k = 1 to n
        idx = (start + k) Mod n
        if ST_PoAllows(allows, idx) then return idx
    end for
    return -1
end function

function ST_PoEligible(items as object, allows as dynamic) as object
    out = []
    for i = 0 to items.Count() - 1
        if ST_PoAllows(allows, i) then out.Push(i)
    end for
    return out
end function

' eligible is built in ascending order, so the JS sort-then-join is just a join here.
function ST_PoBagKey(eligible as object) as string
    s = ""
    for i = 0 to eligible.Count() - 1
        if i > 0 then s = s + ","
        s = s + StrI(eligible[i]).Trim()
    end for
    return s
end function

function ST_PoIndexOf(arr as object, v as integer) as integer
    for i = 0 to arr.Count() - 1
        if arr[i] = v then return i
    end for
    return -1
end function

function ST_PoCopy(arr as object) as object
    out = []
    for each v in arr
        out.Push(v)
    end for
    return out
end function

function ST_PoShuffleInPlace(arr as object, st as object) as object
    i = arr.Count() - 1
    while i > 0
        j = Int(ST_PoRand(st) * (i + 1))
        t = arr[i]
        arr[i] = arr[j]
        arr[j] = t
        i = i - 1
    end while
    return arr
end function

function ST_PoMakeBag(eligible as object, fromIndex as integer, st as object) as object
    bag = ST_PoShuffleInPlace(ST_PoCopy(eligible), st)
    if bag.Count() > 1 and bag[0] = fromIndex
        j = 1 + Int(ST_PoRand(st) * (bag.Count() - 1))
        t = bag[0]
        bag[0] = bag[j]
        bag[j] = t
    end if
    return bag
end function

function ST_PoShuffleNext(items as object, fromIndex as integer, allows as dynamic, st as object) as integer
    eligible = ST_PoEligible(items, allows)
    if eligible.Count() = 0 then return -1
    key = ST_PoBagKey(eligible)
    rebuild = (st.bag = invalid)
    if not rebuild
        if st.bagKey = invalid then rebuild = true
    end if
    if not rebuild
        if st.bagKey <> key then rebuild = true
    end if
    if rebuild
        st.bag = ST_PoMakeBag(eligible, fromIndex, st)
        st.bagKey = key
    end if
    ' Drop anything that has since become ineligible (daypart closed mid-bag).
    while st.bag.Count() > 0
        if ST_PoIndexOf(eligible, st.bag[0]) <> -1 then exit while
        st.bag.Shift()
    end while
    if st.bag.Count() = 0
        st.bag = ST_PoMakeBag(eligible, fromIndex, st)
        st.bagKey = key
    end if
    return st.bag.Shift()
end function

function ST_PoWeightedNext(items as object, fromIndex as integer, allows as dynamic, st as object) as integer
    eligible = ST_PoEligible(items, allows)
    if eligible.Count() = 0 then return -1
    pool = eligible
    if eligible.Count() > 1
        pool = []
        for each i in eligible
            if i <> fromIndex then pool.Push(i)
        end for
    end if
    total = 0
    weights = []
    for each i in pool
        w = ST_PlayOrderWeightOf(items[i])
        weights.Push(w)
        total = total + w
    end for
    if total <= 0 then return pool[0]
    r# = ST_PoRand(st) * total
    acc = 0
    for j = 0 to pool.Count() - 1
        acc = acc + weights[j]
        if r# < acc then return pool[j]
    end for
    return pool[pool.Count() - 1]
end function
