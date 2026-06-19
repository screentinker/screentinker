// External overlay script — same-origin so the server CSP (scriptSrc 'self') permits it.
// Reads the weather fields from the URL query string and populates the widget.
(function () {
  var q = new URLSearchParams(location.search);
  var get = function (k) { return (q.get(k) || '').trim(); };
  var set = function (id, txt) { var el = document.getElementById(id); if (el) el.textContent = txt; };

  if (get('day') === '1') document.getElementById('card').classList.add('day');

  set('loc', get('location') || 'Weather');
  set('emoji', get('emoji') || '🌡️');
  set('temp', get('temp') !== '' ? get('temp') : '--');
  set('unit', get('tempunit') || '°');

  var cond = get('cond');
  var feels = get('feels');
  set('cond', cond + (feels !== '' ? '  ·  feels ' + feels + (get('tempunit') || '°') : ''));

  var hi = get('hi'), lo = get('lo'), u = get('tempunit') || '°';
  set('hilo', (hi !== '' ? 'H ' + hi + u : '') + (hi !== '' && lo !== '' ? '   ' : '') + (lo !== '' ? 'L ' + lo + u : ''));

  var extra = [];
  if (get('humidity') !== '') extra.push('💧 ' + get('humidity') + '%');
  if (get('wind') !== '') extra.push('💨 ' + get('wind') + ' ' + (get('windunit') || ''));
  set('extra', extra.join('   '));

  var updated = get('updated');
  if (updated) {
    var d = new Date(updated);
    set('updated', isNaN(d) ? ('· ' + updated) : ('· ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })));
  }
})();
