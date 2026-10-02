# Cachelattice

Cachelattice is a content-addressed build cache with a dependency scheduler. It
stores action definitions, computes a stable key for every action, executes the
action graph in dependency order under a concurrency limit, and serves artifacts
out of a content-addressed object store. A second run of the same graph reports
cache hits and returns the exact same bytes.

Requirements: **Node.js 20.6 or newer**, no third-party dependencies.

```bash
node src/cli.js serve --host 127.0.0.1 --port 18091 --data .cachelattice --workspace .
node --test tests/
```

The service prints `Cachelattice listening on http://127.0.0.1:18091` once the
port is bound. `--data` is the object store root; `--workspace` is the directory
that action inputs and command sources resolve against.

## The action key

The action key is **the lowercase hex SHA-256 of a canonical JSON document**, and
it is both the action's identity and its cache key:

```json
{
  "schema": "cachelattice/action-key/v1",
  "command": { "...": "the normalized command" },
  "inputs": [{"digest": "sha256:4fdb…", "kind": "file", "path": "src/app.txt"}],
  "env": {"names": ["LANG"], "values": {"LANG": "en_US.UTF-8"}}
}
```

Exactly these three fields participate. Not the name, not the graph, not the node
id, not the clock, not the ambient process environment. **Canonical JSON** means
object keys sorted by code unit, arrays in the order given after the
normalizations below, no insignificant whitespace and no `undefined`; two
documents serialize identically exactly when they carry the same information in
the same order, so the hash is stable across processes and machines.

**Input normalization.** Each path is normalized once and the same way
everywhere: backslashes become `/`, then `path.posix.normalize`, and the result
must stay inside the workspace (no leading `/`, no drive letter, no `..`). The
list is then **sorted by path**, so declaration order never reaches the key and
`./src/app.txt` and `src/app.txt` are one input.

- `{"kind":"file","path":"p"}` — at registration the service reads `p`, hashes
  the bytes as `sha256:<hex>` and stores that digest in the input. A request may
  not supply a digest for a file input. Changing the file changes the key.
- `{"kind":"hash","path":"p","digest":"<64 hex>"}` — a precomputed reference to
  another action's key, which is how one action consumes another's artifact. The
  format is plain lowercase hex with no `sha256:` prefix, so a key pastes
  straight out of a run or cache response into the next action's input list.

**Environment normalization.** `env` lists variable **names**. Their values are
read from the service's own environment and recorded as
`{"names":[…],"values":{…}}` with `names` sorted; registration fails if a named
variable is unset. The ambient environment is never hashed wholesale, so
unrelated variables cannot cause misses.

**Command normalization.** Paths inside a command are normalized like inputs;
`substitute-text` replacements are sorted by `find`; `template-hash` fields are
sorted and de-duplicated; `concat-text` keeps its declared `sources` order
because that order *is* its meaning.

| kind | canonical fields | artifact |
| --- | --- | --- |
| `copy-file` | `source` | bytes of `source` |
| `write-file` | `content` | literal `content`, UTF-8, no added newline |
| `concat-text` | `sources[]`, `separator` (default `"\n"`) | sources joined with `separator` |
| `substitute-text` | `source`, `replacements[]` sorted by `find` | each `find` replaced by `replace`, in sorted order |
| `filter-lines` | `source`, `pattern`, `match` (`keep`\|`drop`), `keep_final_newline` (default `true`) | matching lines joined with `\n`, plus a final newline when kept |
| `template-hash` | `fields[]` sorted | canonical JSON of the named env values, the inputs and the dependencies, plus `\n` |

Every command is a **pure function of bytes the key already covers**, which is
what makes a hit and a miss indistinguishable.

**Node keys.** A node with no dependencies uses its action key verbatim; one with
dependencies uses

```
node_key = sha256("cachelattice/node-key/v1\n" + action_key + "\n" + sort(dependency_node_keys).join("\n"))
```

so a change anywhere upstream moves every key downstream of it. An action
declares its producers in `depends_on`, must list each producer's key as a `hash`
input, and the graph must wire exactly those producers as its `needs`; a mismatch
is a `409`, never silent.

## Object store layout

`--data` (default `.cachelattice`) contains only content-addressed files:

```
<data>/blobs/sha256/<d0d1>/<digest-hex>   artifact bytes, named by their own SHA-256
<data>/manifests/<k0k1>/<key>.json        node key -> manifest (canonical JSON + "\n")
<data>/meta/actions/<name>.json           registered action
<data>/meta/graphs/<id>.json              registered graph
<data>/meta/graphs/<id>.last-run.json     materialized result of the last run
<data>/meta/index/<kind>.json             ids present in each registry
<data>/meta/idempotency/<hex>.json        first response for an Idempotency-Key
<data>/meta/stats.json                    lifetime counters
```

A blob is written once, under the digest of its own bytes, by writing a temporary
file and renaming it; an existing blob is never rewritten. A manifest is derived
only from the normalized action, the resolved dependency keys and the artifact
digest — **no timestamp, no node id, no memo of whether it was computed or read
back**:

