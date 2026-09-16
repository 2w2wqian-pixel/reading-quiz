/* ============================================================
   crypto.js — 密碼雜湊（Web Crypto API）
   用途：課堂工具的「防誤入」等級保護，不是真正的安全邊界。
   ============================================================ */
(function (RQ) {
  'use strict';

  var U = RQ.util;

  function buf2hex(buf) {
    var out = '';
    var b = new Uint8Array(buf);
    for (var i = 0; i < b.length; i++) {
      var h = b[i].toString(16);
      out += h.length === 1 ? '0' + h : h;
    }
    return out;
  }

  function sha256(str) {
    var data = new TextEncoder().encode(str);
    // 優先用 WebCrypto；file:// 或舊瀏覽器降級為簡易雜湊（僅維持功能可跑）
    if (window.crypto && window.crypto.subtle && window.isSecureContext !== false) {
      return window.crypto.subtle.digest('SHA-256', data).then(buf2hex).catch(fallback);
    }
    return Promise.resolve(fallback());
    function fallback() {
      // FNV-1a 變體 * 多回合 —— 僅為離線降級用
      var h1 = 0x811c9dc5, h2 = 0x01000193;
      for (var r = 0; r < 3; r++) {
        for (var i = 0; i < str.length; i++) {
          var c = str.charCodeAt(i);
          h1 = (h1 ^ c) >>> 0; h1 = (h1 * 16777619) >>> 0;
          h2 = (h2 + c * (r + 7)) >>> 0; h2 = ((h2 << 5) | (h2 >>> 27)) >>> 0;
        }
      }
      return 'f' + (h1 >>> 0).toString(16) + (h2 >>> 0).toString(16);
    }
  }

  var Crypto = {
    sha256: sha256,

    /** 產生隨機鹽值 */
    salt: function () {
      var a = new Uint8Array(8);
      if (window.crypto && window.crypto.getRandomValues) window.crypto.getRandomValues(a);
      else for (var i = 0; i < a.length; i++) a[i] = Math.floor(Math.random() * 256);
      return buf2hex(a.buffer || a);
    },

    /** 回傳 Promise<string>：「鹽:雜湊」 */
    hashPassword: function (pwd, salt) {
      salt = salt || Crypto.salt();
      return sha256(salt + '||' + String(pwd)).then(function (h) { return salt + ':' + h; });
    },

    /** 驗證明文密碼是否吻合 "salt:hash" */
    verifyPassword: function (pwd, stored) {
      if (!stored) return Promise.resolve(false);
      var idx = String(stored).indexOf(':');
      if (idx < 0) {
        return sha256(String(pwd)).then(function (h) { return h === stored; });
      }
      var salt = stored.slice(0, idx), hash = stored.slice(idx + 1);
      return sha256(salt + '||' + String(pwd)).then(function (h) { return h === hash; });
    }
  };

  RQ.crypto = Crypto;
})(window.RQ);
