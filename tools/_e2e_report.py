# 解析 E2E beacon 打回 server log 的結果並印成 PASS/FAIL。
# 用法：python tools/_e2e_report.py "<比對到的 __e2e?r=... 字串>"
import sys, urllib.parse

raw = sys.argv[1]
line = urllib.parse.unquote(raw.split('r=', 1)[1] if 'r=' in raw else raw)
print('RESULT:', line[:200].replace('||', ' | '))

if not line.startswith('START') or not line.endswith('END'):
    print('MALFORMED RESULT')
    raise SystemExit(1)

npass = nfail = 0
for part in line[5:-3].split('||'):
    if part.startswith('PASS::'):
        npass += 1
        print('  PASS  ' + part[6:])
    elif part.startswith('FAIL::'):
        nfail += 1
        print('  FAIL  ' + part[6:].replace('::', ' :: '))
    elif part.startswith('ERRS::'):
        v = part.split('::', 1)[1] if '::' in part else ''
        if v.strip() and v.strip() != 'undefined':
            print('  JS ERRORS: ' + v)
    elif part.startswith('FATAL::'):
        v = part.split('::', 1)[1] if '::' in part else ''
        if v.strip() and v.strip() != 'undefined':
            print('  FATAL: ' + v)
print('SUMMARY: %d pass / %d fail' % (npass, nfail))
raise SystemExit(1 if nfail else 0)
