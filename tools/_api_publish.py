# 用 GitHub Git Data API 把本機 HEAD commit 原樣送上遠端
# （沙箱的 git push 極慢／會卡住，改走 REST API；並重建「完全相同」的 commit，
#   這樣遠端 sha 會等於本機 sha，兩邊不需要再 fetch 對齊。）
import base64, json, re, subprocess, sys, urllib.request, urllib.error
from datetime import datetime, timedelta, timezone

TOKEN = sys.argv[1]
OWNER, REPO, BRANCH = '2w2wqian-pixel', 'reading-quiz', 'main'
API = 'https://api.github.com'


def sh(*args):
    return subprocess.run(args, capture_output=True, check=True).stdout


def api(method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(API + path, data=data, method=method)
    req.add_header('Authorization', 'Bearer ' + TOKEN)
    req.add_header('Accept', 'application/vnd.github+json')
    req.add_header('X-GitHub-Api-Version', '2022-11-28')
    if data:
        req.add_header('Content-Type', 'application/json')
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return json.loads(r.read().decode() or '{}')
    except urllib.error.HTTPError as e:
        print('HTTP', e.code, path, e.read().decode()[:400]); raise


def read_file(path):
    """檔案內容 → 送回傳值（用 git cat-file，確保位元組與 repo 內一致，CRLF/LF 不會跑掉）"""
    out = sh('git', 'cat-file', 'blob', 'HEAD:' + path)
    return base64.b64encode(out).decode()


def main():
    head = sh('git', 'rev-parse', 'HEAD').decode().strip()
    tree = sh('git', 'rev-parse', 'HEAD^{tree}').decode().strip()
    parent = sh('git', 'rev-parse', 'HEAD^').decode().strip()
    raw = sh('git', 'cat-file', 'commit', 'HEAD').decode('utf-8', 'replace')
    message = raw.split('\n\n', 1)[1]

    # 一定要沿用本機 commit 的 author/committer/時間，重建出來的 sha 才會相同
    def ident(line):
        m = re.match(r'^(?:author|committer)\s+(.*?)\s+<([^>]*)>\s+(\d+)\s+([+-]\d{4})$', line)
        if not m:
            raise SystemExit('無法解析 commit 的 ' + line[:20])
        name, mail, epoch, tz = m.group(1), m.group(2), int(m.group(3)), m.group(4)
        sign = 1 if tz[0] == '+' else -1
        offset = timedelta(hours=int(tz[1:3]), minutes=int(tz[3:5])) * sign
        date = datetime.fromtimestamp(epoch, timezone(offset)).isoformat()
        return {'name': name, 'email': mail, 'date': date}

    lines = raw.split('\n')
    my_author = ident([l for l in lines if l.startswith('author ')][0])
    my_committer = ident([l for l in lines if l.startswith('committer ')][0])
    author, committer = my_author, my_committer
    # 變更檔案＝與 parent 的 diff
    diff = sh('git', 'diff', '--name-status', parent, head).decode().strip().split('\n')
    files = []
    for line in diff:
        parts = line.split('\t')
        st, path = parts[0], parts[-1]          # R100 old new → 取最後一個
        if st.startswith('D'):
            files.append((path, None)); continue
        files.append((path, read_file(path)))
    print('變更檔案:', [f[0] for f in files])

    ref = api('GET', '/repos/%s/%s/git/ref/heads/%s' % (OWNER, REPO, BRANCH))
    base = ref['object']['sha']
    print('遠端 main =', base[:8], '（本機 parent =', parent[:8], '）')
    if base != parent:
        print('!! 遠端已前進，中止（請先人工處理）'); sys.exit(2)

    tree_entries = []
    for path, content in files:
        if content is None:
            continue
        blob = api('POST', '/repos/%s/%s/git/blobs' % (OWNER, REPO),
                   {'content': content, 'encoding': 'base64'})
        tree_entries.append({'path': path, 'mode': '100644', 'type': 'blob', 'sha': blob['sha']})
    base_tree = api('GET', '/repos/%s/%s/git/commits/%s' % (OWNER, REPO, base))['tree']['sha']
    new_tree = api('POST', '/repos/%s/%s/git/trees' % (OWNER, REPO),
                   {'base_tree': base_tree, 'tree': tree_entries})
    print('新 tree =', new_tree['sha'][:8], '（本機 tree =', tree[:8], '）',
          'OK' if new_tree['sha'] == tree else '不同（不影響內容，但 sha 會不一樣）')

    commit = api('POST', '/repos/%s/%s/git/commits' % (OWNER, REPO),
                 {'message': message, 'tree': new_tree['sha'], 'parents': [base],
                  'author': author, 'committer': committer})
    print('新 commit =', commit['sha'][:8], '（本機 =', head[:8], '）',
          '相同 ✅' if commit['sha'] == head else '不同（內容相同即可）')

    api('PATCH', '/repos/%s/%s/git/refs/heads/%s' % (OWNER, REPO, BRANCH),
        {'sha': commit['sha'], 'force': False})
    now = api('GET', '/repos/%s/%s/commits/%s' % (OWNER, REPO, BRANCH))
    print('遠端 main 現在 =', now['sha'][:8], '|', now['commit']['message'].split('\n')[0][:40])


main()