```json
{
  "schema": "cachelattice/manifest/v1",
  "key_schema": "cachelattice/action-key/v1",
  "action_id": "filter-3b5daa1236a5",
  "key": "e71afcbf…",
  "command": {"…": "normalized"},
  "inputs": [{"digest": "sha256:4fdb…", "kind": "file", "path": "src/app.txt"}],
  "env": {"names": ["LANG"], "values": {"LANG": "en_US.UTF-8"}},
  "dependency_run_key": "sha256…",
  "dependencies": [{"action_id": "producer", "key": "…"}],
  "digest": "sha256:4fdbc441…",
  "size": 17
}
```

## Why a hit and a miss produce identical bytes

1. **The key determines the artifact, not the run.** `key = H(command, inputs,
   env)` and every command is a pure function of exactly those values, so two runs
   that compute one key compute the same function of the same bytes. Node keys
   extend this to dependencies by folding in dependency node keys, which in turn
   determine the upstream artifacts.
2. **The miss path stores under the content address.** A miss executes the
   command, hashes the result and writes it to `blobs/sha256/<digest>`; the
   manifest names that digest. The manifest is canonical JSON with no run-varying
   field, so the hit path re-reads bit-for-bit what the miss path wrote.
3. **The hit path never re-derives the artifact.** It reads the manifest, reads
   the blob the manifest names, and re-verifies `sha256(bytes) == manifest.digest`.
   A hit therefore returns bytes that passed that check; a corrupted or
   substituted blob is reported, never served.
4. **A miss cannot overwrite a hit.** Blobs are keyed by content, so two writers of
   identical bytes target one path; if two concurrent misses race on one key they
   compute the same bytes, and the `if (!hasManifest) writeManifest` guard leaves
   the first manifest in place, byte-identical to the second anyway.

`POST /graphs/{id}/verify` turns that argument into an executable check: it
re-executes every node with cache reads disabled and compares the result against
what the cache held, by digest and byte by byte. It reports `identical: true`
with `byte_identical` equal to the node count, or `issues` naming
`digest_changed`, `bytes_differ` or `cache_unreadable`.

One deliberate consequence: an action whose input changed but which recomputes to
the same bytes still invalidates every downstream node, because a node key folds
in the upstream *key*, not the upstream artifact digest. Invalidation is
conservative and can only do extra work, never serve a stale artifact.

## HTTP API

All bodies are JSON unless stated otherwise, unknown fields are rejected, and
errors use `{"error":{"code":"<snake_case>","message":"…"}}`: validation `400`,
missing `404`, conflict `409`.

### `GET /health`

`{"service":"cachelattice","status":"ok"}`.

### `POST /actions` · `PUT /actions/{name}` · `GET /actions[/{name}]`

```json
{
  "name": "filter",
  "command": {"kind": "filter-lines", "source": "src/app.txt", "pattern": "a", "match": "keep"},
  "inputs": [{"kind": "file", "path": "src/app.txt"}],
  "env": ["LANG"],
  "depends_on": []
}
```

`201` with `{name, action_id, key, command, inputs, env, env_values,
depends_on}`. A name is claimed once: `POST` on a taken name is `409`, and
`PUT /actions/{name}` is the only way to change a definition. `POST /actions`
and `POST /graphs` are idempotent under `Idempotency-Key`.

### `POST /graphs` · `PUT /graphs/{id}` · `GET /graphs/{id}`

```json
{
  "id": "build",
  "concurrency": 2,
  "limits": {"cpu": 2},
  "nodes": [
    {"id": "filter", "action": "filter", "resources": {"cpu": 1}},
    {"id": "bundle", "action": "bundle", "needs": ["filter"]}
  ]
}
```

`201` with the stored graph. Node ids are unique, actions must be registered, and
`needs` must name nodes **defined earlier in the array** — a cycle is therefore
impossible and is reported as a validation error. `concurrency` defaults to `1`
and must be an integer in `1..64`. `GET /graphs/{id}` adds `last_run` (or `null`).

**Resource quotas.** `limits` (graph level) and `resources` (node level) are
optional plain objects, both defaulting to `{}`. A resource name is 1–32
characters: an ASCII letter followed by ASCII letters, digits, `_` or `-`.
Limit values are integers in `1..1000000`, resource values integers in
`0..1000000`, and every resource a node reserves must name a graph limit it
does not exceed. A violation is a `400` and leaves the stored graph untouched.
These declarations only gate **when** a node may start; they never enter the
action key, node key, run key, manifest or artifact bytes, and quotas are
independent across graphs.

### `POST /graphs/{id}/run`

Body `{}` or `{"use_cache": false}`. Every run is scheduled, so each node's
`cache` field is the real answer from the store:

