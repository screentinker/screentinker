"""Root-2 caching fix — the pure "is this download complete?" rule.

Port of android data/CacheValidation.kt. The downloader is the imperative shell; this owns the
integrity decision so a truncated/partial body is never promoted to the cache dir and later served
as if it were a whole file (which previously wedged playback on a corrupt asset with no error path).
"""


def is_complete(bytes_written: int, expected_bytes: int) -> bool:
    """Complete iff at least one byte was written AND — when the server declared a Content-Length
    (expected_bytes > 0) — exactly that many. Fewer (truncated) or more (over-read) is INCOMPLETE and
    must be discarded + re-fetched. Unknown length (chunked / -1) falls back to ">0 bytes"."""
    return bytes_written > 0 and (expected_bytes <= 0 or bytes_written == expected_bytes)
