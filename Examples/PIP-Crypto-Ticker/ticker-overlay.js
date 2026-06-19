// External overlay script — same-origin so the server CSP (scriptSrc 'self') permits it.
// Parses the compact `items` query (SYMBOL:rawprice:signedchange, comma-joined) and
// renders a horizontal ticker strip. Mirrors decodeItems() in ticker.js.
(function () {
  var q = new URLSearchParams(location.search);
  var items = (q.get('items') || '').trim();
  var cur = (q.get('cur') || 'usd').toLowerCase();
  var CUR = { usd: '$', eur: '€', gbp: '£', jpy: '¥', aud: 'A$', cad: 'C$' };
  var sym = CUR[cur] || '';

  function addThousands(numStr) {
    var neg = numStr.charAt(0) === '-';
    var s = neg ? numStr.slice(1) : numStr;
    var parts = s.split('.');
    parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return (neg ? '-' : '') + parts.join('.');
  }
  function dirOf(chg) {
    var r = Number(parseFloat(chg).toFixed(2));
    return r > 0 ? 'up' : (r < 0 ? 'down' : 'flat');
  }
  function arrow(dir) { return dir === 'up' ? '▲' : dir === 'down' ? '▼' : '■'; }

  var row = document.getElementById('row');
  var toks = items ? items.split(',').filter(Boolean) : [];
  if (toks.length === 0) {
    var e = document.createElement('span');
    e.className = 'empty';
    e.textContent = 'No market data';
    row.appendChild(e);
    return;
  }

  toks.forEach(function (tok, idx) {
    var p = tok.split(':');
    var symbol = p[0] || '';
    var priceRaw = p[1] || '0';
    var chg = p[2] || '+0.00';
    var dir = dirOf(chg);

    var chip = document.createElement('span');
    chip.className = 'chip';

    var s = document.createElement('span');
    s.className = 'sym'; s.textContent = symbol;

    var pr = document.createElement('span');
    pr.className = 'price'; pr.textContent = sym + addThousands(priceRaw);

    var c = document.createElement('span');
    c.className = 'chg ' + dir; c.textContent = arrow(dir) + ' ' + chg + '%';

    chip.appendChild(s); chip.appendChild(pr); chip.appendChild(c);
    row.appendChild(chip);

    if (idx < toks.length - 1) {
      var dot = document.createElement('span');
      dot.className = 'dot'; dot.textContent = '•';
      row.appendChild(dot);
    }
  });
})();