```json
{
  "cache_hits": 2, "cache_misses": 0, "graph_id": "build", "peak_parallel": 1,
  "plan_reused": true,
  "resource_limits": {"cpu": 2}, "peak_resources": {"cpu": 1},
  "nodes": [
    {"action": "bundle", "cache": "hit", "dependencies": [{"action_id": "filter", "key": "e71afcbf…"}],
     "digest": "sha256:1e6ed65d…", "id": "bundle", "key": "6bd590cb…", "resources": {}, "size": 6},
    {"action": "filter", "cache": "hit", "dependencies": [],
     "digest": "sha256:4fdbc441…", "id": "filter", "key": "e71afcbf…", "resources": {"cpu": 1}, "size": 17}
  ],
  "run_key": "921010ee…", "stale_nodes": []
}
```

Nodes are dispatched in lexicographic id order, at most `concurrency` at a time,
and never before every node they `needs` is `done`. A ready node starts only
when its `resources` also fit inside the graph's `limits` alongside whatever is
already reserved; a candidate that does not fit is skipped for now, so it never
blocks later ready nodes. Reservations are held for the whole node — cache hit
or miss alike — and released the moment it completes or fails. The run response
adds `resource_limits` (the graph's `limits`), `peak_resources` (the high-water
mark of simultaneous reservations per declared limit, `0` when never used) and
each node's `resources`; all three are empty objects when nothing is declared.
`stale_nodes` lists nodes whose key moved since the previous run, and `run_key`
hashes the resolved `(action_id, key)` pairs. With `use_cache: false` the answer
is recomputed while the store is still written, which forces a miss without
corrupting anything.

### `GET /stats`

`{"actions_registered":2,"artifacts_executed":6,"cache_entries":2,"cache_hits":2,
"cache_misses":6,"cache_writes":6,"graph_runs":4,"graphs_registered":1,
"nodes_scheduled":8,"remote_reads":3,"remote_writes":0,
"schema":"cachelattice/stats/v1"}`.

### `GET /cache/{key}` and `GET /cache`

Returns the raw artifact bytes with `content-type: application/octet-stream` and
`x-cache-key`, `x-cache-digest`, `x-cache-size` headers; `{key}` is any node key,
usually one taken from a run response. `?meta=1` returns
`{key, action_id, digest, size, command, key_schema}` instead of the bytes, and
`GET /cache` lists the stored keys.

### `PUT /cache/{key}` — remote cache protocol subset

The body is the raw artifact; the claimed entry is described by headers, and it is
accepted only when those fields recompute to exactly `{key}`:

```http
PUT /cache/e71afcbf…
Content-Type: application/octet-stream
X-Cache-Action: peer
X-Cache-Command: {"kind":"filter-lines",…}
X-Cache-Inputs: [{"kind":"file","path":"src/app.txt","digest":"sha256:4fdb…"}]
X-Cache-Env: ["LANG"]
```

`201` with `{key, digest, size}`, `400` when the fields hash to another key, `409`
when the entry exists. A peer-supplied entry carries no resolved dependency keys,
so it is reachable as the entry of a root node — exactly the entries a peer can
hand over without shipping its graph.

### `POST /cache/gc`

Body `{}` or `{"keep": ["<64 hex>", …], "dry_run": true}`; both fields are
optional, `keep` may be empty and `dry_run` defaults to `false`. The keep set is
the node keys of every registered graph's `last_run` (a graph that never ran
contributes nothing) plus the `keep` keys, which are de-duplicated and must each
name an existing cache entry (`404` otherwise). Every manifest is scanned and
validated first — an unreadable manifest, a key mismatch, a missing or malformed
digest, or a missing or tampered blob is a `400` and deletes nothing — then every
entry outside the keep set is removed: its manifest, the blobs only the removed
manifests referenced, and orphan blobs.

`200` with `{dry_run, kept_keys, removed_keys, removed_digests, kept_bytes,
removed_bytes}`; the key and digest arrays are sorted and duplicate-free,
`kept_bytes` is the total size of the distinct blobs the kept manifests
reference, and `removed_bytes` the total size of the distinct blobs deleted. A
dry run reports the same sets and byte counts without deleting anything.

`POST /graphs/{id}/run` also honours `Idempotency-Key`: the first response is
persisted under `meta/idempotency/` and a repeat with that key returns the stored
status and body without re-executing anything. Keys are scoped to the request
target.

## CLI

```bash
node src/cli.js serve [--host H] [--port P] [--data DIR] [--workspace DIR]
node src/cli.js run --graph ID [--data DIR] [--workspace DIR] [--out FILE] [--no-cache]
node src/cli.js stats [--data DIR] [--workspace DIR]
node src/cli.js gc [--data DIR] [--workspace DIR] [--keep KEY]... [--dry-run]
```

`run` prints the same JSON as the HTTP run endpoint, and with `--out FILE` it also
materializes the last node's artifact. `stats` prints the counters and cached keys.
`gc` prints the same JSON as `POST /cache/gc`: `--keep KEY` may be repeated to
retain extra entries and `--dry-run` reports without deleting.

## Tests

```bash
node --test tests/
```

The suite covers key normalization and order-insensitivity, every command's
semantics, path-escape refusal, the object store's addressing and corruption
checks, graph validation, miss-then-hit byte equality, forced recomputation,
concurrency independence, upstream invalidation, remote cache ingestion, and the
HTTP contract including the error envelope.
