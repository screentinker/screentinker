(function () {
  var lastError = '';
  function show(text) {
    var el = document.getElementById('st-native-diagnostic');
    if (el) el.textContent = text;
  }
  function showBridgeFailure(text) {
    var el = document.getElementById('st-native-failure');
    if (!el && document.body) {
      el = document.createElement('div');
      el.id = 'st-native-failure';
      el.style.cssText = 'position:fixed;top:0;left:0;right:0;padding:24px;background:#7f1d1d;color:white;font:24px Arial;z-index:2147483647';
      document.body.appendChild(el);
    }
    if (el) el.textContent = text;
  }
  window.addEventListener('error', function (event) {
    var text = event.message || ('Failed to load: ' + ((event.target && event.target.src) || 'resource'));
    lastError = String(text) + (event.lineno ? ' (line ' + event.lineno + ')' : '');
    show('BUILD __ST_BUILD__ - ERROR: ' + lastError);
  }, true);
  window.addEventListener('load', function () {
    if (!lastError) show('BUILD __ST_BUILD__ - STARTED');
    setTimeout(function () {
      if (lastError) return;
      if (typeof window.connect !== 'function') show('BUILD __ST_BUILD__ - PLAYER SCRIPT DID NOT START');
      else if (!window.__STNative || !window.__STNative.ready) {
        var message = 'BUILD __ST_BUILD__ - SAMSUNG BRIDGE FAILED: ' + ((window.__STNative && window.__STNative.error) || 'unknown');
        show(message);
        showBridgeFailure(message);
      }
      else show('BUILD __ST_BUILD__ - PLAYER STARTED');
    }, 5000);
  });
})();
