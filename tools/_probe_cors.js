/* 探針：確認某個 API「能不能從瀏覽器直接呼叫」（純前端專案最常踩的雷）。
   只看 CORS 標頭，不看回應內容——重點是瀏覽器會不會擋。

   為什麼需要這支：接一個新的 AI／資料服務時，「API 能不能用」跟
   「瀏覽器能不能直接打」是兩件事。很多服務 API 完全正常，
   但沒有 CORS 標頭，純前端（GitHub Pages）就是打不通。
   反過來，有些服務對 OPTIONS 預檢回得很完整，那就一定通。

   用法：
     node tools/_probe_cors.js <host> [path] [origin]
     node tools/_probe_cors.js api.deepseek.com /v1/chat/completions
     node tools/_probe_cors.js openrouter.ai /api/v1/models
     node tools/_probe_cors.js api.openai.com /v1/models https://example.github.io

   判讀：
     · allow-origin 有值（`*` 或你的來源）→ ✅ 可以直呼
     · allow-origin 是 (none)              → ❌ 一定要代理（掛 Apps Script／Worker）
     · OPTIONS 沒回應 → 只要請求帶 Authorization 就一定會被預檢擋下
                        （除非改用 query string 帶金鑰，見 skill 說明）
   注意：這支只用來「看標頭」，不會帶任何金鑰，所以很安全；
        沒有金鑰時伺服器多半回 401，那是正常的，不代表 CORS 有問題。 */
const https = require('https');

/**
 * Git for Windows（MSYS）會把「開頭是 / 的參數」當成路徑自動轉換，
 * 例如 `/v1/chat/completions` 會變成
 *   C:/…/PortableGit/versions/1.2.0/v1/chat/completions
 * 結果探針打到不存在的路徑、拿到一個假的 400，然後誤判成「CORS 不通」。
 * 這裡把那段安裝目錄切回來。（也可以改用 `MSYS_NO_PATHCONV=1 node …` 避免。）
 */
function unmangle(p) {
  const s = String(p == null ? '' : p);
  /* 只吃掉「Git 自己的安裝目錄」那一段，不要把 API 路徑也當成目錄吃掉
     （先前用貪婪式的 .* 會把 /v1/chat/completions 誤切成 /completions） */
  const m = s.match(/^[A-Za-z]:[\\/].*?[\\/](?:PortableGit|Git)[\\/](?:(?:versions|cmd|bin|mingw64|usr)[\\/](?:\d[\w.\-]*[\\/])?)?(.*)$/);
  if (m) { unmangle.hit = true; return '/' + m[1].replace(/\\/g, '/'); }
  return s.charAt(0) === '/' ? s : '/' + s;
}

const host = process.argv[2];
/* 允許寫 /v1/models 或 v1/models 兩種（前者在某些 shell 會被轉換） */
const apiPath = unmangle(process.argv[3] || '');
const origin = process.argv[4] || 'https://2w2wqian-pixel.github.io';

if (!host) {
  console.log('用法：node tools/_probe_cors.js <host> [path] [origin]');
  console.log('例如：node tools/_probe_cors.js api.deepseek.com /v1/chat/completions');
  console.log('      node tools/_probe_cors.js openrouter.ai /api/v1/models');
  console.log('提示：Git Bash 若把 /v1/… 誤轉成磁碟路徑，可在前面加 MSYS_NO_PATHCONV=1');
  process.exit(1);
}

function probe(method, path, extra, label) {
  return new Promise(function (res) {
    const headers = Object.assign({ Origin: origin, 'User-Agent': 'rq-cors-probe' }, extra || {});
    const req = https.request({
      host: host, path: path, method: method, timeout: 10000, headers: headers
    }, function (r) {
      const acao = r.headers['access-control-allow-origin'] || '(none)';
      console.log(label);
      console.log('    HTTP ' + r.statusCode);
      console.log('    allow-origin:  ' + acao);
      console.log('    allow-methods: ' + (r.headers['access-control-allow-methods'] || '(none)'));
      console.log('    allow-headers: ' + (r.headers['access-control-allow-headers'] || '(none)'));
      console.log('    => 瀏覽器直呼: ' + (acao !== '(none)' ? '✅ 可行' : '❌ 不行（會被 CORS 擋）'));
      r.resume();
      r.on('end', function () { res(); });
    });
    req.on('timeout', function () {
      console.log(label + '\n    ⏱ TIMEOUT（10 秒無回應）');
      req.destroy(); res();
    });
    req.on('error', function (e) { console.log(label + '\n    ✗ ' + e.message); res(); });
    req.end();
  });
}

(async function () {
  console.log('目標：https://' + host + apiPath + '    來源：' + origin);
  if (unmangle.hit) {
    console.log('（註：Git Bash 把參數轉成了磁碟路徑，已自動還原成上面這個。' +
      '原本傳入：' + process.argv[3] + '）');
  }
  console.log('');
  await probe('GET', apiPath, null, '① GET（看實際回應有沒有帶 CORS 標頭）');
  await probe('OPTIONS', apiPath, {
    'Access-Control-Request-Method': 'POST',
    'Access-Control-Request-Headers': 'authorization,content-type'
  }, '② OPTIONS 預檢（帶 Authorization／Content-Type 時一定會先送這個）');
  console.log('\n完成');
  process.exit(0);
})();
