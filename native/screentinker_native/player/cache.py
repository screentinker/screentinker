"""Offline content cache — a port of Android's ContentCache + DownloadCoordinator.

Layout under <state>/content/ (names match Android so the rules port one-to-one):
  <id>.<ext>            the complete asset
  <id>.<ext>.rev        its content_rev (absent = pre-revision copy: usable, never "confirmed")
  <id>.<ext>.part       an interrupted download, KEPT so the next attempt resumes with Range
  <id>.<ext>.part.tag   the ETag / Last-Modified the .part was fetched against (If-Range)

The rules that matter, each learned the hard way on Android:
  * Resume, never restart: a link that cannot carry a whole asset in one attempt must still finish.
    If-Range makes the server answer 200 (full body) when the asset changed under the .part, and a
    416 means the .part is longer than the asset — both discard it.
  * Complete means bytes-on-disk == the total the server declared (Content-Range total, or
    Content-Length on a 200). Never "the request ended without an exception".
  * Atomic promotion: .part -> fsync -> rename. A reader never sees half a file under the final name.
  * READY (revision confirmed) vs USABLE (bytes present, revision unknown): the controller plays
    READY first and falls back to USABLE only when nothing is READY — see PlaylistController.
  * Coordinator: 3 concurrent, single-flight per id, failure backoff 15s doubling to 5 min, and a
    resume chain of up to 12 back-to-back continuation attempts before handing back to the backoff.
  * No auth header on content downloads (same as Android; /api/content/:id/file is capability-URL).
"""

import asyncio
import logging
import os
import re
import time

import aiohttp

log = logging.getLogger("cache")

MAX_CONCURRENT = 3
BACKOFF_BASE_S = 15
BACKOFF_MAX_S = 300
MAX_RESUME_CHAIN = 12


def _ext(filename, mime=""):
    base = os.path.basename(filename or "")
    if "." in base:
        e = base.rsplit(".", 1)[1].lower()
        if re.fullmatch(r"[a-z0-9]{1,8}", e):
            return e
    if mime and "/" in mime:
        return re.sub(r"[^a-z0-9]", "", mime.split("/", 1)[1].lower())[:8] or "bin"
    return "bin"


def parse_content_range(h):
    m = re.match(r"bytes (\d+)-(\d+)/(\d+|\*)", h or "")
    if not m or m.group(3) == "*":
        return None
    return int(m.group(1)), int(m.group(3))


