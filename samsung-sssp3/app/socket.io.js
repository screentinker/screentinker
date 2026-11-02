/*!
 * Socket.IO v4.8.3
 * (c) 2014-2025 Guillermo Rauch
 * Released under the MIT License.
 */
(function(global, factory) {
  typeof exports === "object" && typeof module !== "undefined" ? module.exports = factory() : typeof define === "function" && define.amd ? define(factory) : (global = typeof globalThis !== "undefined" ? globalThis : global || self, global.io = factory());
})(this, (function() {
  "use strict";
  function _arrayLikeToArray(r, a) {
    (null == a || a > r.length) && (a = r.length);
    for (var e = 0, n = Array(a); e < a; e++) n[e] = r[e];
    return n;
  }
  function _arrayWithoutHoles(r) {
    if (Array.isArray(r)) return _arrayLikeToArray(r);
  }
  function _construct(t, e, r) {
    if (_isNativeReflectConstruct()) return Reflect.construct.apply(null, arguments);
    var o = [null];
    o.push.apply(o, e);
    var p = new (t.bind.apply(t, o))();
    return r && _setPrototypeOf(p, r.prototype), p;
  }
  function _defineProperties(e, r) {
    for (var t = 0; t < r.length; t++) {
      var o = r[t];
      o.enumerable = o.enumerable || false, o.configurable = true, "value" in o && (o.writable = true), Object.defineProperty(e, _toPropertyKey(o.key), o);
    }
  }
  function _createClass(e, r, t) {
    return r && _defineProperties(e.prototype, r), t && _defineProperties(e, t), Object.defineProperty(e, "prototype", {
      writable: false
    }), e;
  }
  function _createForOfIteratorHelper(r, e) {
    var t = "undefined" != typeof Symbol && r[Symbol.iterator] || r["@@iterator"];
    if (!t) {
      if (Array.isArray(r) || (t = _unsupportedIterableToArray(r)) || e && r && "number" == typeof r.length) {
        t && (r = t);
        var n = 0, F = function() {
        };
        return {
          s: F,
          n: function() {
            return n >= r.length ? {
              done: true
            } : {
              done: false,
              value: r[n++]
            };
          },
          e: function(r2) {
            throw r2;
          },
          f: F
        };
      }
      throw new TypeError("Invalid attempt to iterate non-iterable instance.\nIn order to be iterable, non-array objects must have a [Symbol.iterator]() method.");
    }
    var o, a = true, u = false;
    return {
      s: function() {
        t = t.call(r);
      },
      n: function() {
        var r2 = t.next();
        return a = r2.done, r2;
      },
      e: function(r2) {
        u = true, o = r2;
      },
      f: function() {
        try {
          a || null == t.return || t.return();
        } finally {
          if (u) throw o;
        }
      }
    };
  }
  function _extends() {
    return _extends = Object.assign ? Object.assign.bind() : function(n) {
      for (var e = 1; e < arguments.length; e++) {
        var t = arguments[e];
        for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]);
      }
      return n;
    }, _extends.apply(null, arguments);
  }
  function _getPrototypeOf(t) {
    return _getPrototypeOf = Object.setPrototypeOf ? Object.getPrototypeOf.bind() : function(t2) {
      return t2.__proto__ || Object.getPrototypeOf(t2);
    }, _getPrototypeOf(t);
  }
  function _inheritsLoose(t, o) {
    t.prototype = Object.create(o.prototype), t.prototype.constructor = t, _setPrototypeOf(t, o);
  }
  function _isNativeFunction(t) {
    try {
      return -1 !== Function.toString.call(t).indexOf("[native code]");
    } catch (n) {
      return "function" == typeof t;
    }
  }
  function _isNativeReflectConstruct() {
    try {
      var t = !Boolean.prototype.valueOf.call(Reflect.construct(Boolean, [], function() {
      }));
    } catch (t2) {
    }
    return (_isNativeReflectConstruct = function() {
      return !!t;
    })();
  }
  function _iterableToArray(r) {
    if ("undefined" != typeof Symbol && null != r[Symbol.iterator] || null != r["@@iterator"]) return Array.from(r);
  }
  function _nonIterableSpread() {
    throw new TypeError("Invalid attempt to spread non-iterable instance.\nIn order to be iterable, non-array objects must have a [Symbol.iterator]() method.");
  }
  function _setPrototypeOf(t, e) {
    return _setPrototypeOf = Object.setPrototypeOf ? Object.setPrototypeOf.bind() : function(t2, e2) {
      return t2.__proto__ = e2, t2;
    }, _setPrototypeOf(t, e);
  }
  function _toConsumableArray(r) {
    return _arrayWithoutHoles(r) || _iterableToArray(r) || _unsupportedIterableToArray(r) || _nonIterableSpread();
  }
  function _toPrimitive(t, r) {
    if ("object" != typeof t || !t) return t;
    var e = t[Symbol.toPrimitive];
    if (void 0 !== e) {
      var i2 = e.call(t, r || "default");
      if ("object" != typeof i2) return i2;
      throw new TypeError("@@toPrimitive must return a primitive value.");
    }
    return ("string" === r ? String : Number)(t);
  }
  function _toPropertyKey(t) {
    var i2 = _toPrimitive(t, "string");
    return "symbol" == typeof i2 ? i2 : i2 + "";
  }
  function _typeof(o) {
    "@babel/helpers - typeof";
    return _typeof = "function" == typeof Symbol && "symbol" == typeof Symbol.iterator ? function(o2) {
      return typeof o2;
    } : function(o2) {
      return o2 && "function" == typeof Symbol && o2.constructor === Symbol && o2 !== Symbol.prototype ? "symbol" : typeof o2;
    }, _typeof(o);
  }
  function _unsupportedIterableToArray(r, a) {
    if (r) {
      if ("string" == typeof r) return _arrayLikeToArray(r, a);
      var t = {}.toString.call(r).slice(8, -1);
      return "Object" === t && r.constructor && (t = r.constructor.name), "Map" === t || "Set" === t ? Array.from(r) : "Arguments" === t || /^(?:Ui|I)nt(?:8|16|32)(?:Clamped)?Array$/.test(t) ? _arrayLikeToArray(r, a) : void 0;
    }
  }
  function _wrapNativeSuper(t) {
    var r = "function" == typeof Map ? /* @__PURE__ */ new Map() : void 0;
    return _wrapNativeSuper = function(t2) {
      if (null === t2 || !_isNativeFunction(t2)) return t2;
      if ("function" != typeof t2) throw new TypeError("Super expression must either be null or a function");
      if (void 0 !== r) {
        if (r.has(t2)) return r.get(t2);
        r.set(t2, Wrapper);
      }
      function Wrapper() {
        return _construct(t2, arguments, _getPrototypeOf(this).constructor);
      }
      return Wrapper.prototype = Object.create(t2.prototype, {
        constructor: {
          value: Wrapper,
          enumerable: false,
          writable: true,
          configurable: true
        }
      }), _setPrototypeOf(Wrapper, t2);
    }, _wrapNativeSuper(t);
  }
  var PACKET_TYPES = /* @__PURE__ */ Object.create(null);
  PACKET_TYPES["open"] = "0";
  PACKET_TYPES["close"] = "1";
  PACKET_TYPES["ping"] = "2";
  PACKET_TYPES["pong"] = "3";
  PACKET_TYPES["message"] = "4";
  PACKET_TYPES["upgrade"] = "5";
  PACKET_TYPES["noop"] = "6";
  var PACKET_TYPES_REVERSE = /* @__PURE__ */ Object.create(null);
  Object.keys(PACKET_TYPES).forEach(function(key) {
    PACKET_TYPES_REVERSE[PACKET_TYPES[key]] = key;
  });
  var ERROR_PACKET = {
    type: "error",
    data: "parser error"
  };
  var withNativeBlob$1 = typeof Blob === "function" || typeof Blob !== "undefined" && Object.prototype.toString.call(Blob) === "[object BlobConstructor]";
  var withNativeArrayBuffer$2 = typeof ArrayBuffer === "function";
  var isView$1 = function isView2(obj) {
    return typeof ArrayBuffer.isView === "function" ? ArrayBuffer.isView(obj) : obj && obj.buffer instanceof ArrayBuffer;
  };
  var encodePacket = function encodePacket2(_ref, supportsBinary, callback) {
    var type = _ref.type, data = _ref.data;
    if (withNativeBlob$1 && data instanceof Blob) {
      if (supportsBinary) {
        return callback(data);
      } else {
        return encodeBlobAsBase64(data, callback);
      }
    } else if (withNativeArrayBuffer$2 && (data instanceof ArrayBuffer || isView$1(data))) {
      if (supportsBinary) {
        return callback(data);
      } else {
        return encodeBlobAsBase64(new Blob([data]), callback);
      }
    }
    return callback(PACKET_TYPES[type] + (data || ""));
  };
  var encodeBlobAsBase64 = function encodeBlobAsBase642(data, callback) {
    var fileReader = new FileReader();
    fileReader.onload = function() {
      var content = fileReader.result.split(",")[1];
      callback("b" + (content || ""));
    };
    return fileReader.readAsDataURL(data);
  };
  function toArray(data) {
    if (data instanceof Uint8Array) {
      return data;
    } else if (data instanceof ArrayBuffer) {
      return new Uint8Array(data);
    } else {
      return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    }
  }
  var TEXT_ENCODER;
  function encodePacketToBinary(packet, callback) {
    if (withNativeBlob$1 && packet.data instanceof Blob) {
      return packet.data.arrayBuffer().then(toArray).then(callback);
    } else if (withNativeArrayBuffer$2 && (packet.data instanceof ArrayBuffer || isView$1(packet.data))) {
      return callback(toArray(packet.data));
    }
    encodePacket(packet, false, function(encoded) {
      if (!TEXT_ENCODER) {
        TEXT_ENCODER = new TextEncoder();
      }
      callback(TEXT_ENCODER.encode(encoded));
    });
  }
  var chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  var lookup$1 = typeof Uint8Array === "undefined" ? [] : new Uint8Array(256);
  for (var i = 0; i < chars.length; i++) {
    lookup$1[chars.charCodeAt(i)] = i;
  }
  var decode$1 = function decode2(base64) {
    var bufferLength = base64.length * 0.75, len = base64.length, i2, p = 0, encoded1, encoded2, encoded3, encoded4;
    if (base64[base64.length - 1] === "=") {
      bufferLength--;
      if (base64[base64.length - 2] === "=") {
        bufferLength--;
      }
    }
    var arraybuffer = new ArrayBuffer(bufferLength), bytes = new Uint8Array(arraybuffer);
    for (i2 = 0; i2 < len; i2 += 4) {
      encoded1 = lookup$1[base64.charCodeAt(i2)];
      encoded2 = lookup$1[base64.charCodeAt(i2 + 1)];
      encoded3 = lookup$1[base64.charCodeAt(i2 + 2)];
      encoded4 = lookup$1[base64.charCodeAt(i2 + 3)];
      bytes[p++] = encoded1 << 2 | encoded2 >> 4;
      bytes[p++] = (encoded2 & 15) << 4 | encoded3 >> 2;
      bytes[p++] = (encoded3 & 3) << 6 | encoded4 & 63;
    }
    return arraybuffer;
  };
  var withNativeArrayBuffer$1 = typeof ArrayBuffer === "function";
  var decodePacket = function decodePacket2(encodedPacket, binaryType) {
    if (typeof encodedPacket !== "string") {
      return {
        type: "message",
        data: mapBinary(encodedPacket, binaryType)
      };
    }
    var type = encodedPacket.charAt(0);
    if (type === "b") {
      return {
        type: "message",
        data: decodeBase64Packet(encodedPacket.substring(1), binaryType)
      };
    }
    var packetType = PACKET_TYPES_REVERSE[type];
    if (!packetType) {
      return ERROR_PACKET;
    }
    return encodedPacket.length > 1 ? {
      type: PACKET_TYPES_REVERSE[type],
      data: encodedPacket.substring(1)
    } : {
      type: PACKET_TYPES_REVERSE[type]
    };
  };
  var decodeBase64Packet = function decodeBase64Packet2(data, binaryType) {
    if (withNativeArrayBuffer$1) {
      var decoded = decode$1(data);
      return mapBinary(decoded, binaryType);
    } else {
      return {
        base64: true,
        data: data
      };
    }
  };
  var mapBinary = function mapBinary2(data, binaryType) {
    switch (binaryType) {
      case "blob":
        if (data instanceof Blob) {
          return data;
        } else {
          return new Blob([data]);
        }
      case "arraybuffer":
      default:
        if (data instanceof ArrayBuffer) {
          return data;
        } else {
          return data.buffer;
        }
    }
  };
  var SEPARATOR = String.fromCharCode(30);
  var encodePayload = function encodePayload2(packets, callback) {
    var length = packets.length;
    var encodedPackets = new Array(length);
    var count = 0;
    packets.forEach(function(packet, i2) {
      encodePacket(packet, false, function(encodedPacket) {
        encodedPackets[i2] = encodedPacket;
        if (++count === length) {
          callback(encodedPackets.join(SEPARATOR));
        }
      });
    });
  };
  var decodePayload = function decodePayload2(encodedPayload, binaryType) {
    var encodedPackets = encodedPayload.split(SEPARATOR);
    var packets = [];
    for (var i2 = 0; i2 < encodedPackets.length; i2++) {
      var decodedPacket = decodePacket(encodedPackets[i2], binaryType);
      packets.push(decodedPacket);
      if (decodedPacket.type === "error") {
        break;
      }
    }
    return packets;
  };
  function createPacketEncoderStream() {
    return new TransformStream({
      transform: function transform(packet, controller) {
        encodePacketToBinary(packet, function(encodedPacket) {
          var payloadLength = encodedPacket.length;
          var header;
          if (payloadLength < 126) {
            header = new Uint8Array(1);
            new DataView(header.buffer).setUint8(0, payloadLength);
          } else if (payloadLength < 65536) {
            header = new Uint8Array(3);
            var view = new DataView(header.buffer);
            view.setUint8(0, 126);
            view.setUint16(1, payloadLength);
          } else {
            header = new Uint8Array(9);
            var _view = new DataView(header.buffer);
            _view.setUint8(0, 127);
            _view.setBigUint64(1, BigInt(payloadLength));
          }
          if (packet.data && typeof packet.data !== "string") {
            header[0] |= 128;
          }
          controller.enqueue(header);
          controller.enqueue(encodedPacket);
        });
      }
    });
  }
  var TEXT_DECODER;
  function totalLength(chunks) {
    return chunks.reduce(function(acc, chunk) {
      return acc + chunk.length;
    }, 0);
  }
  function concatChunks(chunks, size) {
    if (chunks[0].length === size) {
      return chunks.shift();
    }
    var buffer = new Uint8Array(size);
    var j = 0;
    for (var i2 = 0; i2 < size; i2++) {
      buffer[i2] = chunks[0][j++];
      if (j === chunks[0].length) {
        chunks.shift();
        j = 0;
      }
    }
    if (chunks.length && j < chunks[0].length) {
      chunks[0] = chunks[0].slice(j);
    }
    return buffer;
  }
  function createPacketDecoderStream(maxPayload, binaryType) {
    if (!TEXT_DECODER) {
      TEXT_DECODER = new TextDecoder();
    }
    var chunks = [];
    var state = 0;
    var expectedLength = -1;
    var isBinary2 = false;
    return new TransformStream({
      transform: function transform(chunk, controller) {
        chunks.push(chunk);
        while (true) {
          if (state === 0) {
            if (totalLength(chunks) < 1) {
              break;
            }
            var header = concatChunks(chunks, 1);
            isBinary2 = (header[0] & 128) === 128;
            expectedLength = header[0] & 127;
            if (expectedLength < 126) {
              state = 3;
            } else if (expectedLength === 126) {
              state = 1;
            } else {
              state = 2;
            }
          } else if (state === 1) {
            if (totalLength(chunks) < 2) {
              break;
            }
            var headerArray = concatChunks(chunks, 2);
            expectedLength = new DataView(headerArray.buffer, headerArray.byteOffset, headerArray.length).getUint16(0);
            state = 3;
          } else if (state === 2) {
            if (totalLength(chunks) < 8) {
              break;
            }
            var _headerArray = concatChunks(chunks, 8);
            var view = new DataView(_headerArray.buffer, _headerArray.byteOffset, _headerArray.length);
            var n = view.getUint32(0);
            if (n > Math.pow(2, 53 - 32) - 1) {
              controller.enqueue(ERROR_PACKET);
              break;
            }
            expectedLength = n * Math.pow(2, 32) + view.getUint32(4);
            state = 3;
          } else {
            if (totalLength(chunks) < expectedLength) {
              break;
            }
            var data = concatChunks(chunks, expectedLength);
            controller.enqueue(decodePacket(isBinary2 ? data : TEXT_DECODER.decode(data), binaryType));
            state = 0;
          }
          if (expectedLength === 0 || expectedLength > maxPayload) {
            controller.enqueue(ERROR_PACKET);
            break;
          }
        }
      }
    });
  }
  var protocol$1 = 4;
  function Emitter(obj) {
    if (obj) return mixin(obj);
  }
  function mixin(obj) {
    for (var key in Emitter.prototype) {
      obj[key] = Emitter.prototype[key];
    }
    return obj;
  }
  Emitter.prototype.on = Emitter.prototype.addEventListener = function(event, fn) {
    this._callbacks = this._callbacks || {};
    (this._callbacks["$" + event] = this._callbacks["$" + event] || []).push(fn);
    return this;
  };
  Emitter.prototype.once = function(event, fn) {
    function on2() {
      this.off(event, on2);
      fn.apply(this, arguments);
    }
    on2.fn = fn;
    this.on(event, on2);
    return this;
  };
  Emitter.prototype.off = Emitter.prototype.removeListener = Emitter.prototype.removeAllListeners = Emitter.prototype.removeEventListener = function(event, fn) {
    this._callbacks = this._callbacks || {};
    if (0 == arguments.length) {
      this._callbacks = {};
      return this;
    }
    var callbacks = this._callbacks["$" + event];
    if (!callbacks) return this;
    if (1 == arguments.length) {
      delete this._callbacks["$" + event];
      return this;
    }
    var cb;
    for (var i2 = 0; i2 < callbacks.length; i2++) {
      cb = callbacks[i2];
      if (cb === fn || cb.fn === fn) {
        callbacks.splice(i2, 1);
        break;
      }
    }
    if (callbacks.length === 0) {
      delete this._callbacks["$" + event];
    }
    return this;
  };
  Emitter.prototype.emit = function(event) {
    this._callbacks = this._callbacks || {};
    var args = new Array(arguments.length - 1), callbacks = this._callbacks["$" + event];
    for (var i2 = 1; i2 < arguments.length; i2++) {
      args[i2 - 1] = arguments[i2];
    }
    if (callbacks) {
      callbacks = callbacks.slice(0);
      for (var i2 = 0, len = callbacks.length; i2 < len; ++i2) {
        callbacks[i2].apply(this, args);
      }
    }
    return this;
  };
  Emitter.prototype.emitReserved = Emitter.prototype.emit;
  Emitter.prototype.listeners = function(event) {
    this._callbacks = this._callbacks || {};
    return this._callbacks["$" + event] || [];
  };
  Emitter.prototype.hasListeners = function(event) {
    return !!this.listeners(event).length;
  };
  var nextTick = (function() {
    var isPromiseAvailable = typeof Promise === "function" && typeof Promise.resolve === "function";
    if (isPromiseAvailable) {
      return function(cb) {
        return Promise.resolve().then(cb);
      };
    } else {
      return function(cb, setTimeoutFn) {
        return setTimeoutFn(cb, 0);
      };
    }
  })();
  var globalThisShim = (function() {
    if (typeof self !== "undefined") {
      return self;
    } else if (typeof window !== "undefined") {
      return window;
    } else {
      return Function("return this")();
    }
  })();
  var defaultBinaryType = "arraybuffer";
  function createCookieJar() {
  }
  function pick(obj) {
    for (var _len = arguments.length, attr = new Array(_len > 1 ? _len - 1 : 0), _key = 1; _key < _len; _key++) {
      attr[_key - 1] = arguments[_key];
    }
    return attr.reduce(function(acc, k) {
      if (obj.hasOwnProperty(k)) {
        acc[k] = obj[k];
      }
      return acc;
    }, {});
  }
  var NATIVE_SET_TIMEOUT = globalThisShim.setTimeout;
  var NATIVE_CLEAR_TIMEOUT = globalThisShim.clearTimeout;
  function installTimerFunctions(obj, opts) {
    if (opts.useNativeTimers) {
      obj.setTimeoutFn = NATIVE_SET_TIMEOUT.bind(globalThisShim);
      obj.clearTimeoutFn = NATIVE_CLEAR_TIMEOUT.bind(globalThisShim);
    } else {
      obj.setTimeoutFn = globalThisShim.setTimeout.bind(globalThisShim);
      obj.clearTimeoutFn = globalThisShim.clearTimeout.bind(globalThisShim);
    }
  }
  var BASE64_OVERHEAD = 1.33;
  function byteLength(obj) {
    if (typeof obj === "string") {
      return utf8Length(obj);
    }
    return Math.ceil((obj.byteLength || obj.size) * BASE64_OVERHEAD);
  }
  function utf8Length(str) {
    var c = 0, length = 0;
    for (var i2 = 0, l = str.length; i2 < l; i2++) {
      c = str.charCodeAt(i2);
      if (c < 128) {
        length += 1;
      } else if (c < 2048) {
        length += 2;
      } else if (c < 55296 || c >= 57344) {
        length += 3;
      } else {
        i2++;
        length += 4;
      }
    }
    return length;
  }
  function randomString() {
    return Date.now().toString(36).substring(3) + Math.random().toString(36).substring(2, 5);
  }
  function encode(obj) {
    var str = "";
    for (var i2 in obj) {
      if (obj.hasOwnProperty(i2)) {
        if (str.length) str += "&";
        str += encodeURIComponent(i2) + "=" + encodeURIComponent(obj[i2]);
      }
    }
    return str;
  }
  function decode(qs) {
    var qry = {};
    var pairs = qs.split("&");
    for (var i2 = 0, l = pairs.length; i2 < l; i2++) {
      var pair = pairs[i2].split("=");
      qry[decodeURIComponent(pair[0])] = decodeURIComponent(pair[1]);
    }
    return qry;
  }
  var TransportError = /* @__PURE__ */ (function(_Error) {
    function TransportError2(reason, description, context) {
      var _this;
      _this = _Error.call(this, reason) || this;
      _this.description = description;
      _this.context = context;
      _this.type = "TransportError";
      return _this;
    }
    _inheritsLoose(TransportError2, _Error);
    return TransportError2;
  })(/* @__PURE__ */ _wrapNativeSuper(Error));
  var Transport = /* @__PURE__ */ (function(_Emitter) {
    function Transport2(opts) {
      var _this2;
      _this2 = _Emitter.call(this) || this;
      _this2.writable = false;
      installTimerFunctions(_this2, opts);
      _this2.opts = opts;
      _this2.query = opts.query;
      _this2.socket = opts.socket;
      _this2.supportsBinary = !opts.forceBase64;
      return _this2;
    }
    _inheritsLoose(Transport2, _Emitter);
    var _proto = Transport2.prototype;
    _proto.onError = function onError(reason, description, context) {
      _Emitter.prototype.emitReserved.call(this, "error", new TransportError(reason, description, context));
      return this;
    };
    _proto.open = function open() {
      this.readyState = "opening";
      this.doOpen();
      return this;
    };
    _proto.close = function close() {
      if (this.readyState === "opening" || this.readyState === "open") {
        this.doClose();
        this.onClose();
      }
      return this;
    };
    _proto.send = function send(packets) {
      if (this.readyState === "open") {
        this.write(packets);
      }
    };
    _proto.onOpen = function onOpen() {
      this.readyState = "open";
      this.writable = true;
      _Emitter.prototype.emitReserved.call(this, "open");
    };
    _proto.onData = function onData(data) {
      var packet = decodePacket(data, this.socket.binaryType);
      this.onPacket(packet);
    };
    _proto.onPacket = function onPacket(packet) {
      _Emitter.prototype.emitReserved.call(this, "packet", packet);
    };
    _proto.onClose = function onClose(details) {
      this.readyState = "closed";
      _Emitter.prototype.emitReserved.call(this, "close", details);
    };
    _proto.pause = function pause(onPause) {
    };
    _proto.createUri = function createUri(schema) {
      var query = arguments.length > 1 && arguments[1] !== void 0 ? arguments[1] : {};
      return schema + "://" + this._hostname() + this._port() + this.opts.path + this._query(query);
    };
    _proto._hostname = function _hostname() {
      var hostname = this.opts.hostname;
      return hostname.indexOf(":") === -1 ? hostname : "[" + hostname + "]";
    };
    _proto._port = function _port() {
      if (this.opts.port && (this.opts.secure && Number(this.opts.port) !== 443 || !this.opts.secure && Number(this.opts.port) !== 80)) {
        return ":" + this.opts.port;
      } else {
        return "";
      }
    };
    _proto._query = function _query(query) {
      var encodedQuery = encode(query);
      return encodedQuery.length ? "?" + encodedQuery : "";
    };
    return Transport2;
  })(Emitter);
  var Polling = /* @__PURE__ */ (function(_Transport) {
    function Polling2() {
      var _this;
      _this = _Transport.apply(this, arguments) || this;
      _this._polling = false;
      return _this;
    }
    _inheritsLoose(Polling2, _Transport);
    var _proto = Polling2.prototype;
    _proto.doOpen = function doOpen() {
      this._poll();
    };
    _proto.pause = function pause(onPause) {
      var _this2 = this;
      this.readyState = "pausing";
      var pause2 = function pause3() {
        _this2.readyState = "paused";
        onPause();
      };
      if (this._polling || !this.writable) {
        var total = 0;
        if (this._polling) {
          total++;
          this.once("pollComplete", function() {
            --total || pause2();
          });
        }
        if (!this.writable) {
          total++;
          this.once("drain", function() {
            --total || pause2();
          });
        }
      } else {
        pause2();
      }
    };
    _proto._poll = function _poll() {
      this._polling = true;
      this.doPoll();
      this.emitReserved("poll");
    };
    _proto.onData = function onData(data) {
      var _this3 = this;
      var callback = function callback2(packet) {
        if ("opening" === _this3.readyState && packet.type === "open") {
          _this3.onOpen();
        }
        if ("close" === packet.type) {
          _this3.onClose({
            description: "transport closed by the server"
          });
          return false;
        }
        _this3.onPacket(packet);
      };
      decodePayload(data, this.socket.binaryType).forEach(callback);
      if ("closed" !== this.readyState) {
        this._polling = false;
        this.emitReserved("pollComplete");
        if ("open" === this.readyState) {
          this._poll();
        }
      }
    };
    _proto.doClose = function doClose() {
      var _this4 = this;
      var close = function close2() {
        _this4.write([{
          type: "close"
        }]);
      };
      if ("open" === this.readyState) {
        close();
      } else {
        this.once("open", close);
      }
    };
    _proto.write = function write(packets) {
      var _this5 = this;
      this.writable = false;
      encodePayload(packets, function(data) {
        _this5.doWrite(data, function() {
          _this5.writable = true;
          _this5.emitReserved("drain");
        });
      });
    };
    _proto.uri = function uri() {
      var schema = this.opts.secure ? "https" : "http";
      var query = this.query || {};
      if (false !== this.opts.timestampRequests) {
        query[this.opts.timestampParam] = randomString();
      }
      if (!this.supportsBinary && !query.sid) {
        query.b64 = 1;
      }
      return this.createUri(schema, query);
    };
    return _createClass(Polling2, [{
      key: "name",
      get: function get() {
        return "polling";
      }
    }]);
  })(Transport);
  var value = false;
  try {
    value = typeof XMLHttpRequest !== "undefined" && "withCredentials" in new XMLHttpRequest();
  } catch (err) {
  }
  var hasCORS = value;
  function empty() {
  }
  var BaseXHR = /* @__PURE__ */ (function(_Polling) {
    function BaseXHR2(opts) {
      var _this;
      _this = _Polling.call(this, opts) || this;
      if (typeof location !== "undefined") {
        var isSSL = "https:" === location.protocol;
        var port = location.port;
        if (!port) {
          port = isSSL ? "443" : "80";
        }
        _this.xd = typeof location !== "undefined" && opts.hostname !== location.hostname || port !== opts.port;
      }
      return _this;
    }
    _inheritsLoose(BaseXHR2, _Polling);
    var _proto = BaseXHR2.prototype;
    _proto.doWrite = function doWrite(data, fn) {
      var _this2 = this;
      var req = this.request({
        method: "POST",
        data: data
      });
      req.on("success", fn);
      req.on("error", function(xhrStatus, context) {
        _this2.onError("xhr post error", xhrStatus, context);
      });
    };
    _proto.doPoll = function doPoll() {
      var _this3 = this;
      var req = this.request();
      req.on("data", this.onData.bind(this));
      req.on("error", function(xhrStatus, context) {
        _this3.onError("xhr poll error", xhrStatus, context);
      });
      this.pollXhr = req;
    };
    return BaseXHR2;
  })(Polling);
  var Request = /* @__PURE__ */ (function(_Emitter) {
    function Request2(createRequest, uri, opts) {
      var _this4;
      _this4 = _Emitter.call(this) || this;
      _this4.createRequest = createRequest;
      installTimerFunctions(_this4, opts);
      _this4._opts = opts;
      _this4._method = opts.method || "GET";
      _this4._uri = uri;
      _this4._data = void 0 !== opts.data ? opts.data : null;
      _this4._create();
      return _this4;
    }
    _inheritsLoose(Request2, _Emitter);
    var _proto2 = Request2.prototype;
    _proto2._create = function _create() {
      var _this5 = this;
      var _a;
      var opts = pick(this._opts, "agent", "pfx", "key", "passphrase", "cert", "ca", "ciphers", "rejectUnauthorized", "autoUnref");
      opts.xdomain = !!this._opts.xd;
      var xhr = this._xhr = this.createRequest(opts);
      try {
        xhr.open(this._method, this._uri, true);
        try {
          if (this._opts.extraHeaders) {
            xhr.setDisableHeaderCheck && xhr.setDisableHeaderCheck(true);
            for (var i2 in this._opts.extraHeaders) {
              if (this._opts.extraHeaders.hasOwnProperty(i2)) {
                xhr.setRequestHeader(i2, this._opts.extraHeaders[i2]);
              }
            }
          }
        } catch (e) {
        }
        if ("POST" === this._method) {
          try {
            xhr.setRequestHeader("Content-type", "text/plain;charset=UTF-8");
          } catch (e) {
          }
        }
        try {
          xhr.setRequestHeader("Accept", "*/*");
        } catch (e) {
        }
        (_a = this._opts.cookieJar) === null || _a === void 0 ? void 0 : _a.addCookies(xhr);
        if ("withCredentials" in xhr) {
          xhr.withCredentials = this._opts.withCredentials;
        }
        if (this._opts.requestTimeout) {
          xhr.timeout = this._opts.requestTimeout;
        }
        xhr.onreadystatechange = function() {
          var _a2;
          if (xhr.readyState === 3) {
            (_a2 = _this5._opts.cookieJar) === null || _a2 === void 0 ? void 0 : _a2.parseCookies(
              // @ts-ignore
              xhr.getResponseHeader("set-cookie")
            );
          }
          if (4 !== xhr.readyState) return;
          if (200 === xhr.status || 1223 === xhr.status) {
            _this5._onLoad();
          } else {
            _this5.setTimeoutFn(function() {
              _this5._onError(typeof xhr.status === "number" ? xhr.status : 0);
            }, 0);
          }
        };
        xhr.send(this._data);
      } catch (e) {
        this.setTimeoutFn(function() {
          _this5._onError(e);
        }, 0);
        return;
      }
      if (typeof document !== "undefined") {
        this._index = Request2.requestsCount++;
        Request2.requests[this._index] = this;
      }
    };
    _proto2._onError = function _onError(err) {
      this.emitReserved("error", err, this._xhr);
      this._cleanup(true);
    };
    _proto2._cleanup = function _cleanup(fromError) {
      if ("undefined" === typeof this._xhr || null === this._xhr) {
        return;
      }
      this._xhr.onreadystatechange = empty;
      if (fromError) {
        try {
          this._xhr.abort();
        } catch (e) {
        }
      }
      if (typeof document !== "undefined") {
        delete Request2.requests[this._index];
      }
      this._xhr = null;
    };
    _proto2._onLoad = function _onLoad() {
      var data = this._xhr.responseText;
      if (data !== null) {
        this.emitReserved("data", data);
        this.emitReserved("success");
        this._cleanup();
      }
    };
    _proto2.abort = function abort() {
      this._cleanup();
    };
    return Request2;
  })(Emitter);
  Request.requestsCount = 0;
  Request.requests = {};
  if (typeof document !== "undefined") {
    if (typeof attachEvent === "function") {
      attachEvent("onunload", unloadHandler);
    } else if (typeof addEventListener === "function") {
      var terminationEvent = "onpagehide" in globalThisShim ? "pagehide" : "unload";
      addEventListener(terminationEvent, unloadHandler, false);
    }
  }
  function unloadHandler() {
    for (var i2 in Request.requests) {
      if (Request.requests.hasOwnProperty(i2)) {
        Request.requests[i2].abort();
      }
    }
  }
  var hasXHR2 = (function() {
    var xhr = newRequest({
      xdomain: false
    });
    return xhr && xhr.responseType !== null;
  })();
  var XHR = /* @__PURE__ */ (function(_BaseXHR) {
    function XHR2(opts) {
      var _this6;
      _this6 = _BaseXHR.call(this, opts) || this;
      var forceBase64 = opts && opts.forceBase64;
      _this6.supportsBinary = hasXHR2 && !forceBase64;
      return _this6;
    }
    _inheritsLoose(XHR2, _BaseXHR);
    var _proto3 = XHR2.prototype;
    _proto3.request = function request() {
      var opts = arguments.length > 0 && arguments[0] !== void 0 ? arguments[0] : {};
      _extends(opts, {
        xd: this.xd
      }, this.opts);
      return new Request(newRequest, this.uri(), opts);
    };
    return XHR2;
  })(BaseXHR);
  function newRequest(opts) {
    var xdomain = opts.xdomain;
    try {
      if ("undefined" !== typeof XMLHttpRequest && (!xdomain || hasCORS)) {
        return new XMLHttpRequest();
      }
    } catch (e) {
    }
    if (!xdomain) {
      try {
        return new globalThisShim[["Active"].concat("Object").join("X")]("Microsoft.XMLHTTP");
      } catch (e) {
      }
    }
  }
  var isReactNative = typeof navigator !== "undefined" && typeof navigator.product === "string" && navigator.product.toLowerCase() === "reactnative";
  var BaseWS = /* @__PURE__ */ (function(_Transport) {
    function BaseWS2() {
      return _Transport.apply(this, arguments) || this;
    }
    _inheritsLoose(BaseWS2, _Transport);
    var _proto = BaseWS2.prototype;
    _proto.doOpen = function doOpen() {
      var uri = this.uri();
      var protocols = this.opts.protocols;
      var opts = isReactNative ? {} : pick(this.opts, "agent", "perMessageDeflate", "pfx", "key", "passphrase", "cert", "ca", "ciphers", "rejectUnauthorized", "localAddress", "protocolVersion", "origin", "maxPayload", "family", "checkServerIdentity");
      if (this.opts.extraHeaders) {
        opts.headers = this.opts.extraHeaders;
      }
      try {
        this.ws = this.createSocket(uri, protocols, opts);
      } catch (err) {
        return this.emitReserved("error", err);
      }
      this.ws.binaryType = this.socket.binaryType;
      this.addEventListeners();
    };
    _proto.addEventListeners = function addEventListeners() {
      var _this = this;
      this.ws.onopen = function() {
        if (_this.opts.autoUnref) {
          _this.ws._socket.unref();
        }
        _this.onOpen();
      };
      this.ws.onclose = function(closeEvent) {
        return _this.onClose({
          description: "websocket connection closed",
          context: closeEvent
        });
      };
      this.ws.onmessage = function(ev) {
        return _this.onData(ev.data);
      };
      this.ws.onerror = function(e) {
        return _this.onError("websocket error", e);
      };
    };
    _proto.write = function write(packets) {
      var _this2 = this;
      this.writable = false;
      var _loop = function _loop2() {
        var packet = packets[i2];
        var lastPacket = i2 === packets.length - 1;
        encodePacket(packet, _this2.supportsBinary, function(data) {
          try {
            _this2.doWrite(packet, data);
          } catch (e) {
          }
          if (lastPacket) {
            nextTick(function() {
              _this2.writable = true;
              _this2.emitReserved("drain");
            }, _this2.setTimeoutFn);
          }
        });
      };
      for (var i2 = 0; i2 < packets.length; i2++) {
        _loop();
      }
    };
    _proto.doClose = function doClose() {
      if (typeof this.ws !== "undefined") {
        this.ws.onerror = function() {
        };
        this.ws.close();
        this.ws = null;
      }
    };
    _proto.uri = function uri() {
      var schema = this.opts.secure ? "wss" : "ws";
      var query = this.query || {};
      if (this.opts.timestampRequests) {
        query[this.opts.timestampParam] = randomString();
      }
      if (!this.supportsBinary) {
        query.b64 = 1;
      }
      return this.createUri(schema, query);
    };
    return _createClass(BaseWS2, [{
      key: "name",
      get: function get() {
        return "websocket";
      }
    }]);
  })(Transport);
  var WebSocketCtor = globalThisShim.WebSocket || globalThisShim.MozWebSocket;
  var WS = /* @__PURE__ */ (function(_BaseWS) {
    function WS2() {
      return _BaseWS.apply(this, arguments) || this;
    }
    _inheritsLoose(WS2, _BaseWS);
    var _proto2 = WS2.prototype;
    _proto2.createSocket = function createSocket(uri, protocols, opts) {
      return !isReactNative ? protocols ? new WebSocketCtor(uri, protocols) : new WebSocketCtor(uri) : new WebSocketCtor(uri, protocols, opts);
    };
    _proto2.doWrite = function doWrite(_packet, data) {
      this.ws.send(data);
    };
    return WS2;
  })(BaseWS);
  var WT = /* @__PURE__ */ (function(_Transport) {
    function WT2() {
      return _Transport.apply(this, arguments) || this;
    }
    _inheritsLoose(WT2, _Transport);
    var _proto = WT2.prototype;
    _proto.doOpen = function doOpen() {
      var _this = this;
      try {
        this._transport = new WebTransport(this.createUri("https"), this.opts.transportOptions[this.name]);
      } catch (err) {
        return this.emitReserved("error", err);
      }
      this._transport.closed.then(function() {
        _this.onClose();
      })["catch"](function(err) {
        _this.onError("webtransport error", err);
      });
      this._transport.ready.then(function() {
        _this._transport.createBidirectionalStream().then(function(stream) {
          var decoderStream = createPacketDecoderStream(Number.MAX_SAFE_INTEGER, _this.socket.binaryType);
          var reader = stream.readable.pipeThrough(decoderStream).getReader();
          var encoderStream = createPacketEncoderStream();
          encoderStream.readable.pipeTo(stream.writable);
          _this._writer = encoderStream.writable.getWriter();
          var read = function read2() {
            reader.read().then(function(_ref) {
              var done = _ref.done, value2 = _ref.value;
              if (done) {
                return;
              }
              _this.onPacket(value2);
              read2();
            })["catch"](function(err) {
            });
          };
          read();
          var packet = {
            type: "open"
          };
          if (_this.query.sid) {
            packet.data = '{"sid":"'.concat(_this.query.sid, '"}');
          }
          _this._writer.write(packet).then(function() {
            return _this.onOpen();
          });
        });
      });
    };
    _proto.write = function write(packets) {
      var _this2 = this;
      this.writable = false;
      var _loop = function _loop2() {
        var packet = packets[i2];
        var lastPacket = i2 === packets.length - 1;
        _this2._writer.write(packet).then(function() {
          if (lastPacket) {
            nextTick(function() {
              _this2.writable = true;
              _this2.emitReserved("drain");
            }, _this2.setTimeoutFn);
          }
        });
      };
      for (var i2 = 0; i2 < packets.length; i2++) {
        _loop();
      }
    };
    _proto.doClose = function doClose() {
      var _a;
      (_a = this._transport) === null || _a === void 0 ? void 0 : _a.close();
    };
    return _createClass(WT2, [{
      key: "name",
      get: function get() {
        return "webtransport";
      }
    }]);
  })(Transport);
  var transports = {
    websocket: WS,
    webtransport: WT,
    polling: XHR
  };
  var re = /^(?:(?![^:@\/?#]+:[^:@\/]*@)(http|https|ws|wss):\/\/)?((?:(([^:@\/?#]*)(?::([^:@\/?#]*))?)?@)?((?:[a-f0-9]{0,4}:){2,7}[a-f0-9]{0,4}|[^:\/?#]*)(?::(\d*))?)(((\/(?:[^?#](?![^?#\/]*\.[^?#\/.]+(?:[?#]|$)))*\/?)?([^?#\/]*))(?:\?([^#]*))?(?:#(.*))?)/;
  var parts = ["source", "protocol", "authority", "userInfo", "user", "password", "host", "port", "relative", "path", "directory", "file", "query", "anchor"];
  function parse(str) {
    if (str.length > 8e3) {
      throw "URI too long";
    }
    var src = str, b = str.indexOf("["), e = str.indexOf("]");
    if (b != -1 && e != -1) {
      str = str.substring(0, b) + str.substring(b, e).replace(/:/g, ";") + str.substring(e, str.length);
    }
    var m = re.exec(str || ""), uri = {}, i2 = 14;
    while (i2--) {
      uri[parts[i2]] = m[i2] || "";
    }
    if (b != -1 && e != -1) {
      uri.source = src;
      uri.host = uri.host.substring(1, uri.host.length - 1).replace(/;/g, ":");
      uri.authority = uri.authority.replace("[", "").replace("]", "").replace(/;/g, ":");
      uri.ipv6uri = true;
    }
    uri.pathNames = pathNames(uri, uri["path"]);
    uri.queryKey = queryKey(uri, uri["query"]);
    return uri;
  }
  function pathNames(obj, path) {
    var regx = /\/{2,9}/g, names = path.replace(regx, "/").split("/");
    if (path.slice(0, 1) == "/" || path.length === 0) {
      names.splice(0, 1);
    }
    if (path.slice(-1) == "/") {
      names.splice(names.length - 1, 1);
    }
    return names;
  }
  function queryKey(uri, query) {
    var data = {};
    query.replace(/(?:^|&)([^&=]*)=?([^&]*)/g, function($0, $1, $2) {
      if ($1) {
        data[$1] = $2;
      }
    });
    return data;
  }
  var withEventListeners = typeof addEventListener === "function" && typeof removeEventListener === "function";
  var OFFLINE_EVENT_LISTENERS = [];
  if (withEventListeners) {
    addEventListener("offline", function() {
      OFFLINE_EVENT_LISTENERS.forEach(function(listener) {
        return listener();
      });
    }, false);
  }
  var SocketWithoutUpgrade = /* @__PURE__ */ (function(_Emitter) {
    function SocketWithoutUpgrade2(uri, opts) {
      var _this;
      _this = _Emitter.call(this) || this;
      _this.binaryType = defaultBinaryType;
      _this.writeBuffer = [];
      _this._prevBufferLen = 0;
      _this._pingInterval = -1;
      _this._pingTimeout = -1;
      _this._maxPayload = -1;
      _this._pingTimeoutTime = Infinity;
      if (uri && "object" === _typeof(uri)) {
        opts = uri;
        uri = null;
      }
      if (uri) {
        var parsedUri = parse(uri);
        opts.hostname = parsedUri.host;
        opts.secure = parsedUri.protocol === "https" || parsedUri.protocol === "wss";
        opts.port = parsedUri.port;
        if (parsedUri.query) opts.query = parsedUri.query;
      } else if (opts.host) {
        opts.hostname = parse(opts.host).host;
      }
      installTimerFunctions(_this, opts);
      _this.secure = null != opts.secure ? opts.secure : typeof location !== "undefined" && "https:" === location.protocol;
      if (opts.hostname && !opts.port) {
        opts.port = _this.secure ? "443" : "80";
      }
      _this.hostname = opts.hostname || (typeof location !== "undefined" ? location.hostname : "localhost");
      _this.port = opts.port || (typeof location !== "undefined" && location.port ? location.port : _this.secure ? "443" : "80");
      _this.transports = [];
      _this._transportsByName = {};
      opts.transports.forEach(function(t) {
        var transportName = t.prototype.name;
        _this.transports.push(transportName);
        _this._transportsByName[transportName] = t;
      });
      _this.opts = _extends({
        path: "/engine.io",
        agent: false,
        withCredentials: false,
        upgrade: true,
        timestampParam: "t",
        rememberUpgrade: false,
        addTrailingSlash: true,
        rejectUnauthorized: true,
        perMessageDeflate: {
          threshold: 1024
        },
        transportOptions: {},
        closeOnBeforeunload: false
      }, opts);
      _this.opts.path = _this.opts.path.replace(/\/$/, "") + (_this.opts.addTrailingSlash ? "/" : "");
      if (typeof _this.opts.query === "string") {
        _this.opts.query = decode(_this.opts.query);
      }
      if (withEventListeners) {
        if (_this.opts.closeOnBeforeunload) {
          _this._beforeunloadEventListener = function() {
            if (_this.transport) {
              _this.transport.removeAllListeners();
              _this.transport.close();
            }
          };
          addEventListener("beforeunload", _this._beforeunloadEventListener, false);
        }
        if (_this.hostname !== "localhost") {
          _this._offlineEventListener = function() {
            _this._onClose("transport close", {
              description: "network connection lost"
            });
          };
          OFFLINE_EVENT_LISTENERS.push(_this._offlineEventListener);
        }
      }
      if (_this.opts.withCredentials) {
        _this._cookieJar = createCookieJar();
      }
      _this._open();
      return _this;
    }
    _inheritsLoose(SocketWithoutUpgrade2, _Emitter);
    var _proto = SocketWithoutUpgrade2.prototype;
    _proto.createTransport = function createTransport(name) {
      var query = _extends({}, this.opts.query);
      query.EIO = protocol$1;
      query.transport = name;
      if (this.id) query.sid = this.id;
      var opts = _extends({}, this.opts, {
        query: query,
        socket: this,
        hostname: this.hostname,
        secure: this.secure,
        port: this.port
      }, this.opts.transportOptions[name]);
      return new this._transportsByName[name](opts);
    };
    _proto._open = function _open() {
      var _this2 = this;
      if (this.transports.length === 0) {
        this.setTimeoutFn(function() {
          _this2.emitReserved("error", "No transports available");
        }, 0);
        return;
      }
      var transportName = this.opts.rememberUpgrade && SocketWithoutUpgrade2.priorWebsocketSuccess && this.transports.indexOf("websocket") !== -1 ? "websocket" : this.transports[0];
      this.readyState = "opening";
      var transport = this.createTransport(transportName);
      transport.open();
      this.setTransport(transport);
    };
    _proto.setTransport = function setTransport(transport) {
      var _this3 = this;
      if (this.transport) {
        this.transport.removeAllListeners();
      }
      this.transport = transport;
      transport.on("drain", this._onDrain.bind(this)).on("packet", this._onPacket.bind(this)).on("error", this._onError.bind(this)).on("close", function(reason) {
        return _this3._onClose("transport close", reason);
      });
    };
    _proto.onOpen = function onOpen() {
      this.readyState = "open";
      SocketWithoutUpgrade2.priorWebsocketSuccess = "websocket" === this.transport.name;
      this.emitReserved("open");
      this.flush();
    };
    _proto._onPacket = function _onPacket(packet) {
      if ("opening" === this.readyState || "open" === this.readyState || "closing" === this.readyState) {
        this.emitReserved("packet", packet);
        this.emitReserved("heartbeat");
        switch (packet.type) {
          case "open":
            this.onHandshake(JSON.parse(packet.data));
            break;
          case "ping":
            this._sendPacket("pong");
            this.emitReserved("ping");
            this.emitReserved("pong");
            this._resetPingTimeout();
            break;
          case "error":
            var err = new Error("server error");
            err.code = packet.data;
            this._onError(err);
            break;
          case "message":
            this.emitReserved("data", packet.data);
            this.emitReserved("message", packet.data);
            break;
        }
      }
    };
    _proto.onHandshake = function onHandshake(data) {
      this.emitReserved("handshake", data);
      this.id = data.sid;
      this.transport.query.sid = data.sid;
      this._pingInterval = data.pingInterval;
      this._pingTimeout = data.pingTimeout;
      this._maxPayload = data.maxPayload;
      this.onOpen();
      if ("closed" === this.readyState) return;
      this._resetPingTimeout();
    };
    _proto._resetPingTimeout = function _resetPingTimeout() {
      var _this4 = this;
      this.clearTimeoutFn(this._pingTimeoutTimer);
      var delay = this._pingInterval + this._pingTimeout;
      this._pingTimeoutTime = Date.now() + delay;
      this._pingTimeoutTimer = this.setTimeoutFn(function() {
        _this4._onClose("ping timeout");
      }, delay);
      if (this.opts.autoUnref) {
        this._pingTimeoutTimer.unref();
      }
    };
    _proto._onDrain = function _onDrain() {
      this.writeBuffer.splice(0, this._prevBufferLen);
      this._prevBufferLen = 0;
      if (0 === this.writeBuffer.length) {
        this.emitReserved("drain");
      } else {
        this.flush();
      }
    };
    _proto.flush = function flush() {
      if ("closed" !== this.readyState && this.transport.writable && !this.upgrading && this.writeBuffer.length) {
        var packets = this._getWritablePackets();
        this.transport.send(packets);
        this._prevBufferLen = packets.length;
        this.emitReserved("flush");
      }
    };
    _proto._getWritablePackets = function _getWritablePackets() {
      var shouldCheckPayloadSize = this._maxPayload && this.transport.name === "polling" && this.writeBuffer.length > 1;
      if (!shouldCheckPayloadSize) {
        return this.writeBuffer;
      }
      var payloadSize = 1;
      for (var i2 = 0; i2 < this.writeBuffer.length; i2++) {
        var data = this.writeBuffer[i2].data;
        if (data) {
          payloadSize += byteLength(data);
        }
        if (i2 > 0 && payloadSize > this._maxPayload) {
          return this.writeBuffer.slice(0, i2);
        }
        payloadSize += 2;
      }
      return this.writeBuffer;
    };
    _proto._hasPingExpired = function _hasPingExpired() {
      var _this5 = this;
      if (!this._pingTimeoutTime) return true;
      var hasExpired = Date.now() > this._pingTimeoutTime;
      if (hasExpired) {
        this._pingTimeoutTime = 0;
        nextTick(function() {
          _this5._onClose("ping timeout");
        }, this.setTimeoutFn);
      }
      return hasExpired;
    };
    _proto.write = function write(msg, options, fn) {
      this._sendPacket("message", msg, options, fn);
      return this;
    };
    _proto.send = function send(msg, options, fn) {
      this._sendPacket("message", msg, options, fn);
      return this;
    };
    _proto._sendPacket = function _sendPacket(type, data, options, fn) {
      if ("function" === typeof data) {
        fn = data;
        data = void 0;
      }
      if ("function" === typeof options) {
        fn = options;
        options = null;
      }
      if ("closing" === this.readyState || "closed" === this.readyState) {
        return;
      }
      options = options || {};
      options.compress = false !== options.compress;
      var packet = {
        type: type,
        data: data,
        options: options
      };
      this.emitReserved("packetCreate", packet);
      this.writeBuffer.push(packet);
      if (fn) this.once("flush", fn);
      this.flush();
    };
    _proto.close = function close() {
      var _this6 = this;
      var close2 = function close3() {
        _this6._onClose("forced close");
        _this6.transport.close();
      };
      var cleanupAndClose = function cleanupAndClose2() {
        _this6.off("upgrade", cleanupAndClose2);
        _this6.off("upgradeError", cleanupAndClose2);
        close2();
      };
      var waitForUpgrade = function waitForUpgrade2() {
        _this6.once("upgrade", cleanupAndClose);
        _this6.once("upgradeError", cleanupAndClose);
      };
      if ("opening" === this.readyState || "open" === this.readyState) {
        this.readyState = "closing";
        if (this.writeBuffer.length) {
          this.once("drain", function() {
            if (_this6.upgrading) {
              waitForUpgrade();
            } else {
              close2();
            }
          });
        } else if (this.upgrading) {
          waitForUpgrade();
        } else {
          close2();
        }
      }
      return this;
    };
    _proto._onError = function _onError(err) {
      SocketWithoutUpgrade2.priorWebsocketSuccess = false;
      if (this.opts.tryAllTransports && this.transports.length > 1 && this.readyState === "opening") {
        this.transports.shift();
        return this._open();
      }
      this.emitReserved("error", err);
      this._onClose("transport error", err);
    };
    _proto._onClose = function _onClose(reason, description) {
      if ("opening" === this.readyState || "open" === this.readyState || "closing" === this.readyState) {
        this.clearTimeoutFn(this._pingTimeoutTimer);
        this.transport.removeAllListeners("close");
        this.transport.close();
        this.transport.removeAllListeners();
        if (withEventListeners) {
          if (this._beforeunloadEventListener) {
            removeEventListener("beforeunload", this._beforeunloadEventListener, false);
          }
          if (this._offlineEventListener) {
            var i2 = OFFLINE_EVENT_LISTENERS.indexOf(this._offlineEventListener);
            if (i2 !== -1) {
              OFFLINE_EVENT_LISTENERS.splice(i2, 1);
            }
          }
        }
        this.readyState = "closed";
        this.id = null;
        this.emitReserved("close", reason, description);
        this.writeBuffer = [];
        this._prevBufferLen = 0;
      }
    };
    return SocketWithoutUpgrade2;
  })(Emitter);
  SocketWithoutUpgrade.protocol = protocol$1;
  var SocketWithUpgrade = /* @__PURE__ */ (function(_SocketWithoutUpgrade) {
    function SocketWithUpgrade2() {
      var _this7;
      _this7 = _SocketWithoutUpgrade.apply(this, arguments) || this;
      _this7._upgrades = [];
      return _this7;
    }
    _inheritsLoose(SocketWithUpgrade2, _SocketWithoutUpgrade);
    var _proto2 = SocketWithUpgrade2.prototype;
    _proto2.onOpen = function onOpen() {
      _SocketWithoutUpgrade.prototype.onOpen.call(this);
      if ("open" === this.readyState && this.opts.upgrade) {
        for (var i2 = 0; i2 < this._upgrades.length; i2++) {
          this._probe(this._upgrades[i2]);
        }
      }
    };
    _proto2._probe = function _probe(name) {
      var _this8 = this;
      var transport = this.createTransport(name);
      var failed = false;
      SocketWithoutUpgrade.priorWebsocketSuccess = false;
      var onTransportOpen = function onTransportOpen2() {
        if (failed) return;
        transport.send([{
          type: "ping",
          data: "probe"
        }]);
        transport.once("packet", function(msg) {
          if (failed) return;
          if ("pong" === msg.type && "probe" === msg.data) {
            _this8.upgrading = true;
            _this8.emitReserved("upgrading", transport);
            if (!transport) return;
            SocketWithoutUpgrade.priorWebsocketSuccess = "websocket" === transport.name;
            _this8.transport.pause(function() {
              if (failed) return;
              if ("closed" === _this8.readyState) return;
              cleanup();
              _this8.setTransport(transport);
              transport.send([{
                type: "upgrade"
              }]);
              _this8.emitReserved("upgrade", transport);
              transport = null;
              _this8.upgrading = false;
              _this8.flush();
            });
          } else {
            var err = new Error("probe error");
            err.transport = transport.name;
            _this8.emitReserved("upgradeError", err);
          }
        });
      };
      function freezeTransport() {
        if (failed) return;
        failed = true;
        cleanup();
        transport.close();
        transport = null;
      }
      var onerror = function onerror2(err) {
        var error = new Error("probe error: " + err);
        error.transport = transport.name;
        freezeTransport();
        _this8.emitReserved("upgradeError", error);
      };
      function onTransportClose() {
        onerror("transport closed");
      }
      function onclose() {
        onerror("socket closed");
      }
      function onupgrade(to) {
        if (transport && to.name !== transport.name) {
          freezeTransport();
        }
      }
      var cleanup = function cleanup2() {
        transport.removeListener("open", onTransportOpen);
        transport.removeListener("error", onerror);
        transport.removeListener("close", onTransportClose);
        _this8.off("close", onclose);
        _this8.off("upgrading", onupgrade);
      };
      transport.once("open", onTransportOpen);
      transport.once("error", onerror);
      transport.once("close", onTransportClose);
      this.once("close", onclose);
      this.once("upgrading", onupgrade);
      if (this._upgrades.indexOf("webtransport") !== -1 && name !== "webtransport") {
        this.setTimeoutFn(function() {
          if (!failed) {
            transport.open();
          }
        }, 200);
      } else {
        transport.open();
      }
    };
    _proto2.onHandshake = function onHandshake(data) {
      this._upgrades = this._filterUpgrades(data.upgrades);
      _SocketWithoutUpgrade.prototype.onHandshake.call(this, data);
    };
    _proto2._filterUpgrades = function _filterUpgrades(upgrades) {
      var filteredUpgrades = [];
      for (var i2 = 0; i2 < upgrades.length; i2++) {
        if (~this.transports.indexOf(upgrades[i2])) filteredUpgrades.push(upgrades[i2]);
      }
      return filteredUpgrades;
    };
    return SocketWithUpgrade2;
  })(SocketWithoutUpgrade);
  var Socket$1 = /* @__PURE__ */ (function(_SocketWithUpgrade) {
    function Socket2(uri) {
      var opts = arguments.length > 1 && arguments[1] !== void 0 ? arguments[1] : {};
      var o = _typeof(uri) === "object" ? uri : opts;
      if (!o.transports || o.transports && typeof o.transports[0] === "string") {
        o.transports = (o.transports || ["polling", "websocket", "webtransport"]).map(function(transportName) {
          return transports[transportName];
        }).filter(function(t) {
          return !!t;
        });
      }
      return _SocketWithUpgrade.call(this, uri, o) || this;
    }
    _inheritsLoose(Socket2, _SocketWithUpgrade);
    return Socket2;
  })(SocketWithUpgrade);
  Socket$1.protocol;
  function getDefaultExportFromCjs(x) {
    return x && x.__esModule && Object.prototype.hasOwnProperty.call(x, "default") ? x["default"] : x;
  }
  var browser = { exports: {} };
  var ms;
  var hasRequiredMs;
  function requireMs() {
    if (hasRequiredMs) return ms;
    hasRequiredMs = 1;
    var s = 1e3;
    var m = s * 60;
    var h = m * 60;
    var d = h * 24;
    var w = d * 7;
    var y = d * 365.25;
    ms = function ms2(val, options) {
      options = options || {};
      var type = _typeof(val);
      if (type === "string" && val.length > 0) {
        return parse2(val);
      } else if (type === "number" && isFinite(val)) {
        return options["long"] ? fmtLong(val) : fmtShort(val);
      }
      throw new Error("val is not a non-empty string or a valid number. val=" + JSON.stringify(val));
    };
    function parse2(str) {
      str = String(str);
      if (str.length > 100) {
        return;
      }
      var match = /^(-?(?:\d+)?\.?\d+) *(milliseconds?|msecs?|ms|seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d|weeks?|w|years?|yrs?|y)?$/i.exec(str);
      if (!match) {
        return;
      }
      var n = parseFloat(match[1]);
      var type = (match[2] || "ms").toLowerCase();
      switch (type) {
        case "years":
        case "year":
        case "yrs":
        case "yr":
        case "y":
          return n * y;
        case "weeks":
        case "week":
        case "w":
          return n * w;
        case "days":
        case "day":
        case "d":
          return n * d;
        case "hours":
        case "hour":
        case "hrs":
        case "hr":
        case "h":
          return n * h;
        case "minutes":
        case "minute":
        case "mins":
        case "min":
        case "m":
          return n * m;
        case "seconds":
        case "second":
        case "secs":
        case "sec":
        case "s":
          return n * s;
        case "milliseconds":
        case "millisecond":
        case "msecs":
        case "msec":
        case "ms":
          return n;
        default:
          return void 0;
      }
    }
    function fmtShort(ms2) {
      var msAbs = Math.abs(ms2);
      if (msAbs >= d) {
        return Math.round(ms2 / d) + "d";
      }
      if (msAbs >= h) {
        return Math.round(ms2 / h) + "h";
      }
      if (msAbs >= m) {
        return Math.round(ms2 / m) + "m";
      }
      if (msAbs >= s) {
        return Math.round(ms2 / s) + "s";
      }
      return ms2 + "ms";
    }
    function fmtLong(ms2) {
      var msAbs = Math.abs(ms2);
      if (msAbs >= d) {
        return plural(ms2, msAbs, d, "day");
      }
      if (msAbs >= h) {
        return plural(ms2, msAbs, h, "hour");
      }
      if (msAbs >= m) {
        return plural(ms2, msAbs, m, "minute");
      }
      if (msAbs >= s) {
        return plural(ms2, msAbs, s, "second");
      }
      return ms2 + " ms";
    }
    function plural(ms2, msAbs, n, name) {
      var isPlural = msAbs >= n * 1.5;
      return Math.round(ms2 / n) + " " + name + (isPlural ? "s" : "");
    }
    return ms;
  }
  function setup(env) {
    createDebug.debug = createDebug;
    createDebug["default"] = createDebug;
    createDebug.coerce = coerce;
    createDebug.disable = disable;
    createDebug.enable = enable;
    createDebug.enabled = enabled;
    createDebug.humanize = requireMs();
    createDebug.destroy = destroy;
    Object.keys(env).forEach(function(key) {
      createDebug[key] = env[key];
    });
    createDebug.names = [];
    createDebug.skips = [];
    createDebug.formatters = {};
    function selectColor(namespace) {
      var hash = 0;
      for (var i2 = 0; i2 < namespace.length; i2++) {
        hash = (hash << 5) - hash + namespace.charCodeAt(i2);
        hash |= 0;
      }
      return createDebug.colors[Math.abs(hash) % createDebug.colors.length];
    }
    createDebug.selectColor = selectColor;
    function createDebug(namespace) {
      var prevTime;
      var enableOverride = null;
      var namespacesCache;
      var enabledCache;
      function debug2() {
        for (var _len = arguments.length, args = new Array(_len), _key = 0; _key < _len; _key++) {
          args[_key] = arguments[_key];
        }
        if (!debug2.enabled) {
          return;
        }
        var self2 = debug2;
        var curr = Number(/* @__PURE__ */ new Date());
        var ms2 = curr - (prevTime || curr);
        self2.diff = ms2;
        self2.prev = prevTime;
        self2.curr = curr;
        prevTime = curr;
        args[0] = createDebug.coerce(args[0]);
        if (typeof args[0] !== "string") {
          args.unshift("%O");
        }
        var index = 0;
        args[0] = args[0].replace(/%([a-zA-Z%])/g, function(match, format) {
          if (match === "%%") {
            return "%";
          }
          index++;
          var formatter = createDebug.formatters[format];
          if (typeof formatter === "function") {
            var val = args[index];
            match = formatter.call(self2, val);
            args.splice(index, 1);
            index--;
          }
          return match;
        });
        createDebug.formatArgs.call(self2, args);
        var logFn = self2.log || createDebug.log;
        logFn.apply(self2, args);
      }
      debug2.namespace = namespace;
      debug2.useColors = createDebug.useColors();
      debug2.color = createDebug.selectColor(namespace);
      debug2.extend = extend;
      debug2.destroy = createDebug.destroy;
      Object.defineProperty(debug2, "enabled", {
        enumerable: true,
        configurable: false,
        get: function get() {
          if (enableOverride !== null) {
            return enableOverride;
          }
          if (namespacesCache !== createDebug.namespaces) {
            namespacesCache = createDebug.namespaces;
            enabledCache = createDebug.enabled(namespace);
          }
          return enabledCache;
        },
        set: function set(v) {
          enableOverride = v;
        }
      });
      if (typeof createDebug.init === "function") {
        createDebug.init(debug2);
      }
      return debug2;
    }
    function extend(namespace, delimiter) {
      var newDebug = createDebug(this.namespace + (typeof delimiter === "undefined" ? ":" : delimiter) + namespace);
      newDebug.log = this.log;
      return newDebug;
    }
    function enable(namespaces) {
      createDebug.save(namespaces);
      createDebug.namespaces = namespaces;
      createDebug.names = [];
      createDebug.skips = [];
      var split = (typeof namespaces === "string" ? namespaces : "").trim().replace(/\s+/g, ",").split(",").filter(Boolean);
      var _iterator = _createForOfIteratorHelper(split), _step;
      try {
        for (_iterator.s(); !(_step = _iterator.n()).done; ) {
          var ns = _step.value;
          if (ns[0] === "-") {
            createDebug.skips.push(ns.slice(1));
          } else {
            createDebug.names.push(ns);
          }
        }
      } catch (err) {
        _iterator.e(err);
      } finally {
        _iterator.f();
      }
    }
    function matchesTemplate(search, template) {
      var searchIndex = 0;
      var templateIndex = 0;
      var starIndex = -1;
      var matchIndex = 0;
      while (searchIndex < search.length) {
        if (templateIndex < template.length && (template[templateIndex] === search[searchIndex] || template[templateIndex] === "*")) {
          if (template[templateIndex] === "*") {
            starIndex = templateIndex;
            matchIndex = searchIndex;
            templateIndex++;
          } else {
            searchIndex++;
            templateIndex++;
          }
        } else if (starIndex !== -1) {
          templateIndex = starIndex + 1;
          matchIndex++;
          searchIndex = matchIndex;
        } else {
          return false;
        }
      }
      while (templateIndex < template.length && template[templateIndex] === "*") {
        templateIndex++;
      }
      return templateIndex === template.length;
    }
    function disable() {
      var namespaces = [].concat(_toConsumableArray(createDebug.names), _toConsumableArray(createDebug.skips.map(function(namespace) {
        return "-" + namespace;
      }))).join(",");
      createDebug.enable("");
      return namespaces;
    }
    function enabled(name) {
      var _iterator2 = _createForOfIteratorHelper(createDebug.skips), _step2;
      try {
        for (_iterator2.s(); !(_step2 = _iterator2.n()).done; ) {
          var skip = _step2.value;
          if (matchesTemplate(name, skip)) {
            return false;
          }
        }
      } catch (err) {
        _iterator2.e(err);
      } finally {
        _iterator2.f();
      }
      var _iterator3 = _createForOfIteratorHelper(createDebug.names), _step3;
      try {
        for (_iterator3.s(); !(_step3 = _iterator3.n()).done; ) {
          var ns = _step3.value;
          if (matchesTemplate(name, ns)) {
            return true;
          }
        }
      } catch (err) {
        _iterator3.e(err);
      } finally {
        _iterator3.f();
      }
      return false;
    }
    function coerce(val) {
      if (val instanceof Error) {
        return val.stack || val.message;
      }
      return val;
    }
    function destroy() {
      console.warn("Instance method `debug.destroy()` is deprecated and no longer does anything. It will be removed in the next major version of `debug`.");
    }
    createDebug.enable(createDebug.load());
    return createDebug;
  }
  var common = setup;
  browser.exports;
  (function(module2, exports2) {
    exports2.formatArgs = formatArgs;
    exports2.save = save;
    exports2.load = load;
    exports2.useColors = useColors;
    exports2.storage = localstorage();
    exports2.destroy = /* @__PURE__ */ (function() {
      var warned = false;
      return function() {
        if (!warned) {
          warned = true;
          console.warn("Instance method `debug.destroy()` is deprecated and no longer does anything. It will be removed in the next major version of `debug`.");
        }
      };
    })();
    exports2.colors = ["#0000CC", "#0000FF", "#0033CC", "#0033FF", "#0066CC", "#0066FF", "#0099CC", "#0099FF", "#00CC00", "#00CC33", "#00CC66", "#00CC99", "#00CCCC", "#00CCFF", "#3300CC", "#3300FF", "#3333CC", "#3333FF", "#3366CC", "#3366FF", "#3399CC", "#3399FF", "#33CC00", "#33CC33", "#33CC66", "#33CC99", "#33CCCC", "#33CCFF", "#6600CC", "#6600FF", "#6633CC", "#6633FF", "#66CC00", "#66CC33", "#9900CC", "#9900FF", "#9933CC", "#9933FF", "#99CC00", "#99CC33", "#CC0000", "#CC0033", "#CC0066", "#CC0099", "#CC00CC", "#CC00FF", "#CC3300", "#CC3333", "#CC3366", "#CC3399", "#CC33CC", "#CC33FF", "#CC6600", "#CC6633", "#CC9900", "#CC9933", "#CCCC00", "#CCCC33", "#FF0000", "#FF0033", "#FF0066", "#FF0099", "#FF00CC", "#FF00FF", "#FF3300", "#FF3333", "#FF3366", "#FF3399", "#FF33CC", "#FF33FF", "#FF6600", "#FF6633", "#FF9900", "#FF9933", "#FFCC00", "#FFCC33"];
    function useColors() {
      if (typeof window !== "undefined" && window.process && (window.process.type === "renderer" || window.process.__nwjs)) {
        return true;
      }
      if (typeof navigator !== "undefined" && navigator.userAgent && navigator.userAgent.toLowerCase().match(/(edge|trident)\/(\d+)/)) {
        return false;
      }
      var m;
      return typeof document !== "undefined" && document.documentElement && document.documentElement.style && document.documentElement.style.WebkitAppearance || // Is firebug? http://stackoverflow.com/a/398120/376773
      typeof window !== "undefined" && window.console && (window.console.firebug || window.console.exception && window.console.table) || // Is firefox >= v31?
      // https://developer.mozilla.org/en-US/docs/Tools/Web_Console#Styling_messages
      typeof navigator !== "undefined" && navigator.userAgent && (m = navigator.userAgent.toLowerCase().match(/firefox\/(\d+)/)) && parseInt(m[1], 10) >= 31 || // Double check webkit in userAgent just in case we are in a worker
      typeof navigator !== "undefined" && navigator.userAgent && navigator.userAgent.toLowerCase().match(/applewebkit\/(\d+)/);
    }
    function formatArgs(args) {
      args[0] = (this.useColors ? "%c" : "") + this.namespace + (this.useColors ? " %c" : " ") + args[0] + (this.useColors ? "%c " : " ") + "+" + module2.exports.humanize(this.diff);
      if (!this.useColors) {
        return;
      }
      var c = "color: " + this.color;
      args.splice(1, 0, c, "color: inherit");
      var index = 0;
      var lastC = 0;
      args[0].replace(/%[a-zA-Z%]/g, function(match) {
        if (match === "%%") {
          return;
        }
        index++;
        if (match === "%c") {
          lastC = index;
        }
      });
      args.splice(lastC, 0, c);
    }
    exports2.log = console.debug || console.log || function() {
    };
    function save(namespaces) {
      try {
        if (namespaces) {
          exports2.storage.setItem("debug", namespaces);
        } else {
          exports2.storage.removeItem("debug");
        }
      } catch (error) {
      }
    }
    function load() {
      var r;
      try {
        r = exports2.storage.getItem("debug") || exports2.storage.getItem("DEBUG");
      } catch (error) {
      }
      if (!r && typeof process !== "undefined" && "env" in process) {
        r = process.env.DEBUG;
      }
      return r;
    }
    function localstorage() {
      try {
        return localStorage;
      } catch (error) {
      }
    }
    module2.exports = common(exports2);
    var formatters = module2.exports.formatters;
    formatters.j = function(v) {
      try {
        return JSON.stringify(v);
      } catch (error) {
        return "[UnexpectedJSONParseError]: " + error.message;
      }
    };
  })(browser, browser.exports);
  var browserExports = browser.exports;
  var debugModule = /* @__PURE__ */ getDefaultExportFromCjs(browserExports);
  var debug$3 = debugModule("socket.io-client:url");
  function url(uri) {
    var path = arguments.length > 1 && arguments[1] !== void 0 ? arguments[1] : "";
    var loc = arguments.length > 2 ? arguments[2] : void 0;
    var obj = uri;
    loc = loc || typeof location !== "undefined" && location;
    if (null == uri) uri = loc.protocol + "//" + loc.host;
    if (typeof uri === "string") {
      if ("/" === uri.charAt(0)) {
        if ("/" === uri.charAt(1)) {
          uri = loc.protocol + uri;
        } else {
          uri = loc.host + uri;
        }
      }
      if (!/^(https?|wss?):\/\//.test(uri)) {
        debug$3("protocol-less url %s", uri);
        if ("undefined" !== typeof loc) {
          uri = loc.protocol + "//" + uri;
        } else {
          uri = "https://" + uri;
        }
      }
      debug$3("parse %s", uri);
      obj = parse(uri);
    }
    if (!obj.port) {
      if (/^(http|ws)$/.test(obj.protocol)) {
        obj.port = "80";
      } else if (/^(http|ws)s$/.test(obj.protocol)) {
        obj.port = "443";
      }
    }
    obj.path = obj.path || "/";
    var ipv6 = obj.host.indexOf(":") !== -1;
    var host = ipv6 ? "[" + obj.host + "]" : obj.host;
    obj.id = obj.protocol + "://" + host + ":" + obj.port + path;
    obj.href = obj.protocol + "://" + host + (loc && loc.port === obj.port ? "" : ":" + obj.port);
    return obj;
  }
  var withNativeArrayBuffer = typeof ArrayBuffer === "function";
  var isView = function isView2(obj) {
    return typeof ArrayBuffer.isView === "function" ? ArrayBuffer.isView(obj) : obj.buffer instanceof ArrayBuffer;
  };
  var toString = Object.prototype.toString;
  var withNativeBlob = typeof Blob === "function" || typeof Blob !== "undefined" && toString.call(Blob) === "[object BlobConstructor]";
  var withNativeFile = typeof File === "function" || typeof File !== "undefined" && toString.call(File) === "[object FileConstructor]";
  function isBinary(obj) {
    return withNativeArrayBuffer && (obj instanceof ArrayBuffer || isView(obj)) || withNativeBlob && obj instanceof Blob || withNativeFile && obj instanceof File;
  }
  function hasBinary(obj, toJSON) {
    if (!obj || _typeof(obj) !== "object") {
      return false;
    }
    if (Array.isArray(obj)) {
      for (var i2 = 0, l = obj.length; i2 < l; i2++) {
        if (hasBinary(obj[i2])) {
          return true;
        }
      }
      return false;
    }
    if (isBinary(obj)) {
      return true;
    }
    if (obj.toJSON && typeof obj.toJSON === "function" && arguments.length === 1) {
      return hasBinary(obj.toJSON(), true);
    }
    for (var key in obj) {
      if (Object.prototype.hasOwnProperty.call(obj, key) && hasBinary(obj[key])) {
        return true;
      }
    }
    return false;
  }
  function deconstructPacket(packet) {
    var buffers = [];
    var packetData = packet.data;
    var pack = packet;
    pack.data = _deconstructPacket(packetData, buffers);
    pack.attachments = buffers.length;
    return {
      packet: pack,
      buffers: buffers
    };
  }
  function _deconstructPacket(data, buffers) {
    if (!data) return data;
    if (isBinary(data)) {
      var placeholder = {
        _placeholder: true,
        num: buffers.length
      };
      buffers.push(data);
      return placeholder;
    } else if (Array.isArray(data)) {
      var newData = new Array(data.length);
      for (var i2 = 0; i2 < data.length; i2++) {
        newData[i2] = _deconstructPacket(data[i2], buffers);
      }
      return newData;
    } else if (_typeof(data) === "object" && !(data instanceof Date)) {
      var _newData = {};
      for (var key in data) {
        if (Object.prototype.hasOwnProperty.call(data, key)) {
          _newData[key] = _deconstructPacket(data[key], buffers);
        }
      }
      return _newData;
    }
    return data;
  }
  function reconstructPacket(packet, buffers) {
    packet.data = _reconstructPacket(packet.data, buffers);
    delete packet.attachments;
    return packet;
  }
  function _reconstructPacket(data, buffers) {
    if (!data) return data;
    if (data && data._placeholder === true) {
      var isIndexValid = typeof data.num === "number" && data.num >= 0 && data.num < buffers.length;
      if (isIndexValid) {
        return buffers[data.num];
      } else {
        throw new Error("illegal attachments");
      }
    } else if (Array.isArray(data)) {
      for (var i2 = 0; i2 < data.length; i2++) {
        data[i2] = _reconstructPacket(data[i2], buffers);
      }
    } else if (_typeof(data) === "object") {
      for (var key in data) {
        if (Object.prototype.hasOwnProperty.call(data, key)) {
          data[key] = _reconstructPacket(data[key], buffers);
        }
      }
    }
    return data;
  }
  var RESERVED_EVENTS$1 = [
    "connect",
    // used on the client side
    "connect_error",
    // used on the client side
    "disconnect",
    // used on both sides
    "disconnecting",
    // used on the server side
    "newListener",
    // used by the Node.js EventEmitter
    "removeListener"
    // used by the Node.js EventEmitter
  ];
  var protocol = 5;
  var PacketType;
  (function(PacketType2) {
    PacketType2[PacketType2["CONNECT"] = 0] = "CONNECT";
    PacketType2[PacketType2["DISCONNECT"] = 1] = "DISCONNECT";
    PacketType2[PacketType2["EVENT"] = 2] = "EVENT";
    PacketType2[PacketType2["ACK"] = 3] = "ACK";
    PacketType2[PacketType2["CONNECT_ERROR"] = 4] = "CONNECT_ERROR";
    PacketType2[PacketType2["BINARY_EVENT"] = 5] = "BINARY_EVENT";
    PacketType2[PacketType2["BINARY_ACK"] = 6] = "BINARY_ACK";
  })(PacketType || (PacketType = {}));
  var Encoder = /* @__PURE__ */ (function() {
    function Encoder2(replacer) {
      this.replacer = replacer;
    }
    var _proto = Encoder2.prototype;
    _proto.encode = function encode2(obj) {
      if (obj.type === PacketType.EVENT || obj.type === PacketType.ACK) {
        if (hasBinary(obj)) {
          return this.encodeAsBinary({
            type: obj.type === PacketType.EVENT ? PacketType.BINARY_EVENT : PacketType.BINARY_ACK,
            nsp: obj.nsp,
            data: obj.data,
            id: obj.id
          });
        }
      }
      return [this.encodeAsString(obj)];
    };
    _proto.encodeAsString = function encodeAsString(obj) {
      var str = "" + obj.type;
      if (obj.type === PacketType.BINARY_EVENT || obj.type === PacketType.BINARY_ACK) {
        str += obj.attachments + "-";
      }
      if (obj.nsp && "/" !== obj.nsp) {
        str += obj.nsp + ",";
      }
      if (null != obj.id) {
        str += obj.id;
      }
      if (null != obj.data) {
        str += JSON.stringify(obj.data, this.replacer);
      }
      return str;
    };
    _proto.encodeAsBinary = function encodeAsBinary(obj) {
      var deconstruction = deconstructPacket(obj);
      var pack = this.encodeAsString(deconstruction.packet);
      var buffers = deconstruction.buffers;
      buffers.unshift(pack);
      return buffers;
    };
    return Encoder2;
  })();
  var Decoder = /* @__PURE__ */ (function(_Emitter) {
    function Decoder2(reviver) {
      var _this;
      _this = _Emitter.call(this) || this;
      _this.reviver = reviver;
      return _this;
    }
    _inheritsLoose(Decoder2, _Emitter);
    var _proto2 = Decoder2.prototype;
    _proto2.add = function add(obj) {
      var packet;
      if (typeof obj === "string") {
        if (this.reconstructor) {
          throw new Error("got plaintext data when reconstructing a packet");
        }
        packet = this.decodeString(obj);
        var isBinaryEvent = packet.type === PacketType.BINARY_EVENT;
        if (isBinaryEvent || packet.type === PacketType.BINARY_ACK) {
          packet.type = isBinaryEvent ? PacketType.EVENT : PacketType.ACK;
          this.reconstructor = new BinaryReconstructor(packet);
          if (packet.attachments === 0) {
            _Emitter.prototype.emitReserved.call(this, "decoded", packet);
          }
        } else {
          _Emitter.prototype.emitReserved.call(this, "decoded", packet);
        }
      } else if (isBinary(obj) || obj.base64) {
        if (!this.reconstructor) {
          throw new Error("got binary data when not reconstructing a packet");
        } else {
          packet = this.reconstructor.takeBinaryData(obj);
          if (packet) {
            this.reconstructor = null;
            _Emitter.prototype.emitReserved.call(this, "decoded", packet);
          }
        }
      } else {
        throw new Error("Unknown type: " + obj);
      }
    };
    _proto2.decodeString = function decodeString(str) {
      var i2 = 0;
      var p = {
        type: Number(str.charAt(0))
      };
      if (PacketType[p.type] === void 0) {
        throw new Error("unknown packet type " + p.type);
      }
      if (p.type === PacketType.BINARY_EVENT || p.type === PacketType.BINARY_ACK) {
        var start = i2 + 1;
        while (str.charAt(++i2) !== "-" && i2 != str.length) {
        }
        var buf = str.substring(start, i2);
        if (buf != Number(buf) || str.charAt(i2) !== "-") {
          throw new Error("Illegal attachments");
        }
        p.attachments = Number(buf);
      }
      if ("/" === str.charAt(i2 + 1)) {
        var _start = i2 + 1;
        while (++i2) {
          var c = str.charAt(i2);
          if ("," === c) break;
          if (i2 === str.length) break;
        }
        p.nsp = str.substring(_start, i2);
      } else {
        p.nsp = "/";
      }
      var next = str.charAt(i2 + 1);
      if ("" !== next && Number(next) == next) {
        var _start2 = i2 + 1;
        while (++i2) {
          var _c = str.charAt(i2);
          if (null == _c || Number(_c) != _c) {
            --i2;
            break;
          }
          if (i2 === str.length) break;
        }
        p.id = Number(str.substring(_start2, i2 + 1));
      }
      if (str.charAt(++i2)) {
        var payload = this.tryParse(str.substr(i2));
        if (Decoder2.isPayloadValid(p.type, payload)) {
          p.data = payload;
        } else {
          throw new Error("invalid payload");
        }
      }
      return p;
    };
    _proto2.tryParse = function tryParse(str) {
      try {
        return JSON.parse(str, this.reviver);
      } catch (e) {
        return false;
      }
    };
    Decoder2.isPayloadValid = function isPayloadValid(type, payload) {
      switch (type) {
        case PacketType.CONNECT:
          return isObject(payload);
        case PacketType.DISCONNECT:
          return payload === void 0;
        case PacketType.CONNECT_ERROR:
          return typeof payload === "string" || isObject(payload);
        case PacketType.EVENT:
        case PacketType.BINARY_EVENT:
          return Array.isArray(payload) && (typeof payload[0] === "number" || typeof payload[0] === "string" && RESERVED_EVENTS$1.indexOf(payload[0]) === -1);
        case PacketType.ACK:
        case PacketType.BINARY_ACK:
          return Array.isArray(payload);
      }
    };
    _proto2.destroy = function destroy() {
      if (this.reconstructor) {
        this.reconstructor.finishedReconstruction();
        this.reconstructor = null;
      }
    };
    return Decoder2;
  })(Emitter);
  var BinaryReconstructor = /* @__PURE__ */ (function() {
    function BinaryReconstructor2(packet) {
      this.packet = packet;
      this.buffers = [];
      this.reconPack = packet;
    }
    var _proto3 = BinaryReconstructor2.prototype;
    _proto3.takeBinaryData = function takeBinaryData(binData) {
      this.buffers.push(binData);
      if (this.buffers.length === this.reconPack.attachments) {
        var packet = reconstructPacket(this.reconPack, this.buffers);
        this.finishedReconstruction();
        return packet;
      }
      return null;
    };
    _proto3.finishedReconstruction = function finishedReconstruction() {
      this.reconPack = null;
      this.buffers = [];
    };
    return BinaryReconstructor2;
  })();
  function isNamespaceValid(nsp) {
    return typeof nsp === "string";
  }
  var isInteger = Number.isInteger || function(value2) {
    return typeof value2 === "number" && isFinite(value2) && Math.floor(value2) === value2;
  };
  function isAckIdValid(id) {
    return id === void 0 || isInteger(id);
  }
  function isObject(value2) {
    return Object.prototype.toString.call(value2) === "[object Object]";
  }
  function isDataValid(type, payload) {
    switch (type) {
      case PacketType.CONNECT:
        return payload === void 0 || isObject(payload);
      case PacketType.DISCONNECT:
        return payload === void 0;
      case PacketType.EVENT:
        return Array.isArray(payload) && (typeof payload[0] === "number" || typeof payload[0] === "string" && RESERVED_EVENTS$1.indexOf(payload[0]) === -1);
      case PacketType.ACK:
        return Array.isArray(payload);
      case PacketType.CONNECT_ERROR:
        return typeof payload === "string" || isObject(payload);
      default:
        return false;
    }
  }
  function isPacketValid(packet) {
    return isNamespaceValid(packet.nsp) && isAckIdValid(packet.id) && isDataValid(packet.type, packet.data);
  }
  var parser = /* @__PURE__ */ Object.freeze({
    __proto__: null,
    protocol: protocol,
    get PacketType() {
      return PacketType;
    },
    Encoder: Encoder,
    Decoder: Decoder,
    isPacketValid: isPacketValid
  });
  function on(obj, ev, fn) {
    obj.on(ev, fn);
    return function subDestroy() {
      obj.off(ev, fn);
    };
  }
  var debug$2 = debugModule("socket.io-client:socket");
  var RESERVED_EVENTS = Object.freeze({
    connect: 1,
    connect_error: 1,
    disconnect: 1,
    disconnecting: 1,
    // EventEmitter reserved events: https://nodejs.org/api/events.html#events_event_newlistener
    newListener: 1,
    removeListener: 1
  });
  var Socket = /* @__PURE__ */ (function(_Emitter) {
    function Socket2(io, nsp, opts) {
      var _this;
      _this = _Emitter.call(this) || this;
      _this.connected = false;
      _this.recovered = false;
      _this.receiveBuffer = [];
      _this.sendBuffer = [];
      _this._queue = [];
      _this._queueSeq = 0;
      _this.ids = 0;
      _this.acks = {};
      _this.flags = {};
      _this.io = io;
      _this.nsp = nsp;
      if (opts && opts.auth) {
        _this.auth = opts.auth;
      }
      _this._opts = _extends({}, opts);
      if (_this.io._autoConnect) _this.open();
      return _this;
    }
    _inheritsLoose(Socket2, _Emitter);
    var _proto = Socket2.prototype;
    _proto.subEvents = function subEvents() {
      if (this.subs) return;
      var io = this.io;
      this.subs = [on(io, "open", this.onopen.bind(this)), on(io, "packet", this.onpacket.bind(this)), on(io, "error", this.onerror.bind(this)), on(io, "close", this.onclose.bind(this))];
    };
    _proto.connect = function connect() {
      if (this.connected) return this;
      this.subEvents();
      if (!this.io["_reconnecting"]) this.io.open();
      if ("open" === this.io._readyState) this.onopen();
      return this;
    };
    _proto.open = function open() {
      return this.connect();
    };
    _proto.send = function send() {
      for (var _len = arguments.length, args = new Array(_len), _key = 0; _key < _len; _key++) {
        args[_key] = arguments[_key];
      }
      args.unshift("message");
      this.emit.apply(this, args);
      return this;
    };
    _proto.emit = function emit(ev) {
      var _a, _b, _c;
      if (RESERVED_EVENTS.hasOwnProperty(ev)) {
        throw new Error('"' + ev.toString() + '" is a reserved event name');
      }
      for (var _len2 = arguments.length, args = new Array(_len2 > 1 ? _len2 - 1 : 0), _key2 = 1; _key2 < _len2; _key2++) {
        args[_key2 - 1] = arguments[_key2];
      }
      args.unshift(ev);
      if (this._opts.retries && !this.flags.fromQueue && !this.flags["volatile"]) {
        this._addToQueue(args);
        return this;
      }
      var packet = {
        type: PacketType.EVENT,
        data: args
      };
      packet.options = {};
      packet.options.compress = this.flags.compress !== false;
      if ("function" === typeof args[args.length - 1]) {
        var id = this.ids++;
        debug$2("emitting packet with ack id %d", id);
        var ack = args.pop();
        this._registerAckCallback(id, ack);
        packet.id = id;
      }
      var isTransportWritable = (_b = (_a = this.io.engine) === null || _a === void 0 ? void 0 : _a.transport) === null || _b === void 0 ? void 0 : _b.writable;
      var isConnected = this.connected && !((_c = this.io.engine) === null || _c === void 0 ? void 0 : _c._hasPingExpired());
      var discardPacket = this.flags["volatile"] && !isTransportWritable;
      if (discardPacket) {
        debug$2("discard packet as the transport is not currently writable");
      } else if (isConnected) {
        this.notifyOutgoingListeners(packet);
        this.packet(packet);
      } else {
        this.sendBuffer.push(packet);
      }
      this.flags = {};
      return this;
    };
    _proto._registerAckCallback = function _registerAckCallback(id, ack) {
      var _this2 = this;
      var _a;
      var timeout = (_a = this.flags.timeout) !== null && _a !== void 0 ? _a : this._opts.ackTimeout;
      if (timeout === void 0) {
        this.acks[id] = ack;
        return;
      }
      var timer = this.io.setTimeoutFn(function() {
        delete _this2.acks[id];
        for (var i2 = 0; i2 < _this2.sendBuffer.length; i2++) {
          if (_this2.sendBuffer[i2].id === id) {
            debug$2("removing packet with ack id %d from the buffer", id);
            _this2.sendBuffer.splice(i2, 1);
          }
        }
        debug$2("event with ack id %d has timed out after %d ms", id, timeout);
        ack.call(_this2, new Error("operation has timed out"));
      }, timeout);
      var fn = function fn2() {
        _this2.io.clearTimeoutFn(timer);
        for (var _len3 = arguments.length, args = new Array(_len3), _key3 = 0; _key3 < _len3; _key3++) {
          args[_key3] = arguments[_key3];
        }
        ack.apply(_this2, args);
      };
      fn.withError = true;
      this.acks[id] = fn;
    };
    _proto.emitWithAck = function emitWithAck(ev) {
      var _this3 = this;
      for (var _len4 = arguments.length, args = new Array(_len4 > 1 ? _len4 - 1 : 0), _key4 = 1; _key4 < _len4; _key4++) {
        args[_key4 - 1] = arguments[_key4];
      }
      return new Promise(function(resolve, reject) {
        var fn = function fn2(arg1, arg2) {
          return arg1 ? reject(arg1) : resolve(arg2);
        };
        fn.withError = true;
        args.push(fn);
        _this3.emit.apply(_this3, [ev].concat(args));
      });
    };
    _proto._addToQueue = function _addToQueue(args) {
      var _this4 = this;
      var ack;
      if (typeof args[args.length - 1] === "function") {
        ack = args.pop();
      }
      var packet = {
        id: this._queueSeq++,
        tryCount: 0,
        pending: false,
        args: args,
        flags: _extends({
          fromQueue: true
        }, this.flags)
      };
      args.push(function(err) {
        if (packet !== _this4._queue[0]) {
          return debug$2("packet [%d] already acknowledged", packet.id);
        }
        var hasError = err !== null;
        if (hasError) {
          if (packet.tryCount > _this4._opts.retries) {
            debug$2("packet [%d] is discarded after %d tries", packet.id, packet.tryCount);
            _this4._queue.shift();
            if (ack) {
              ack(err);
            }
          }
        } else {
          debug$2("packet [%d] was successfully sent", packet.id);
          _this4._queue.shift();
          if (ack) {
            for (var _len5 = arguments.length, responseArgs = new Array(_len5 > 1 ? _len5 - 1 : 0), _key5 = 1; _key5 < _len5; _key5++) {
              responseArgs[_key5 - 1] = arguments[_key5];
            }
            ack.apply(void 0, [null].concat(responseArgs));
          }
        }
        packet.pending = false;
        return _this4._drainQueue();
      });
      this._queue.push(packet);
      this._drainQueue();
    };
    _proto._drainQueue = function _drainQueue() {
      var force = arguments.length > 0 && arguments[0] !== void 0 ? arguments[0] : false;
      debug$2("draining queue");
      if (!this.connected || this._queue.length === 0) {
        return;
      }
      var packet = this._queue[0];
      if (packet.pending && !force) {
        debug$2("packet [%d] has already been sent and is waiting for an ack", packet.id);
        return;
      }
      packet.pending = true;
      packet.tryCount++;
      debug$2("sending packet [%d] (try n\xB0%d)", packet.id, packet.tryCount);
      this.flags = packet.flags;
      this.emit.apply(this, packet.args);
    };
    _proto.packet = function packet(_packet) {
      _packet.nsp = this.nsp;
      this.io._packet(_packet);
    };
    _proto.onopen = function onopen() {
      var _this5 = this;
      debug$2("transport is open - connecting");
      if (typeof this.auth == "function") {
        this.auth(function(data) {
          _this5._sendConnectPacket(data);
        });
      } else {
        this._sendConnectPacket(this.auth);
      }
    };
    _proto._sendConnectPacket = function _sendConnectPacket(data) {
      this.packet({
        type: PacketType.CONNECT,
        data: this._pid ? _extends({
          pid: this._pid,
          offset: this._lastOffset
        }, data) : data
      });
    };
    _proto.onerror = function onerror(err) {
      if (!this.connected) {
        this.emitReserved("connect_error", err);
      }
    };
    _proto.onclose = function onclose(reason, description) {
      debug$2("close (%s)", reason);
      this.connected = false;
      delete this.id;
      this.emitReserved("disconnect", reason, description);
      this._clearAcks();
    };
    _proto._clearAcks = function _clearAcks() {
      var _this6 = this;
      Object.keys(this.acks).forEach(function(id) {
        var isBuffered = _this6.sendBuffer.some(function(packet) {
          return String(packet.id) === id;
        });
        if (!isBuffered) {
          var ack = _this6.acks[id];
          delete _this6.acks[id];
          if (ack.withError) {
            ack.call(_this6, new Error("socket has been disconnected"));
          }
        }
      });
    };
    _proto.onpacket = function onpacket(packet) {
      var sameNamespace = packet.nsp === this.nsp;
      if (!sameNamespace) return;
      switch (packet.type) {
        case PacketType.CONNECT:
          if (packet.data && packet.data.sid) {
            this.onconnect(packet.data.sid, packet.data.pid);
          } else {
            this.emitReserved("connect_error", new Error("It seems you are trying to reach a Socket.IO server in v2.x with a v3.x client, but they are not compatible (more information here: https://socket.io/docs/v3/migrating-from-2-x-to-3-0/)"));
          }
          break;
        case PacketType.EVENT:
        case PacketType.BINARY_EVENT:
          this.onevent(packet);
          break;
        case PacketType.ACK:
        case PacketType.BINARY_ACK:
          this.onack(packet);
          break;
        case PacketType.DISCONNECT:
          this.ondisconnect();
          break;
        case PacketType.CONNECT_ERROR:
          this.destroy();
          var err = new Error(packet.data.message);
          err.data = packet.data.data;
          this.emitReserved("connect_error", err);
          break;
      }
    };
    _proto.onevent = function onevent(packet) {
      var args = packet.data || [];
      debug$2("emitting event %j", args);
      if (null != packet.id) {
        debug$2("attaching ack callback to event");
        args.push(this.ack(packet.id));
      }
      if (this.connected) {
        this.emitEvent(args);
      } else {
        this.receiveBuffer.push(Object.freeze(args));
      }
    };
    _proto.emitEvent = function emitEvent(args) {
      if (this._anyListeners && this._anyListeners.length) {
        var listeners = this._anyListeners.slice();
        var _iterator = _createForOfIteratorHelper(listeners), _step;
        try {
          for (_iterator.s(); !(_step = _iterator.n()).done; ) {
            var listener = _step.value;
            listener.apply(this, args);
          }
        } catch (err) {
          _iterator.e(err);
        } finally {
          _iterator.f();
        }
      }
      _Emitter.prototype.emit.apply(this, args);
      if (this._pid && args.length && typeof args[args.length - 1] === "string") {
        this._lastOffset = args[args.length - 1];
      }
    };
    _proto.ack = function ack(id) {
      var self2 = this;
      var sent = false;
      return function() {
        if (sent) return;
        sent = true;
        for (var _len6 = arguments.length, args = new Array(_len6), _key6 = 0; _key6 < _len6; _key6++) {
          args[_key6] = arguments[_key6];
        }
        debug$2("sending ack %j", args);
        self2.packet({
          type: PacketType.ACK,
          id: id,
          data: args
        });
      };
    };
    _proto.onack = function onack(packet) {
      var ack = this.acks[packet.id];
      if (typeof ack !== "function") {
        debug$2("bad ack %s", packet.id);
        return;
      }
      delete this.acks[packet.id];
      debug$2("calling ack %s with %j", packet.id, packet.data);
      if (ack.withError) {
        packet.data.unshift(null);
      }
      ack.apply(this, packet.data);
    };
    _proto.onconnect = function onconnect(id, pid) {
      debug$2("socket connected with id %s", id);
      this.id = id;
      this.recovered = pid && this._pid === pid;
      this._pid = pid;
      this.connected = true;
      this.emitBuffered();
      this._drainQueue(true);
      this.emitReserved("connect");
    };
    _proto.emitBuffered = function emitBuffered() {
      var _this7 = this;
      this.receiveBuffer.forEach(function(args) {
        return _this7.emitEvent(args);
      });
      this.receiveBuffer = [];
      this.sendBuffer.forEach(function(packet) {
        _this7.notifyOutgoingListeners(packet);
        _this7.packet(packet);
      });
      this.sendBuffer = [];
    };
    _proto.ondisconnect = function ondisconnect() {
      debug$2("server disconnect (%s)", this.nsp);
      this.destroy();
      this.onclose("io server disconnect");
    };
    _proto.destroy = function destroy() {
      if (this.subs) {
        this.subs.forEach(function(subDestroy) {
          return subDestroy();
        });
        this.subs = void 0;
      }
      this.io["_destroy"](this);
    };
    _proto.disconnect = function disconnect() {
      if (this.connected) {
        debug$2("performing disconnect (%s)", this.nsp);
        this.packet({
          type: PacketType.DISCONNECT
        });
      }
      this.destroy();
      if (this.connected) {
        this.onclose("io client disconnect");
      }
      return this;
    };
    _proto.close = function close() {
      return this.disconnect();
    };
    _proto.compress = function compress(_compress) {
      this.flags.compress = _compress;
      return this;
    };
    _proto.timeout = function timeout(_timeout) {
      this.flags.timeout = _timeout;
      return this;
    };
    _proto.onAny = function onAny(listener) {
      this._anyListeners = this._anyListeners || [];
      this._anyListeners.push(listener);
      return this;
    };
    _proto.prependAny = function prependAny(listener) {
      this._anyListeners = this._anyListeners || [];
      this._anyListeners.unshift(listener);
      return this;
    };
    _proto.offAny = function offAny(listener) {
      if (!this._anyListeners) {
        return this;
      }
      if (listener) {
        var listeners = this._anyListeners;
        for (var i2 = 0; i2 < listeners.length; i2++) {
          if (listener === listeners[i2]) {
            listeners.splice(i2, 1);
            return this;
          }
        }
      } else {
        this._anyListeners = [];
      }
      return this;
    };
    _proto.listenersAny = function listenersAny() {
      return this._anyListeners || [];
    };
    _proto.onAnyOutgoing = function onAnyOutgoing(listener) {
      this._anyOutgoingListeners = this._anyOutgoingListeners || [];
      this._anyOutgoingListeners.push(listener);
      return this;
    };
    _proto.prependAnyOutgoing = function prependAnyOutgoing(listener) {
      this._anyOutgoingListeners = this._anyOutgoingListeners || [];
      this._anyOutgoingListeners.unshift(listener);
      return this;
    };
    _proto.offAnyOutgoing = function offAnyOutgoing(listener) {
      if (!this._anyOutgoingListeners) {
        return this;
      }
      if (listener) {
        var listeners = this._anyOutgoingListeners;
        for (var i2 = 0; i2 < listeners.length; i2++) {
          if (listener === listeners[i2]) {
            listeners.splice(i2, 1);
            return this;
          }
        }
      } else {
        this._anyOutgoingListeners = [];
      }
      return this;
    };
    _proto.listenersAnyOutgoing = function listenersAnyOutgoing() {
      return this._anyOutgoingListeners || [];
    };
    _proto.notifyOutgoingListeners = function notifyOutgoingListeners(packet) {
      if (this._anyOutgoingListeners && this._anyOutgoingListeners.length) {
        var listeners = this._anyOutgoingListeners.slice();
        var _iterator2 = _createForOfIteratorHelper(listeners), _step2;
        try {
          for (_iterator2.s(); !(_step2 = _iterator2.n()).done; ) {
            var listener = _step2.value;
            listener.apply(this, packet.data);
          }
        } catch (err) {
          _iterator2.e(err);
        } finally {
          _iterator2.f();
        }
      }
    };
    return _createClass(Socket2, [{
      key: "disconnected",
      get: function get() {
        return !this.connected;
      }
    }, {
      key: "active",
      get: function get() {
        return !!this.subs;
      }
    }, {
      key: "volatile",
      get: function get() {
        this.flags["volatile"] = true;
        return this;
      }
    }]);
  })(Emitter);
  function Backoff(opts) {
    opts = opts || {};
    this.ms = opts.min || 100;
    this.max = opts.max || 1e4;
    this.factor = opts.factor || 2;
    this.jitter = opts.jitter > 0 && opts.jitter <= 1 ? opts.jitter : 0;
    this.attempts = 0;
  }
  Backoff.prototype.duration = function() {
    var ms2 = this.ms * Math.pow(this.factor, this.attempts++);
    if (this.jitter) {
      var rand = Math.random();
      var deviation = Math.floor(rand * this.jitter * ms2);
      ms2 = (Math.floor(rand * 10) & 1) == 0 ? ms2 - deviation : ms2 + deviation;
    }
    return Math.min(ms2, this.max) | 0;
  };
  Backoff.prototype.reset = function() {
    this.attempts = 0;
  };
  Backoff.prototype.setMin = function(min) {
    this.ms = min;
  };
  Backoff.prototype.setMax = function(max) {
    this.max = max;
  };
  Backoff.prototype.setJitter = function(jitter) {
    this.jitter = jitter;
  };
  var debug$1 = debugModule("socket.io-client:manager");
  var Manager = /* @__PURE__ */ (function(_Emitter) {
    function Manager2(uri, opts) {
      var _this;
      var _a;
      _this = _Emitter.call(this) || this;
      _this.nsps = {};
      _this.subs = [];
      if (uri && "object" === _typeof(uri)) {
        opts = uri;
        uri = void 0;
      }
      opts = opts || {};
      opts.path = opts.path || "/socket.io";
      _this.opts = opts;
      installTimerFunctions(_this, opts);
      _this.reconnection(opts.reconnection !== false);
      _this.reconnectionAttempts(opts.reconnectionAttempts || Infinity);
      _this.reconnectionDelay(opts.reconnectionDelay || 1e3);
      _this.reconnectionDelayMax(opts.reconnectionDelayMax || 5e3);
      _this.randomizationFactor((_a = opts.randomizationFactor) !== null && _a !== void 0 ? _a : 0.5);
      _this.backoff = new Backoff({
        min: _this.reconnectionDelay(),
        max: _this.reconnectionDelayMax(),
        jitter: _this.randomizationFactor()
      });
      _this.timeout(null == opts.timeout ? 2e4 : opts.timeout);
      _this._readyState = "closed";
      _this.uri = uri;
      var _parser = opts.parser || parser;
      _this.encoder = new _parser.Encoder();
      _this.decoder = new _parser.Decoder();
      _this._autoConnect = opts.autoConnect !== false;
      if (_this._autoConnect) _this.open();
      return _this;
    }
    _inheritsLoose(Manager2, _Emitter);
    var _proto = Manager2.prototype;
    _proto.reconnection = function reconnection(v) {
      if (!arguments.length) return this._reconnection;
      this._reconnection = !!v;
      if (!v) {
        this.skipReconnect = true;
      }
      return this;
    };
    _proto.reconnectionAttempts = function reconnectionAttempts(v) {
      if (v === void 0) return this._reconnectionAttempts;
      this._reconnectionAttempts = v;
      return this;
    };
    _proto.reconnectionDelay = function reconnectionDelay(v) {
      var _a;
      if (v === void 0) return this._reconnectionDelay;
      this._reconnectionDelay = v;
      (_a = this.backoff) === null || _a === void 0 ? void 0 : _a.setMin(v);
      return this;
    };
    _proto.randomizationFactor = function randomizationFactor(v) {
      var _a;
      if (v === void 0) return this._randomizationFactor;
      this._randomizationFactor = v;
      (_a = this.backoff) === null || _a === void 0 ? void 0 : _a.setJitter(v);
      return this;
    };
    _proto.reconnectionDelayMax = function reconnectionDelayMax(v) {
      var _a;
      if (v === void 0) return this._reconnectionDelayMax;
      this._reconnectionDelayMax = v;
      (_a = this.backoff) === null || _a === void 0 ? void 0 : _a.setMax(v);
      return this;
    };
    _proto.timeout = function timeout(v) {
      if (!arguments.length) return this._timeout;
      this._timeout = v;
      return this;
    };
    _proto.maybeReconnectOnOpen = function maybeReconnectOnOpen() {
      if (!this._reconnecting && this._reconnection && this.backoff.attempts === 0) {
        this.reconnect();
      }
    };
    _proto.open = function open(fn) {
      var _this2 = this;
      debug$1("readyState %s", this._readyState);
      if (~this._readyState.indexOf("open")) return this;
      debug$1("opening %s", this.uri);
      this.engine = new Socket$1(this.uri, this.opts);
      var socket = this.engine;
      var self2 = this;
      this._readyState = "opening";
      this.skipReconnect = false;
      var openSubDestroy = on(socket, "open", function() {
        self2.onopen();
        fn && fn();
      });
      var onError = function onError2(err) {
        debug$1("error");
        _this2.cleanup();
        _this2._readyState = "closed";
        _this2.emitReserved("error", err);
        if (fn) {
          fn(err);
        } else {
          _this2.maybeReconnectOnOpen();
        }
      };
      var errorSub = on(socket, "error", onError);
      if (false !== this._timeout) {
        var timeout = this._timeout;
        debug$1("connect attempt will timeout after %d", timeout);
        var timer = this.setTimeoutFn(function() {
          debug$1("connect attempt timed out after %d", timeout);
          openSubDestroy();
          onError(new Error("timeout"));
          socket.close();
        }, timeout);
        if (this.opts.autoUnref) {
          timer.unref();
        }
        this.subs.push(function() {
          _this2.clearTimeoutFn(timer);
        });
      }
      this.subs.push(openSubDestroy);
      this.subs.push(errorSub);
      return this;
    };
    _proto.connect = function connect(fn) {
      return this.open(fn);
    };
    _proto.onopen = function onopen() {
      debug$1("open");
      this.cleanup();
      this._readyState = "open";
      this.emitReserved("open");
      var socket = this.engine;
      this.subs.push(
        on(socket, "ping", this.onping.bind(this)),
        on(socket, "data", this.ondata.bind(this)),
        on(socket, "error", this.onerror.bind(this)),
        on(socket, "close", this.onclose.bind(this)),
        // @ts-ignore
        on(this.decoder, "decoded", this.ondecoded.bind(this))
      );
    };
    _proto.onping = function onping() {
      this.emitReserved("ping");
    };
    _proto.ondata = function ondata(data) {
      try {
        this.decoder.add(data);
      } catch (e) {
        this.onclose("parse error", e);
      }
    };
    _proto.ondecoded = function ondecoded(packet) {
      var _this3 = this;
      nextTick(function() {
        _this3.emitReserved("packet", packet);
      }, this.setTimeoutFn);
    };
    _proto.onerror = function onerror(err) {
      debug$1("error", err);
      this.emitReserved("error", err);
    };
    _proto.socket = function socket(nsp, opts) {
      var socket2 = this.nsps[nsp];
      if (!socket2) {
        socket2 = new Socket(this, nsp, opts);
        this.nsps[nsp] = socket2;
      } else if (this._autoConnect && !socket2.active) {
        socket2.connect();
      }
      return socket2;
    };
    _proto._destroy = function _destroy(socket) {
      var nsps = Object.keys(this.nsps);
      for (var _i = 0, _nsps = nsps; _i < _nsps.length; _i++) {
        var nsp = _nsps[_i];
        var _socket = this.nsps[nsp];
        if (_socket.active) {
          debug$1("socket %s is still active, skipping close", nsp);
          return;
        }
      }
      this._close();
    };
    _proto._packet = function _packet(packet) {
      debug$1("writing packet %j", packet);
      var encodedPackets = this.encoder.encode(packet);
      for (var i2 = 0; i2 < encodedPackets.length; i2++) {
        this.engine.write(encodedPackets[i2], packet.options);
      }
    };
    _proto.cleanup = function cleanup() {
      debug$1("cleanup");
      this.subs.forEach(function(subDestroy) {
        return subDestroy();
      });
      this.subs.length = 0;
      this.decoder.destroy();
    };
    _proto._close = function _close() {
      debug$1("disconnect");
      this.skipReconnect = true;
      this._reconnecting = false;
      this.onclose("forced close");
    };
    _proto.disconnect = function disconnect() {
      return this._close();
    };
    _proto.onclose = function onclose(reason, description) {
      var _a;
      debug$1("closed due to %s", reason);
      this.cleanup();
      (_a = this.engine) === null || _a === void 0 ? void 0 : _a.close();
      this.backoff.reset();
      this._readyState = "closed";
      this.emitReserved("close", reason, description);
      if (this._reconnection && !this.skipReconnect) {
        this.reconnect();
      }
    };
    _proto.reconnect = function reconnect() {
      var _this4 = this;
      if (this._reconnecting || this.skipReconnect) return this;
      var self2 = this;
      if (this.backoff.attempts >= this._reconnectionAttempts) {
        debug$1("reconnect failed");
        this.backoff.reset();
        this.emitReserved("reconnect_failed");
        this._reconnecting = false;
      } else {
        var delay = this.backoff.duration();
        debug$1("will wait %dms before reconnect attempt", delay);
        this._reconnecting = true;
        var timer = this.setTimeoutFn(function() {
          if (self2.skipReconnect) return;
          debug$1("attempting reconnect");
          _this4.emitReserved("reconnect_attempt", self2.backoff.attempts);
          if (self2.skipReconnect) return;
          self2.open(function(err) {
            if (err) {
              debug$1("reconnect attempt error");
              self2._reconnecting = false;
              self2.reconnect();
              _this4.emitReserved("reconnect_error", err);
            } else {
              debug$1("reconnect success");
              self2.onreconnect();
            }
          });
        }, delay);
        if (this.opts.autoUnref) {
          timer.unref();
        }
        this.subs.push(function() {
          _this4.clearTimeoutFn(timer);
        });
      }
    };
    _proto.onreconnect = function onreconnect() {
      var attempt = this.backoff.attempts;
      this._reconnecting = false;
      this.backoff.reset();
      this.emitReserved("reconnect", attempt);
    };
    return Manager2;
  })(Emitter);
  var debug = debugModule("socket.io-client");
  var cache = {};
  function lookup(uri, opts) {
    if (_typeof(uri) === "object") {
      opts = uri;
      uri = void 0;
    }
    opts = opts || {};
    var parsed = url(uri, opts.path || "/socket.io");
    var source = parsed.source;
    var id = parsed.id;
    var path = parsed.path;
    var sameNamespace = cache[id] && path in cache[id]["nsps"];
    var newConnection = opts.forceNew || opts["force new connection"] || false === opts.multiplex || sameNamespace;
    var io;
    if (newConnection) {
      debug("ignoring socket cache for %s", source);
      io = new Manager(source, opts);
    } else {
      if (!cache[id]) {
        debug("new io instance for %s", source);
        cache[id] = new Manager(source, opts);
      }
      io = cache[id];
    }
    if (parsed.query && !opts.query) {
      opts.query = parsed.queryKey;
    }
    return io.socket(parsed.path, opts);
  }
  _extends(lookup, {
    Manager: Manager,
    Socket: Socket,
    io: lookup,
    connect: lookup
  });
  return lookup;
}));
