import concurrent.futures
import hashlib
import json
from pathlib import Path
import statistics
import sys
import time
import urllib.error
import urllib.request

endpoint, capture_dir, output = sys.argv[1:]
config = json.loads((Path(__file__).parent / '.generated/freshness-wrangler.json').read_text())
fixture = json.loads((Path(capture_dir) / 'fixture.json').read_text())
reference = (Path(capture_dir) / 'reference.html').read_bytes()
token = config['vars']['TEST_TOKEN']
route = fixture['pathname']
checks = []


def request(path, method='GET', data=None, headers=None):
    payload = None if data is None else json.dumps(data).encode()
    req = urllib.request.Request(endpoint + path, data=payload, method=method, headers=headers or {})
    try:
        response = urllib.request.urlopen(req, timeout=30)
    except urllib.error.HTTPError as error:
        response = error
    with response:
        return response.status, response.headers, response.read()


def control(name, data=None, status=204):
    result = request('/_spike/' + name, 'GET' if name in ('state', 'queries') else 'POST', data,
                     {'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'})
    assert result[0] == status, (name, result)
    return json.loads(result[2]) if result[2] and result[0] < 300 else None


def state():
    return control('state', status=200)


def commit(changes):
    return control('commit', {'expected': state()['revision'], 'changes': changes}, status=200)['revision']


def until(predicate):
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(0.01)
    raise AssertionError('timed out waiting for render to pause')


assert request('/_spike/state')[0] == 403
assert request(route + '?unsupported=1')[0] == 404
assert request(route, method='POST')[0] == 405
checks.append('test controls require authorization; unsupported routes, parameters and methods rejected')

commit(fixture['queries'])
initial = request(route)
assert initial[0] == 200 and initial[2] == reference
assert initial[1]['X-Render-Source'] == 'rendered'
assert initial[1]['Cache-Control'] == 'public, no-cache, must-revalidate'
assert 'Set-Cookie' not in initial[1]
etag = initial[1]['ETag']
assert etag == '"' + hashlib.sha256(reference).hexdigest() + '"'
unchanged = request(route, headers={'If-None-Match': '"unrelated", W/' + etag})
assert unchanged[0] == 304 and unchanged[2] == b''
assert request(route, method='HEAD')[2] == b''
checks.append('real M-SSR is byte-identical to Deno reference; public HTML, ETag, HEAD and 304')

changed = json.loads(json.dumps(fixture['queries']).replace('Flamengo-RJ', 'Flamengo Atualizado'))
revision = commit(changed)
updated = request(route, headers={'If-None-Match': etag})
assert updated[0] == 200 and b'Flamengo Atualizado' in updated[2]
assert updated[1]['X-Data-Revision'] == str(revision)
assert updated[1]['ETag'] != etag
checks.append('acknowledged commit forces fresh HTML even with previous ETag')

# The first update succeeds before the second fails inside transactionSync.
before = state()
first_key = next(iter(changed))
control('commit', {'expected': before['revision'], 'changes': {
    first_key: fixture['queries'][first_key], 'uncaptured': [],
}}, status=500)
assert state()['revision'] == before['revision']
assert control('queries', status=200) == changed
assert request(route)[2] == updated[2]
control('commit', {'expected': before['revision'] - 1, 'changes': fixture['queries']}, status=500)
assert state()['revision'] == before['revision']
checks.append('partial writes roll back with revision; conflicting writer rejected')

commit(fixture['queries'])
control('pause')
before = state()
with concurrent.futures.ThreadPoolExecutor(max_workers=9) as pool:
    old = pool.submit(request, route)
    until(lambda: state()['paused'])
    revision = commit(changed)
    fresh = [pool.submit(request, route) for _ in range(8)]
    control('resume')
    old_result = old.result()
    results = [future.result() for future in fresh]
assert old_result[2] == reference
assert old_result[1]['X-Data-Revision'] == str(revision - 1)
assert all(result[2] == updated[2] and result[1]['X-Data-Revision'] == str(revision) for result in results)
assert state()['renders'] == before['renders'] + 2
assert all(doc['revision'] == revision for doc in state()['documents'])
checks.append('commit during paused render: old snapshot consistent; eight later requests share new render')

commit(fixture['queries'])
control('fail')
assert request(route)[0] == 500
assert state()['documents'] == []
assert request(route)[2] == reference
checks.append('render failure returns 500 with no stale document; next request recovers')

root_key = next(key for key in fixture['queries'] if json.loads(key)[0] == 'team_championship')
commit({root_key: []})
assert request(route)[0] == 404
commit({root_key: fixture['queries'][root_key]})
assert request(route)[2] == reference
checks.append('deletion yields 404; insertion invalidates the retained 404')

before = state()
control('evict', status=500)
after = state()
assert before['born'] != after['born'] and after['renders'] == 0
cold = request(route)
assert cold[2] == reference and cold[1]['X-Render-Source'] == 'stored'
assert state()['renders'] == 0
checks.append('Durable Object eviction preserves committed revision and HTML without rerender')

hits = []
for _ in range(100):
    started = time.perf_counter()
    assert request(route)[2] == reference
    hits.append((time.perf_counter() - started) * 1000)
dirty = []
for _ in range(20):
    commit(fixture['queries'])
    started = time.perf_counter()
    assert request(route)[2] == reference
    dirty.append((time.perf_counter() - started) * 1000)


def timings(samples):
    return {'requests': len(samples), 'medianWallMs': statistics.median(samples),
            'p95WallMs': sorted(samples)[int(len(samples) * .95) - 1]}


report = {'checks': checks, 'referenceBytes': len(reference), 'referenceSha256': hashlib.sha256(reference).hexdigest(),
          'validatedHits': timings(hits), 'dirtyRenders': timings(dirty), 'finalState': state(),
          'scope': 'Local workerd, SQLite authority over captured public query results. Mutation transport, snapshot isolation and actual M-SSR exercised; live database, remote latency, Free-plan enforcement and production memory fit not established.'}
Path(output).write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps(report, indent=2))