class ContentCache:
    def __init__(self, root):
        self.root = root
        os.makedirs(root, exist_ok=True)

    def _safe_id(self, cid):
        return re.sub(r"[^A-Za-z0-9_-]", "_", str(cid))

    def final_path(self, cid, filename, mime=""):
        return os.path.join(self.root, "%s.%s" % (self._safe_id(cid), _ext(filename, mime)))

    def cached_file(self, cid):
        """Any complete file for this id (exact '<id>.' prefix; never a .part/.tag/.rev)."""
        pre = self._safe_id(cid) + "."
        try:
            for n in os.listdir(self.root):
                if n.startswith(pre) and not n.endswith((".part", ".tag", ".rev")) and n.count(".") == 1:
                    return os.path.join(self.root, n)
        except OSError:
            pass
        return None

    def read_rev(self, path):
        try:
            with open(path + ".rev") as f:
                return int(f.read().strip() or 0)
        except (OSError, ValueError):
            return None

    def is_ready(self, cid, rev):
        """Complete AND revision confirmed. rev 0 = the server has no revision: a present file is it."""
        p = self.cached_file(cid)
        if not p:
            return False
        if not rev:
            return True
        return self.read_rev(p) == int(rev)

    def is_usable(self, cid):
        return self.cached_file(cid) is not None

    def delete(self, cid):
        pre = self._safe_id(cid) + "."
        for n in os.listdir(self.root):
            if n.startswith(pre):
                try:
                    os.unlink(os.path.join(self.root, n))
                except OSError:
                    pass

    def prune(self, keep_ids):
        """Drop assets no longer referenced by the playlist, triggers or default content."""
        keep = {self._safe_id(k) for k in keep_ids}
        removed = 0
        for n in os.listdir(self.root):
            cid = n.split(".", 1)[0]
            if cid and cid not in keep:
                try:
                    os.unlink(os.path.join(self.root, n))
                    removed += 1
                except OSError:
                    pass
        return removed

    async def fetch(self, session, server, cid, filename, mime, rev):
        """One attempt. Returns 'done', 'partial' (progress made, continue) or 'failed'."""
        final = self.final_path(cid, filename, mime)
        part, tag = final + ".part", final + ".part.tag"
        have = os.path.getsize(part) if os.path.exists(part) else 0
        validator = None
        if have:
            try:
                with open(tag) as f:
                    validator = f.read().strip() or None
            except OSError:
                validator = None
            if not validator:           # no validator = cannot prove the .part matches: restart
                have = 0
        if not have:
            for p in (part, tag):
                try:
                    os.unlink(p)
                except OSError:
                    pass
        url = "%s/api/content/%s/file" % (server, cid) + ("?rev=%d" % int(rev) if rev else "")
        headers = {}
        if have:
            headers["Range"] = "bytes=%d-" % have
            headers["If-Range"] = validator
        try:
            async with session.get(url, headers=headers, timeout=aiohttp.ClientTimeout(
                    total=None, sock_connect=20, sock_read=60)) as r:
                if r.status == 416:
                    os.unlink(part)
                    return "failed"
                if r.status == 206:
                    rng = parse_content_range(r.headers.get("Content-Range"))
                    if not rng or rng[0] != have:
                        os.unlink(part)
                        return "failed"
                    total = rng[1]
                    mode = "ab"
                elif r.status == 200:
                    total = int(r.headers.get("Content-Length") or 0) or None
                    have = 0
                    mode = "wb"
                else:
                    log.warning("download %s: HTTP %s", cid, r.status)
                    return "failed"
                v = r.headers.get("ETag") or r.headers.get("Last-Modified")
                with open(tag, "w") as f:
                    f.write(v or "")
                with open(part, mode) as f:
                    async for chunk in r.content.iter_chunked(256 * 1024):
                        f.write(chunk)
                    f.flush()
                    os.fsync(f.fileno())
        except (aiohttp.ClientError, asyncio.TimeoutError, OSError) as e:
            now = os.path.getsize(part) if os.path.exists(part) else 0
            log.info("download %s interrupted at %d bytes: %s", cid, now, e)
            return "partial" if now > have else "failed"
        size = os.path.getsize(part)
        if total is None or size != total:
            log.warning("download %s incomplete: %s of %s bytes", cid, size, total)
            return "partial" if size > have else "failed"
        # Replace any older copy of this id (the extension may have changed with the file).
        old = self.cached_file(cid)
        if old and old != final:
            for p in (old, old + ".rev"):
                try:
                    os.unlink(p)
                except OSError:
                    pass
        os.replace(part, final)
        try:
            os.unlink(tag)
        except OSError:
            pass
        if rev:
            with open(final + ".rev", "w") as f:
                f.write(str(int(rev)))
        else:
            try:
                os.unlink(final + ".rev")
            except OSError:
                pass
        log.info("cached %s (%d bytes)", os.path.basename(final), size)
        return "done"


class DownloadCoordinator:
    def __init__(self, cache, server_fn, on_result):
        self.cache = cache
        self.server_fn = server_fn
        self.on_result = on_result         # (content_id, ok: bool) — called on the net loop
        self.in_flight = set()
        self.failures = {}
        self.next_attempt = {}
        self._sem = asyncio.Semaphore(MAX_CONCURRENT)
        self._session = None

    async def _sess(self):
        if self._session is None or self._session.closed:
            self._session = aiohttp.ClientSession(headers={"User-Agent": "ScreenTinker-Pi"})
        return self._session

    def ensure(self, cid, filename, mime, rev):
        if not cid or cid in self.in_flight:
            return
        if self.cache.is_ready(cid, rev):
            return
        if time.monotonic() < self.next_attempt.get(cid, 0):
            return
        self.in_flight.add(cid)
        asyncio.ensure_future(self._run(cid, filename, mime, rev))

    async def _run(self, cid, filename, mime, rev):
        try:
            async with self._sem:
                sess = await self._sess()
                result = "failed"
                for _ in range(MAX_RESUME_CHAIN):
                    result = await self.cache.fetch(sess, self.server_fn(), cid, filename, mime, rev)
                    if result != "partial":
                        break
            if result == "done":
                self.failures.pop(cid, None)
                self.next_attempt.pop(cid, None)
                self.on_result(cid, True)
            else:
                n = self.failures.get(cid, 0) + 1
                self.failures[cid] = n
                self.next_attempt[cid] = time.monotonic() + min(BACKOFF_BASE_S * (2 ** (n - 1)), BACKOFF_MAX_S)
                self.on_result(cid, False)
        except Exception:
            log.exception("download %s crashed", cid)
        finally:
            self.in_flight.discard(cid)

    def forget(self, cid):
        self.failures.pop(cid, None)
        self.next_attempt.pop(cid, None)

    def reset_all_backoff(self):
        self.next_attempt.clear()
