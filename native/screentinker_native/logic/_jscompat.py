"""JS-semantics helpers for the ports of server/lib/*.js.

The shared vectors are written against the JS modules, so where a JS module leans on JS coercion
(`!!x`, `String(x)`, `Number(x)`, `new Date(x)`) the Python port must coerce the same way or it
drifts on inputs the vectors do not pin.

⚠️ Python truthiness is NOT JS truthiness: `[]` and `{}` are falsy in Python and truthy in JS. Use
`truthy()` wherever the JS source relies on `||` / `!!` over a value that might be a list or dict.
"""
from __future__ import annotations

import math
import re
from datetime import datetime, timezone


class _Undefined:
    """JS `undefined` (distinct from `None` == JS `null`); what a missing property reads as."""

    _inst = None

    def __new__(cls):
        if cls._inst is None:
            cls._inst = super().__new__(cls)
        return cls._inst

    def __bool__(self):
        return False

    def __repr__(self):
        return "undefined"


UNDEFINED = _Undefined()


def truthy(x) -> bool:
    """`!!x`: falsy is undefined/null/false/0/-0/NaN/"" and nothing else."""
    if x is None or x is UNDEFINED:
        return False
    if isinstance(x, bool):
        return x
    if isinstance(x, (int, float)):
        return x != 0 and not (isinstance(x, float) and math.isnan(x))
    if isinstance(x, str):
        return x != ""
    return True  # lists, dicts, objects: always truthy in JS


def _num_to_str(n) -> str:
    if isinstance(n, bool):
        return "true" if n else "false"
    if isinstance(n, int):
        return str(n)
    if math.isnan(n):
        return "NaN"
    if math.isinf(n):
        return "Infinity" if n > 0 else "-Infinity"
    if n == int(n) and abs(n) < 1e21:
        return str(int(n))
    return repr(n)


def string(x) -> str:
    """`String(x)`."""
    if x is UNDEFINED:
        return "undefined"
    if x is None:
        return "null"
    if isinstance(x, str):
        return x
    if isinstance(x, (bool, int, float)):
        return _num_to_str(x)
    if isinstance(x, (list, tuple)):
        return ",".join("" if (e is None or e is UNDEFINED) else string(e) for e in x)
    if isinstance(x, dict):
        return "[object Object]"
    return str(x)


# StringNumericLiteral, ASCII digits only (Python's \d would also accept other scripts' digits).
_DEC_RE = re.compile(r"[+-]?(?:[0-9]+\.?[0-9]*|\.[0-9]+)(?:[eE][+-]?[0-9]+)?")
_JS_WS = " \t\n\v\f\r            " \
         "     　﻿"


def number(x) -> float:
    """`Number(x)` (NaN for anything JS would not convert)."""
    if x is UNDEFINED:
        return math.nan
    if x is None:
        return 0.0
    if isinstance(x, bool):
        return 1.0 if x else 0.0
    if isinstance(x, (int, float)):
        return float(x)
    if isinstance(x, (list, tuple)):
        return number(string(x))
    if not isinstance(x, str):
        return math.nan
    s = x.strip(_JS_WS)
    if s == "":
        return 0.0
    if _DEC_RE.fullmatch(s):
        return float(s)
    if s in ("Infinity", "+Infinity"):
        return math.inf
    if s == "-Infinity":
        return -math.inf
    for prefix, base, digits in (("0x", 16, "0-9a-fA-F"), ("0o", 8, "0-7"), ("0b", 2, "01")):
        if s[:2].lower() == prefix and re.fullmatch("[%s]+" % digits, s[2:]):
            return float(int(s[2:], base))
    return math.nan


def is_finite(n: float) -> bool:
    return not (math.isnan(n) or math.isinf(n))


def to_instant(utc_now) -> datetime:
    """`new Date(x)` for the shapes callers pass: epoch ms (number), ISO-8601 string, or datetime.

    A naive datetime is taken as UTC (an instant, like a JS Date), never as local wall-clock.
    Raises ValueError for anything unparseable (JS: an Invalid Date, which Intl then throws on).
    """
    if isinstance(utc_now, datetime):
        return utc_now if utc_now.tzinfo else utc_now.replace(tzinfo=timezone.utc)
    if isinstance(utc_now, bool):
        raise ValueError("invalid instant")
    if isinstance(utc_now, (int, float)):
        if not is_finite(float(utc_now)):
            raise ValueError("invalid instant")
        return datetime.fromtimestamp(utc_now / 1000.0, tz=timezone.utc)
    if isinstance(utc_now, str):
        s = utc_now.strip()
        if s.endswith(("Z", "z")):
            s = s[:-1] + "+00:00"
        dt = datetime.fromisoformat(s)  # ValueError on junk
        return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
    raise ValueError("invalid instant")
