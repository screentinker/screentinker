// Render-blocking navigation primer. Loaded as a synchronous same-origin <script> in <head>, so it
// runs before the first paint. index.html ships the sidebar visible, and the router (app.js, a
// module script: it runs only after parsing AND every import) is what hides it for the login,
// reset, onboarding and similar screens, by which time the browser has already painted it: the
// sidebar flashed for ~10 frames on every visit to the login page.
//
// So the same decision is made here, before anything is drawn: <html> gets `nav-pending`, which
// hides the sidebar and the mobile menu button (main.css), whenever route() would hide them.
// route() removes the class where it shows the sidebar. ⚠️ ERR TOWARDS HIDING: a sidebar that
// appears a moment late is invisible to the user; one that flashes and vanishes is the bug.
//
// Mirrors route() in app.js. Keep the two in step: a route added there that hides the sidebar
// belongs here too.
(function () {
  try {
    var hash = location.hash || '#/';
    var token = localStorage.getItem('token');
    var user = null;
    try { user = JSON.parse(localStorage.getItem('user') || 'null'); } catch (e) { /* treat as no user */ }
    var hidden =
      !token
      || hash === '#/login' || hash.indexOf('#/login?') === 0
      || hash.indexOf('#/reset-password') === 0
      || hash === '#/onboarding'
      || hash === '#/change-password' || (user && user.must_change_password)
      || hash === '#/no-workspace'
      || hash.indexOf('#/accept-invite/') === 0;
    if (hidden) document.documentElement.classList.add('nav-pending');
  } catch (e) { /* storage blocked: the router decides, as it always did */ }
})();
