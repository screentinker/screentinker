(function () {
  try {
    var config = JSON.parse(localStorage.getItem('rd_web_player') || '{}');
    if (config.serverUrl) localStorage.setItem('rd_web_player', JSON.stringify(config));
  } catch (ignore) {}
  window.__STNative = {
    base: '',
    enabled: true
  };
})();
