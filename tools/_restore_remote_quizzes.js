/* 把被誤刪的遠端獨有試卷從 git 歷史還原回 main。
 *
 * 背景：tools/_push_repair.js 以 base_tree 增量推送，並把「遠端有、本機沒有」
 * 的檔案當成「該刪」送出去。這次誤刪了三個由其他裝置發佈的試卷。
 * 本工具從指定 commit 取回那些 blob，用同一個 sha 再放回新 tree。
 *
 * 用法：node tools/_restore_remote_quizzes.js <TOKEN> <source-commit-sha> <path...>
 */
const https = require('https');
const TOKEN = process.argv[2];
const SRC_COMMIT = process.argv[3];
const PATHS = process.argv.slice(4);

const OWNER = '2w2wqian-pixel';
const REPO = 'reading-quiz';
const BRANCH = 'main';

if (!TOKEN || !SRC_COMMIT || !PATHS.length) {
  console.error('用法：node tools/_restore_remote_quizzes.js <TOKEN> <source-commit> <path...>');
  process.exit(1);
}

function api(method, p, body) {
  return new Promise(function (res, rej) {
    const data = body ? JSON.stringify(body) : null;
    const req = https.request({
      hostname: 'api.github.com', path: p, method: method,
      headers: {
        'User-Agent': 'rq-restore',
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Authorization': 'Bearer ' + TOKEN,
        ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {})
      }
    }, function (r) {
      let b = ''; r.on('data', d => b += d);
      r.on('end', () => {
        let j = null; try { j = JSON.parse(b); } catch (e) { }
        if (r.statusCode >= 400) return rej(new Error('HTTP ' + r.statusCode + ' ' + p + ' :: ' + b.slice(0, 300)));
        res(j);
      });
    });
    req.on('error', rej);
    if (data) req.write(data);
    req.end();
  });
}

(async function () {
  const ref = await api('GET', '/repos/' + OWNER + '/' + REPO + '/git/ref/heads/' + BRANCH);
  const head = ref.object.sha;
  console.log('目前遠端 main =', head.slice(0, 8));

  const headCommit = await api('GET', '/repos/' + OWNER + '/' + REPO + '/git/commits/' + head);
  const headTree = headCommit.tree.sha;

  const src = await api('GET', '/repos/' + OWNER + '/' + REPO + '/git/commits/' + SRC_COMMIT);
  const st = await api('GET', '/repos/' + OWNER + '/' + REPO + '/git/trees/' + src.tree.sha + '?recursive=1');
  const lookup = {};
  st.tree.forEach(function (e) { if (e.type === 'blob') lookup[e.path] = e.sha; });

  const entries = [];
  for (const p of PATHS) {
    const sha = lookup[p];
    if (!sha) { console.log('⚠ 來源 commit 找不到：', p); continue; }
    /* 用同一個 blob sha 放回（內容位元組完全相同，不會產生差異 blob） */
    entries.push({ path: p, mode: '100644', type: 'blob', sha: sha });
    console.log('↩ 還原', p, '=', sha.slice(0, 8));
  }
  if (!entries.length) { console.log('沒有可還原的檔案。'); return; }

  const newTree = await api('POST', '/repos/' + OWNER + '/' + REPO + '/git/trees',
    { base_tree: headTree, tree: entries });
  console.log('新 tree =', newTree.sha.slice(0, 8));

  const who = { name: '2w2wqian-pixel', email: 'teacher@example.com', date: new Date().toISOString() };
  const commit = await api('POST', '/repos/' + OWNER + '/' + REPO + '/git/commits', {
    message: '還原被誤刪的遠端試卷（' + entries.length + ' 份）\n\n推送工具把「遠端有、本機沒有」一律視為該刪，\n誤刪了由其他裝置發佈的試卷。此處自歷史取回原檔。',
    tree: newTree.sha, parents: [head], author: who, committer: who
  });
  console.log('新 commit =', commit.sha.slice(0, 8));

  await api('PATCH', '/repos/' + OWNER + '/' + REPO + '/git/refs/heads/' + BRANCH,
    { sha: commit.sha, force: false });

  const after = await api('GET', '/repos/' + OWNER + '/' + REPO + '/git/ref/heads/' + BRANCH);
  console.log('\n✅ 遠端 main 現在 =', after.object.sha.slice(0, 8));
})().catch(function (e) {
  console.error('\n❌ 還原失敗：' + e.message);
  process.exit(1);
});
