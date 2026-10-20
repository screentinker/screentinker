'use strict';
// The cache node's status page (cache-node.html). Reads this server's own /api/status: the
// scale_out.replica_of block is the source for every number here, so the page cannot disagree
// with what support sees in the API.
(function () {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const bytes = (n) => {
    const v = Number(n) || 0;
    if (v >= 1024 ** 3) return (v / 1024 ** 3).toFixed(1) + ' GB';
    if (v >= 1024 ** 2) return Math.round(v / 1024 ** 2) + ' MB';
    return v + ' bytes';
  };
  const ago = (sec) => {
    if (!sec) return 'never';
    const d = Math.max(0, Math.round(Date.now() / 1000 - sec));
    const when = new Date(sec * 1000).toLocaleString();
    if (d < 90) return `${when} (${d} s ago)`;
    if (d < 5400) return `${when} (${Math.round(d / 60)} min ago)`;
    return `${when} (${Math.round(d / 3600)} h ago)`;
  };

  function render(s) {
    const rep = s.scale_out && Array.isArray(s.scale_out.replica_of) ? s.scale_out.replica_of[0] : null;
    const rows = [];
    let tone = 'ok';
    let headline;
    if (!rep) {
      const join = s.scale_out && s.scale_out.join;
      tone = 'warn';
      if (join && join.pending) {
        headline = join.attempt ? 'Joining the main server… it could not be reached yet; trying again.' : 'Joining the main server…';
      } else if (join && join.last_error) {
        tone = 'bad';
        headline = 'The main server refused the invite. Ask for a new one and enter it on this server\'s dashboard under Servers.';
      } else {
        headline = 'Not joined to a server yet. If the installer was given an invite, check the logs folder for the reason.';
      }
      if (join && join.last_error) rows.push(['Why not', `<span class="err">${esc(join.last_error)}</span>`]);
    } else {
      const connected = rep.dial ? rep.dial.connected : rep.edge === 'up';
      if (!connected) { tone = 'bad'; headline = 'Not connected to the main server. Screens keep playing what is cached here.'; }
      else if (rep.phase === 'snapshot') { tone = 'warn'; headline = 'Connected, copying for the first time…'; }
      else headline = 'Connected to the main server and up to date.';
      rows.push(['Connected to main server', connected ? 'Yes' : 'No']);
      if (rep.dial && rep.dial.last_error && !connected) rows.push(['Why not', `<span class="err">${esc(rep.dial.last_error)}</span>`]);
      rows.push(['Last sync', esc(ago(rep.as_of))]);
      rows.push(['Workspaces copied', esc(rep.workspaces ?? 0)]);
      if (rep.cache) {
        const c = rep.cache;
        const pct = c.cap_bytes ? Math.min(100, Math.round((c.bytes / c.cap_bytes) * 100)) : 0;
        rows.push(['Cache used', `${esc(bytes(c.bytes))} of ${esc(bytes(c.cap_bytes))} (${pct}%)<div class="bar"><span style="width:${pct}%"></span></div>`]);
        rows.push(['Videos cached', esc(c.videos ?? 0)]);
        rows.push(['Files cached', esc(c.files ?? 0)]);
        if (c.prefetch_pending) rows.push(['Still downloading', `${esc(c.prefetch_pending)} file(s)`]);
        if (c.last_error) rows.push(['Last cache problem', `<span class="err">${esc(c.last_error)}</span>`]);
      } else {
        rows.push(['Media cache', 'Off — media is fetched from the main server each time']);
      }
    }
    rows.push(['Version', esc(s.version)]);
    rows.push(['Running for', esc(s.uptime_human || '')]);
    $('banner').className = 'banner ' + tone;
    $('banner').textContent = headline;
    $('facts').innerHTML = rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join('');
  }

  async function tick() {
    try {
      const r = await fetch('/api/status', { cache: 'no-store' });
      render(await r.json());
    } catch (e) {
      $('banner').className = 'banner bad';
      $('banner').textContent = 'The cache node service is not answering. It may be starting; otherwise restart "ScreenTinker Cache Node" in Services.';
      $('facts').innerHTML = '';
    }
  }
  tick();
  setInterval(tick, 5000);
})();
