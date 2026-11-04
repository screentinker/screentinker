(function (window) {
  'use strict';

  if (!window.Promise) {
    var Promise = function (executor) {
      var state = 0, value, handlers = [];
      function settle(nextState, nextValue) {
        if (state) return;
        state = nextState; value = nextValue;
        setTimeout(function () { while (handlers.length) handlers.shift()(); }, 0);
      }
      function resolve(nextValue) {
        if (nextValue && typeof nextValue.then === 'function') {
          return nextValue.then(resolve, reject);
        }
        settle(1, nextValue);
      }
      function reject(reason) { settle(2, reason); }
      this.then = function (onFulfilled, onRejected) {
        return new Promise(function (nextResolve, nextReject) {
          function handle() {
            var callback = state === 1 ? onFulfilled : onRejected;
            if (typeof callback !== 'function') return (state === 1 ? nextResolve : nextReject)(value);
            try { nextResolve(callback(value)); } catch (error) { nextReject(error); }
          }
          state ? setTimeout(handle, 0) : handlers.push(handle);
        });
      };
      this.catch = function (onRejected) { return this.then(null, onRejected); };
      try { executor(resolve, reject); } catch (error) { reject(error); }
    };
    Promise.resolve = function (value) { return new Promise(function (resolve) { resolve(value); }); };
    Promise.reject = function (reason) { return new Promise(function (_, reject) { reject(reason); }); };
    window.Promise = Promise;
  }

  if (!window.fetch) {
    window.fetch = function (url, options) {
      options = options || {};
      return new window.Promise(function (resolve, reject) {
        var request = new XMLHttpRequest();
        request.open(options.method || 'GET', url, true);
        var headers = options.headers || {};
        for (var name in headers) if (Object.prototype.hasOwnProperty.call(headers, name)) request.setRequestHeader(name, headers[name]);
        request.onreadystatechange = function () {
          if (request.readyState !== 4) return;
          var text = request.responseText;
          resolve({
            status: request.status,
            ok: request.status >= 200 && request.status < 300,
            text: function () { return window.Promise.resolve(text); },
            json: function () { try { return window.Promise.resolve(JSON.parse(text)); } catch (error) { return window.Promise.reject(error); } }
          });
        };
        request.onerror = function () { reject(new Error('Network request failed')); };
        request.send(options.body || null);
      });
    };
  }

  if (!window.URLSearchParams) {
    window.URLSearchParams = function (query) {
      var values = {};
      query = String(query || '').replace(/^\?/, '').split('&');
      for (var i = 0; i < query.length; i++) {
        if (!query[i]) continue;
        var pair = query[i].split('=');
        values[decodeURIComponent(pair[0].replace(/\+/g, ' '))] = decodeURIComponent((pair.slice(1).join('=') || '').replace(/\+/g, ' '));
      }
      this.get = function (name) { return Object.prototype.hasOwnProperty.call(values, name) ? values[name] : null; };
    };
  }

  if (!Array.from) Array.from = function (items) { return Array.prototype.slice.call(items); };
  if (!Object.assign) Object.assign = function (target) { for (var i = 1; i < arguments.length; i++) for (var key in arguments[i]) if (Object.prototype.hasOwnProperty.call(arguments[i], key)) target[key] = arguments[i][key]; return target; };
  if (!Number.isFinite) Number.isFinite = function (value) { return typeof value === 'number' && isFinite(value); };
  if (window.Element && !window.Element.prototype.remove) window.Element.prototype.remove = function () { if (this.parentNode) this.parentNode.removeChild(this); };
})(window);
