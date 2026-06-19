// External overlay script — same-origin so the server CSP (scriptSrc 'self') permits it.
// Reads ?target (epoch ms) and ?title from the URL and ticks a live DD:HH:MM:SS clock.
// When the target arrives it switches to a celebratory state. The PiP itself is removed
// by the player at the same moment (duration = seconds-to-target), so this is the visual
// that the viewer sees right before it vanishes.
(function () {
  var q = new URLSearchParams(location.search);
  var target = parseInt(q.get('target'), 10);
  var title = (q.get('title') || 'Countdown').trim();

  document.getElementById('title').textContent = title;

  var pad = function (n) { return (n < 10 ? '0' : '') + n; };
  var elD = document.getElementById('d');
  var elH = document.getElementById('h');
  var elM = document.getElementById('m');
  var elS = document.getElementById('s');
  var clock = document.getElementById('clock');
  var card = document.getElementById('card');

  function tick() {
    var secs = Math.ceil((target - Date.now()) / 1000);
    if (!isFinite(target)) { return; }
    if (secs <= 0) {
      celebrate();
      return;
    }
    var s = secs;
    var days = Math.floor(s / 86400); s -= days * 86400;
    var hours = Math.floor(s / 3600); s -= hours * 3600;
    var mins = Math.floor(s / 60); s -= mins * 60;
    elD.textContent = pad(days);
    elH.textContent = pad(hours);
    elM.textContent = pad(mins);
    elS.textContent = pad(s);
  }

  var celebrated = false;
  function celebrate() {
    if (celebrated) { return; }
    celebrated = true;
    clearInterval(timer);
    clock.classList.add('done');
    elD.textContent = '00'; elH.textContent = '00'; elM.textContent = '00'; elS.textContent = '00';
    var c = document.createElement('div');
    c.className = 'celebrate';
    c.textContent = '🎉 ' + title;
    card.appendChild(c);
  }

  tick();
  var timer = setInterval(tick, 1000);
})();
