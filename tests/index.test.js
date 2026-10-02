import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, afterEach, before, beforeEach, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { canonicalJson, digestOf } from '../src/canonical.js';
import { ConflictError, NotFoundError, ValidationError } from '../src/errors.js';
import { executeArtifact, normalizeCommand } from '../src/executor.js';
import { actionKey, normalizeCacheInputs, normalizeEnv, normalizeInputs, normalizePath } from '../src/key.js';
import { Cachelattice } from '../src/service.js';
import { createServer } from '../src/server.js';
import { ObjectStore } from '../src/store.js';

const AMBIENT = { LANG: 'en_US.UTF-8', CC: 'cc' };
const ZEROS = `sha256:${'0'.repeat(64)}`;
const hex = (char, length = 64) => char.repeat(length);
const fileIn = (file) => ({ kind: 'file', path: file });
const fileWith = (file, digest) => ({ kind: 'file', path: file, digest });
const hashIn = (file, digest) => ({ kind: 'hash', path: file, digest });
const filterCmd = (over = {}) => ({ kind: 'filter-lines', source: 'src/app.txt', pattern: 'a', match: 'keep', ...over });
const keysOf = (run) => Object.fromEntries(run.nodes.map((node) => [node.id, node.key]));

let root;
let workspace;
let service;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'cachelattice-'));
  workspace = path.join(root, 'workspace');
  await mkdir(path.join(workspace, 'src'), { recursive: true });
  await writeFile(path.join(workspace, 'src', 'app.txt'), 'alpha\nbeta\ngamma\n');
  await writeFile(path.join(workspace, 'src', 'head.txt'), '<head>\n');
  await writeFile(path.join(workspace, 'src', 'tail.txt'), '<tail>\n');
  service = new Cachelattice({
    dataDirectory: path.join(root, 'data'),
    workspace,
    ambientEnv: AMBIENT,
    clock: () => new Date('2024-05-05T05:05:05.000Z'),
  });
  await service.loading;
});

afterEach(() => rm(root, { recursive: true, force: true }));

const registerFilter = (name = 'filter', over = {}) =>
  service.putAction({ name, command: filterCmd(over), inputs: [fileIn('src/app.txt')], env: ['LANG'] });

const runOne = async (action = 'filter', id = 'build') => {
  await service.putGraph(id, { id, nodes: [{ id: 'a', action }] });
  return service.runGraph(id);
};

const execute = (command, extra = {}) =>
  executeArtifact({
    command,
    inputs: extra.inputs ?? [fileIn('src/app.txt')],
    env: extra.env ?? { names: [], values: {} },
    dependencies: [],
    workspace,
  });

describe('commands: each is a pure function of its declared inputs', () => {
  const text = async (command, extra) => (await execute(command, extra)).toString();

  test('every command kind has one deterministic output', async () => {
    assert.equal(await text({ kind: 'copy-file', source: 'src/app.txt' }), 'alpha\nbeta\ngamma\n');
    assert.equal(await text({ kind: 'write-file', content: 'hello' }, { inputs: [] }), 'hello');
    assert.equal(
      await text({ kind: 'concat-text', sources: ['src/tail.txt', 'src/head.txt'], separator: '|' }, { inputs: [] }),
      '<tail>\n|<head>\n',
      'concat keeps its declared source order, unlike the input list',
    );
    // Replacements run in sorted find order, so the "A" introduced by the first
    // replacement is not rewritten by the second.
    assert.equal(
      await text({
        kind: 'substitute-text',
        source: 'src/app.txt',
        replacements: [
          { find: 'a', replace: 'A' },
          { find: 'A', replace: 'nested' },
        ],
      }),
      'AlphA\nbetA\ngAmmA\n',
    );
    assert.equal(await text(filterCmd({ pattern: '^a|^g' })), 'alpha\ngamma\n');
    assert.equal(await text(filterCmd({ pattern: '^a|^g', match: 'drop' })), 'beta\n');
    assert.equal(await text(filterCmd({ pattern: '^a|^g', keep_final_newline: false })), 'alpha\ngamma');
    const template = { kind: 'template-hash', fields: ['CC', 'LANG'] };
    const env = { names: ['CC', 'LANG'], values: { CC: 'gcc', LANG: 'C' } };
    const buffer = await execute(template, { inputs: [], env });
    assert.deepEqual(JSON.parse(buffer.toString()).fields, { CC: 'gcc', LANG: 'C' });
    assert.equal(buffer.toString(), `${canonicalJson(JSON.parse(buffer.toString()))}\n`);
    assert.ok(buffer.equals(await execute(template, { inputs: [], env })));
  });

  test('unreadable inputs and unknown commands fail loudly', async () => {
    await assert.rejects(
      execute({ kind: 'copy-file', source: 'src/absent.txt' }, { inputs: [] }),
      (error) => error.code === 'action_failed' && /missing from the workspace/.test(error.message),
    );
    await assert.rejects(
      execute({ kind: 'copy-file', source: 'src/app.txt' }, { inputs: [hashIn('src/app.txt', hex('a'))] }),
      (error) => error.code === 'action_failed' && /precomputed hash/.test(error.message),
    );
    assert.throws(() => normalizeCommand({ kind: 'shell' }), /command kind/);
    assert.throws(() => normalizeCommand({ kind: 'substitute-text', source: 'a', replacements: [] }), /empty/);
    assert.throws(() => normalizeCommand({ kind: 'filter-lines', source: 'a', pattern: '(' }), /regular expression/);
    assert.throws(() => normalizeCommand({ kind: 'template-hash', fields: ['b', 'b'] }), /unique/);
  });
});

describe('normalization', () => {
  test('paths fold and escapes are refused; inputs sort; env is an allow-list', () => {
    assert.equal(normalizePath('a//b/./c.txt'), 'a/b/c.txt');
    assert.equal(normalizePath('a\\b.txt'), 'a/b.txt');
    for (const bad of ['', '.', '..', '../x', '/abs', 'C:/x', 'a/../../x']) {
      assert.throws(() => normalizePath(bad), ValidationError, `expected ${bad} to be refused`);
    }
    assert.deepEqual(normalizeInputs([fileIn('b.txt'), hashIn('a.txt', hex('2'))]), [
      { kind: 'hash', path: 'a.txt', digest: hex('2') },
      { kind: 'file', path: 'b.txt' },
    ]);
    assert.deepEqual(normalizeCacheInputs([fileWith('a.txt', ZEROS), hashIn('b.txt', hex('2'))]), [
      { kind: 'file', path: 'a.txt', digest: ZEROS },
      { kind: 'hash', path: 'b.txt', digest: hex('2') },
    ]);
    assert.throws(() => normalizeCacheInputs([fileWith('a.txt', ZEROS), fileWith('a.txt', ZEROS)]), /listed twice/);
    assert.deepEqual(normalizeEnv(['B', 'A'], { A: '1', B: '2', C: '3' }), { names: ['A', 'B'], values: { A: '1', B: '2' } });
    assert.throws(() => normalizeEnv(['NOPE'], {}), /not set/);
    assert.throws(() => normalizeEnv(['A', 'A'], { A: '1' }), /unique/);
  });
});

describe('object store', () => {
  test('identical bytes land on one path and are never rewritten', async () => {
    const store = new ObjectStore(path.join(root, 'objects'));
    const digest = await store.writeBlob(Buffer.from('same'));
    assert.equal(await store.writeBlob(Buffer.from('same')), digest);
    assert.equal(digestOf(Buffer.from('same')), `sha256:${digest}`);
  });

  test('mismatched, missing and corrupted entries are all refused', async () => {
    const store = new ObjectStore(path.join(root, 'objects'));
    const key = hex('a');
    await store.writeManifest(key, { key: hex('b'), digest: ZEROS, size: 1 });
    await assert.rejects(store.readManifest(key), /claims a different key/);
    await store.writeManifest(key, { key, digest: `sha256:${hex('c')}`, size: 1 });
    await assert.rejects(store.readArtifact(key), (error) => error.code === 'not_found');
    const digest = await store.writeBlob(Buffer.from('payload'));
    await writeFile(store.blobPath(digest), 'tampered');
    await store.writeManifest(key, { key, digest: `sha256:${digest}`, size: 7 });
    await assert.rejects(store.readArtifact(key), /does not match its manifest digest/);
    assert.throws(() => store.manifestPath('not-a-key'), /64 lowercase hex/);
  });
});

describe('action keys', () => {
  test('declaration order never reaches the key', async () => {
    const command = { kind: 'concat-text', sources: ['src/head.txt', 'src/tail.txt'], separator: '|' };
    const first = await service.putAction({
      name: 'gather',
      command,
      inputs: [fileIn('src/tail.txt'), fileIn('src/head.txt')],
      env: ['CC', 'LANG'],
    });
    const second = await service.putAction({
      name: 'gather-two',
      command,
      inputs: [fileIn('src/head.txt'), fileIn('src/tail.txt')],
      env: ['LANG', 'CC'],
    });
    assert.equal(first.key, second.key);
    assert.notEqual(first.action_id, second.action_id, 'names still identify separate actions');
  });

  test('paths are normalized before hashing, file bytes are hashed after', async () => {
    const plain = await registerFilter('plain');
    const dotted = await service.putAction({
      name: 'dotted',
      command: filterCmd({ source: './src/app.txt' }),
      inputs: [fileIn('src/./app.txt')],
      env: ['LANG'],
    });
    assert.equal(plain.key, dotted.key);
    assert.deepEqual(dotted.inputs, [fileWith('src/app.txt', plain.inputs[0].digest)]);

    await writeFile(path.join(workspace, 'src', 'app.txt'), 'alpha\ndelta\n');
    const refreshed = await service.putAction(
      { name: 'plain', command: filterCmd(), inputs: [fileIn('src/app.txt')], env: ['LANG'] },
      { refresh: true },
    );
    assert.notEqual(refreshed.key, plain.key, 'the snapshot is retaken and the bytes changed');
    assert.notEqual(refreshed.inputs[0].digest, plain.inputs[0].digest);
  });

  test('command content, environment names and unset variables', async () => {
    const kept = await registerFilter('keeper');
    assert.notEqual(kept.key, (await registerFilter('dropper', { match: 'drop' })).key);
    assert.notEqual(kept.key, (await registerFilter('other-pattern', { pattern: 'beta' })).key);
    const noEnv = await service.putAction({ name: 'no-env', command: filterCmd(), inputs: [fileIn('src/app.txt')], env: [] });
    assert.notEqual(kept.key, noEnv.key);
    await assert.rejects(
      service.putAction({ name: 'needs-env', command: filterCmd(), inputs: [fileIn('src/app.txt')], env: ['MISSING'] }),
      /MISSING/,
    );
  });
});

describe('validation', () => {
  test('unknown fields, escaped paths and undeclared reads are refused', async () => {
    const put = (body) => service.putAction(body);
    await assert.rejects(
      put({ name: 'x', command: { kind: 'write-file', content: 'x' }, inputs: [fileIn('src/app.txt')], env: [], cache: true }),
      /unknown field: cache/,
    );
    for (const candidate of ['../secrets', '/etc/passwd', 'C:/windows/system32']) {
      await assert.rejects(
        put({ name: 'escape', command: { kind: 'copy-file', source: candidate }, inputs: [fileIn(candidate)], env: [] }),
        /inside the workspace|relative to the workspace/,
      );
    }
    await assert.rejects(
      put({ name: 'undeclared', command: { kind: 'copy-file', source: 'src/tail.txt' }, inputs: [fileIn('src/app.txt')], env: [] }),
      /not a declared input/,
    );
    await assert.rejects(
      put({ name: 'gone', command: { kind: 'copy-file', source: 'src/absent.txt' }, inputs: [fileIn('src/absent.txt')], env: [] }),
      /does not exist/,
    );
  });

  test('input kinds and hash digests are flatly enforced', async () => {
    const put = (name, inputs) => service.putAction({ name, command: { kind: 'write-file', content: 'x' }, inputs, env: [] });
    await assert.rejects(put('smuggle', [fileWith('src/app.txt', ZEROS)]), /must not carry a digest/);
    await assert.rejects(put('bare', [{ kind: 'hash', path: 'a.tar' }]), /must carry a digest/);
    // A hash input references an action key: plain hex, no sha256: prefix.
    await assert.rejects(put('prefixed', [hashIn('a.tar', ZEROS)]), /64 lowercase hex/);
  });

  test('a name is claimed once and PUT replaces it', async () => {
    const first = await registerFilter('dup');
    await assert.rejects(registerFilter('dup'), (error) => error instanceof ConflictError);
    const replacement = { name: 'dup', command: filterCmd({ pattern: 'beta' }), inputs: [fileIn('src/app.txt')], env: ['LANG'] };
    await assert.rejects(service.putAction(replacement), /already registered/);
    const replaced = await service.putAction(replacement, { refresh: true });
    assert.notEqual(replaced.key, first.key);
    assert.equal((await service.getAction('dup')).key, replaced.key);
    await assert.rejects(service.getAction('nope'), (error) => error instanceof NotFoundError);
  });

  test('a graph must reference registered actions in dependency order', async () => {
    await registerFilter();
    await assert.rejects(service.putGraph('g', { nodes: [{ id: 'a', action: 'absent' }] }), /unregistered action/);
    await assert.rejects(service.putGraph('g', { nodes: [{ id: 'a', action: 'filter', needs: ['b'] }] }), /not defined earlier/);
    await assert.rejects(service.putGraph('g', { nodes: [{ id: 'a', action: 'filter', needs: ['a'] }] }), /needs itself/);
    await assert.rejects(service.putGraph('g', { nodes: [{ id: 'a', action: 'filter' }], concurrency: 0 }), /concurrency/);
    await assert.rejects(service.getGraph('missing'), (error) => error instanceof NotFoundError);
    await assert.rejects(service.runGraph('missing'), (error) => error instanceof NotFoundError);
  });

  test('a declared producer must be a real producer on a real edge', async () => {
    const producer = await registerFilter('producer');
    const consumer = (dependsOn) => ({
      name: 'honest',
      command: { kind: 'write-file', content: 'x' },
      // A declared producer must have its artifact declared as a hash input; the
      // "liar" below claims the dependency without consuming anything.
      inputs: dependsOn.length > 0 ? [hashIn('filtered.txt', producer.key)] : [fileIn('src/app.txt')],
      env: [],
      depends_on: dependsOn,
    });
    await assert.rejects(service.putAction(consumer(['producer']).valueOf() && { ...consumer(['producer']), inputs: [fileIn('src/app.txt')] }), /does not declare its artifact/);
    const honest = await service.putAction(consumer(['producer']));
    assert.equal(
      honest.key,
      actionKey({
        command: { kind: 'write-file', content: 'x' },
        inputs: [hashIn('filtered.txt', producer.key)],
        env: { names: [], values: {} },
      }),
      'depends_on is outside the action key; the graph edge is what binds them',
    );
    await service.putGraph('wired', {
      id: 'wired',
      nodes: [
        { id: 'a', action: 'producer' },
        { id: 'b', action: 'honest', needs: ['a'] },
      ],
    });
    const run = await service.runGraph('wired');
    const byId = Object.fromEntries(run.nodes.map((node) => [node.id, node]));
    assert.equal(byId.a.key, producer.key, 'a root node key is exactly its action key');
    assert.notEqual(byId.b.key, honest.key, 'a node key folds in the keys it depends on');
    assert.deepEqual(byId.b.dependencies.map((entry) => entry.action_id), ['producer']);

    await service.putGraph('orphan', { nodes: [{ id: 'a', action: 'honest' }] });
    await assert.rejects(service.runGraph('orphan'), /declares depends_on/);
  });
});

describe('cache hits and misses', () => {
  test('the first run misses, the second hits, and both artifacts are byte identical', async () => {
    await registerFilter();
    const first = await runOne();
    assert.deepEqual(
      { hits: first.cache_hits, misses: first.cache_misses, cache: first.nodes[0].cache, reused: first.plan_reused },
      { hits: 0, misses: 1, cache: 'miss', reused: false },
    );
    const second = await service.runGraph('build');
    assert.deepEqual(
      { hits: second.cache_hits, misses: second.cache_misses, cache: second.nodes[0].cache, reused: second.plan_reused },
      { hits: 1, misses: 0, cache: 'hit', reused: true },
    );
    assert.equal(second.run_key, first.run_key);
    assert.equal(second.nodes[0].digest, first.nodes[0].digest);

    const missed = await service.cacheGet(first.nodes[0].key);
    const hit = await service.cacheGet(second.nodes[0].key);
    assert.ok(missed.buffer.equals(hit.buffer), 'miss bytes and hit bytes must be identical');
    assert.equal(missed.buffer.toString(), 'alpha\nbeta\ngamma\n');
    assert.deepEqual(missed.manifest, hit.manifest, 'manifests must be byte identical too');

    const recomputed = await service.runGraph('build', { useCache: false });
    assert.deepEqual({ cache: recomputed.nodes[0].cache, digest: recomputed.nodes[0].digest }, { cache: 'miss', digest: first.nodes[0].digest });
  });

  test('verify re-executes the frozen graph read-only and repeats identically', async () => {
    await registerFilter();
    const run = await runOne();
    const statsBefore = await service.stats();
    const clean = await service.verifyGraph('build', {});
    assert.deepEqual(clean, {
      schema: 'cachelattice/verify/v1',
      graph_id: 'build',
      reference_run_key: run.run_key,
      verified: [{ node_id: 'a', key: run.nodes[0].key, digest: run.nodes[0].digest, size: run.nodes[0].size }],
    });
    assert.deepEqual(await service.verifyGraph('build', {}), clean, 'an unchanged store verifies identically');
    assert.deepEqual(await service.stats(), statsBefore, 'verification moves no counter');
    assert.equal((await service.getGraph('build')).last_run.run_key, run.run_key, 'last_run is untouched');
  });

  test('verify lists nodes with identical content separately, sorted by node id', async () => {
    await registerFilter('one');
    await registerFilter('two');
    await service.putGraph('dup', {
      id: 'dup',
      nodes: [
        { id: 'b', action: 'one' },
        { id: 'a', action: 'two' },
      ],
    });
    const run = await service.runGraph('dup');
    assert.equal(run.nodes[0].key, run.nodes[1].key, 'same definition, same node key');
    const report = await service.verifyGraph('dup', {});
    assert.deepEqual(
      report.verified.map((node) => node.node_id),
      ['a', 'b'],
    );
    assert.equal(report.verified[0].key, report.verified[1].key);
    assert.equal(report.verified[0].digest, report.verified[1].digest);
  });

  test('verify reports a changed workspace as a 422 with per-node details', async () => {
    await registerFilter();
    const run = await runOne();
    await writeFile(path.join(workspace, 'src', 'app.txt'), 'alpha\ndelta\n');
    await assert.rejects(service.verifyGraph('build', {}), (error) => {
      assert.equal(error.code, 'reproducibility_mismatch');
      assert.equal(error.status, 422);
      assert.equal(error.details.mismatches.length, 1);
      const mismatch = error.details.mismatches[0];
      assert.equal(mismatch.node_id, 'a');
      assert.equal(mismatch.expected_digest, run.nodes[0].digest);
      assert.equal(mismatch.expected_size, run.nodes[0].size);
      assert.match(mismatch.actual_digest, /^sha256:[0-9a-f]{64}$/);
      assert.notEqual(mismatch.actual_digest, run.nodes[0].digest);
      assert.equal(mismatch.actual_size, Buffer.byteLength('alpha\ndelta\n'));
      return true;
    });
    assert.equal((await service.stats()).artifacts_executed, 1, 'a mismatch still writes nothing');
  });

  test('verify refuses unknown graphs, unrun graphs and unreadable cache entries', async () => {
    await registerFilter();
    await service.putGraph('build', { id: 'build', nodes: [{ id: 'a', action: 'filter' }] });
    await assert.rejects(
      service.verifyGraph('missing', {}),
      (error) => error.code === 'not_found' && error.status === 404,
    );
    await assert.rejects(
      service.verifyGraph('build', {}),
      (error) => error.code === 'verification_unavailable' && error.status === 409 && /no successful run/.test(error.message),
    );

    const run = await service.runGraph('build');
    await service.store.deleteManifest(run.nodes[0].key);
    await assert.rejects(
      service.verifyGraph('build', {}),
      (error) => error.code === 'verification_unavailable' && error.status === 409 && error.message.includes('node a'),
    );
  });

  test('verify reports a tampered blob as unavailable, not as a mismatch', async () => {
    await registerFilter();
    const run = await runOne();
    await writeFile(service.store.blobPath(run.nodes[0].digest.slice('sha256:'.length)), 'tampered');
    await assert.rejects(
      service.verifyGraph('build', {}),
      (error) => error.code === 'verification_unavailable' && error.status === 409 && error.message.includes('node a'),
    );
  });

  test('verify accepts only an empty object body', async () => {
    await registerFilter();
    await runOne();
    for (const body of [[], 'x', 1, null, { use_cache: true }, { surprise: 1 }]) {
      await assert.rejects(
        service.verifyGraph('build', body),
        (error) => error.code === 'validation_error' && error.status === 400,
        `expected ${JSON.stringify(body)} to be refused`,
      );
    }
  });

  test('different names sharing one definition share one cache entry', async () => {
    await registerFilter('first');
    await registerFilter('second');
    await service.putGraph('g', {
      id: 'g',
      nodes: [
        { id: 'a', action: 'first' },
        { id: 'b', action: 'second' },
      ],
    });
    const run = await service.runGraph('g');
    assert.equal(run.nodes[0].key, run.nodes[1].key);
    assert.deepEqual(Object.fromEntries(run.nodes.map((node) => [node.id, node.cache])), { a: 'miss', b: 'hit' });
    assert.equal((await service.stats()).cache_entries, 1);
  });

  test('a diamond respects the concurrency limit without changing any digest', async () => {
    const source = await service.putAction({
      name: 'source',
      command: { kind: 'copy-file', source: 'src/app.txt' },
      inputs: [fileIn('src/app.txt')],
      env: [],
    });
    const leaf = (name, content) =>
      service.putAction({
        name,
        command: { kind: 'write-file', content },
        inputs: [hashIn('in.txt', source.key)],
        env: [],
        depends_on: ['source'],
      });
    const left = await leaf('left', 'left');
    const right = await leaf('right', 'right');
    await service.putAction({
      name: 'join',
      command: { kind: 'write-file', content: 'joined' },
      inputs: [hashIn('left.txt', left.key), hashIn('right.txt', right.key)],
      env: [],
      depends_on: ['left', 'right'],
    });
    const nodes = [
      { id: 'a', action: 'source' },
      { id: 'b', action: 'left', needs: ['a'] },
      { id: 'c', action: 'right', needs: ['a'] },
      { id: 'd', action: 'join', needs: ['b', 'c'] },
    ];
    await service.putGraph('narrow', { id: 'narrow', concurrency: 2, nodes });
    const serial = await service.runGraph('narrow');
    await service.putGraph('wide', { id: 'wide', concurrency: 3, nodes });
    const wide = await service.runGraph('wide');
    assert.equal(serial.cache_misses, 4);
    assert.ok(serial.peak_parallel <= 2);
    assert.equal(wide.cache_hits, 4, 'the same keys must hit after the first graph ran');
    assert.deepEqual(
      wide.nodes.map((node) => [node.id, node.digest]),
      serial.nodes.map((node) => [node.id, node.digest]),
      'concurrency must not change any artifact digest',
    );
  });

  test('an upstream change moves every downstream key', async () => {
    const source = await service.putAction({
      name: 'source',
      command: { kind: 'copy-file', source: 'src/app.txt' },
      inputs: [fileIn('src/app.txt')],
      env: [],
    });
    const wrap = (digest) => ({
      name: 'wrap',
      command: { kind: 'write-file', content: 'wrapped' },
      inputs: [hashIn('in.txt', digest)],
      env: [],
      depends_on: ['source'],
    });
    await service.putAction(wrap(source.key));
    await service.putGraph('chain', {
      id: 'chain',
      nodes: [
        { id: 'a', action: 'source' },
        { id: 'b', action: 'wrap', needs: ['a'] },
      ],
    });
    const first = await service.runGraph('chain');

    await writeFile(path.join(workspace, 'src', 'app.txt'), 'alpha\ndelta\n');
    const rebuilt = await service.putAction(
      { name: 'source', command: { kind: 'copy-file', source: 'src/app.txt' }, inputs: [fileIn('src/app.txt')], env: [] },
      { refresh: true },
    );
    // The consumer must follow the producer it consumes: exactly the authoring
    // burden the dependency check enforces.
    await service.putAction(wrap(rebuilt.key), { refresh: true });
    const second = await service.runGraph('chain');
    assert.deepEqual(second.stale_nodes.map((node) => node.id), ['a', 'b']);
    assert.notDeepEqual(keysOf(second), keysOf(first));
    assert.equal(second.cache_misses, 2, 'the consumer is conservatively rebuilt');
  });
});

describe('remote cache entries', () => {
  test('an entry is accepted only when its fields recompute to the claimed key', async () => {
    const content = await readFile(path.join(workspace, 'src', 'app.txt'));
    const action = await service.putAction({
      name: 'seed',
      command: { kind: 'copy-file', source: 'src/app.txt' },
      inputs: [fileIn('src/app.txt')],
      env: [],
    });
    const entry = {
      action_id: 'peer',
      command: { kind: 'copy-file', source: 'src/app.txt' },
      inputs: [fileWith('src/app.txt', action.inputs[0].digest)],
      env: [],
    };
    const manifest = await service.cachePut(action.key, entry, content);
    assert.deepEqual(
      { key: manifest.key, digest: manifest.digest, env: manifest.env, dependencies: manifest.dependencies },
      { key: action.key, digest: digestOf(content), env: { names: [], values: {} }, dependencies: [] },
    );
    assert.ok((await service.remoteRead(action.key)).buffer.equals(content));
    await assert.rejects(service.cachePut(action.key, entry, content), /already exists/);
    await assert.rejects(service.cachePut(hex('f'), entry, content), /same fields hash to/);
    await assert.rejects(service.cachePut(action.key, { ...entry, surprise: 1 }, content), /unknown field: surprise/);
    await assert.rejects(service.cachePut('nope', entry, content), /64 lowercase hex/);
  });

  test('a peer entry serves a root node without re-executing it', async () => {
    const content = Buffer.from('from peer\n');
    const seed = hashIn('seed.bin', hex('e'));
    const action = await service.putAction({
      name: 'peer-copy',
      command: { kind: 'write-file', content: 'from peer\n' },
      inputs: [seed],
      env: [],
    });
    await service.cachePut(
      action.key,
      { action_id: 'peer', command: { kind: 'write-file', content: 'from peer\n' }, inputs: [seed], env: [] },
      content,
    );
    const run = await runOne('peer-copy', 'peer');
    assert.deepEqual({ hits: run.cache_hits, misses: run.cache_misses }, { hits: 1, misses: 0 });
    assert.ok((await service.cacheGet(run.nodes[0].key)).buffer.equals(content));
  });
});

describe('cache garbage collection', () => {
  // A remote entry is a cache entry no graph's last run points at, which makes
  // it the natural victim for the default keep set.
  const seedRemote = async (name, content) => {
    const action = await service.putAction({
      name,
      command: { kind: 'write-file', content },
      inputs: [fileIn('src/app.txt')],
      env: [],
    });
    await service.cachePut(
      action.key,
      {
        action_id: 'peer',
        command: { kind: 'write-file', content },
        inputs: [fileWith('src/app.txt', action.inputs[0].digest)],
        env: [],
      },
      Buffer.from(content),
    );
    return { key: action.key, digest: digestOf(Buffer.from(content)), size: Buffer.byteLength(content) };
  };

  test('last-run keys are kept; remote entries and orphan blobs are collected', async () => {
    await registerFilter();
    const run = await runOne();
    const kept = run.nodes[0];
    const remote = await seedRemote('remote-one', 'from a peer\n');
    const orphanContent = Buffer.from('orphan bytes');
    const orphan = await service.store.writeBlob(orphanContent);

    const report = await service.gc({});
    assert.deepEqual(report, {
      dry_run: false,
      kept_keys: [kept.key],
      removed_keys: [remote.key],
      removed_digests: [orphan, remote.digest.slice('sha256:'.length)].sort().map((digest) => `sha256:${digest}`),
      kept_bytes: kept.size,
      removed_bytes: remote.size + orphanContent.length,
    });
    assert.ok(service.store.hasManifest(kept.key));
    assert.ok(!service.store.hasManifest(remote.key));
    assert.ok(!service.store.hasBlob(orphan));
    assert.ok(!service.store.hasBlob(remote.digest.slice('sha256:'.length)));
    assert.equal((await service.cacheGet(kept.key)).buffer.toString(), 'alpha\nbeta\ngamma\n');
    assert.equal((await service.stats()).cache_entries, 1);
  });

  test('a dry run reports the same sets and deletes nothing', async () => {
    await registerFilter();
    const run = await runOne();
    const remote = await seedRemote('remote-dry', 'dry peer\n');
    const dry = await service.gc({ dry_run: true });
    assert.equal(dry.dry_run, true);
    assert.deepEqual(dry.kept_keys, [run.nodes[0].key]);
    assert.deepEqual(dry.removed_keys, [remote.key]);
    assert.equal(dry.kept_bytes, run.nodes[0].size);
    assert.equal(dry.removed_bytes, remote.size);
    assert.ok(service.store.hasManifest(remote.key));
    assert.ok(service.store.hasBlob(remote.digest.slice('sha256:'.length)));

    const collected = await service.gc();
    assert.deepEqual(collected.removed_keys, [remote.key]);
    assert.ok(!service.store.hasManifest(remote.key));
  });

  test('a blob shared with a kept entry survives its collected twin manifest', async () => {
    const content = 'shared bytes\n';
    const kept = await service.putAction({
      name: 'kept',
      command: { kind: 'write-file', content },
      inputs: [fileIn('src/app.txt')],
      env: [],
    });
    // Same command and same artifact bytes, but a different input list, so a
    // different key whose manifest names the very same blob.
    const twin = await service.putAction({
      name: 'twin',
      command: { kind: 'write-file', content },
      inputs: [fileIn('src/app.txt'), hashIn('seed.bin', hex('e'))],
      env: [],
    });
    assert.notEqual(kept.key, twin.key);
    await service.putGraph('g', { id: 'g', nodes: [{ id: 'a', action: 'kept' }] });
    await service.runGraph('g');
    const fileDigest = twin.inputs.find((input) => input.kind === 'file').digest;
    await service.cachePut(
      twin.key,
      {
        action_id: 'peer',
        command: { kind: 'write-file', content },
        inputs: [fileWith('src/app.txt', fileDigest), hashIn('seed.bin', hex('e'))],
        env: [],
      },
      Buffer.from(content),
    );

    const report = await service.gc({});
    assert.deepEqual(report.kept_keys, [kept.key]);
    assert.deepEqual(report.removed_keys, [twin.key]);
    assert.deepEqual(report.removed_digests, []);
    assert.equal(report.kept_bytes, Buffer.byteLength(content));
    assert.equal(report.removed_bytes, 0);
    assert.ok(service.store.hasBlob(digestOf(Buffer.from(content)).slice('sha256:'.length)));
  });

  test('explicit keep keys are deduplicated and order-free; a missing one is a 404', async () => {
    await registerFilter();
    const run = await runOne();
    const remote = await seedRemote('remote-keep', 'keep me\n');
    const report = await service.gc({ keep: [remote.key, remote.key] });
    assert.deepEqual(report.kept_keys, [run.nodes[0].key, remote.key].sort());
    assert.deepEqual(report.removed_keys, []);
    assert.ok(service.store.hasManifest(remote.key));

    await assert.rejects(service.gc({ keep: [hex('a')] }), (error) => error.code === 'not_found');
    assert.ok(service.store.hasManifest(remote.key), 'a failed request deletes nothing');
  });

  test('a graph that never ran contributes no keep keys', async () => {
    const remote = await seedRemote('remote-norun', 'no run\n');
    await service.putGraph('never-ran', { id: 'never-ran', nodes: [{ id: 'a', action: 'remote-norun' }] });
    const report = await service.gc({});
    assert.deepEqual(report.kept_keys, []);
    assert.deepEqual(report.removed_keys, [remote.key]);
  });

  test('bad requests are refused before anything is scanned or deleted', async () => {
    await registerFilter();
    await runOne();
    const remote = await seedRemote('remote-val', 'validate me\n');
    for (const body of [
      { keep: 'not-an-array' },
      { keep: ['nope'] },
      { keep: [hex('A')] },
      { dry_run: 'yes' },
      { keep: [], surprise: 1 },
    ]) {
      await assert.rejects(service.gc(body), (error) => error.code === 'validation_error');
    }
    await assert.rejects(service.gc(['not', 'an', 'object']), (error) => error.code === 'validation_error');
    assert.ok(service.store.hasManifest(remote.key));
  });

  test('a corrupt store fails the scan and nothing is deleted', async () => {
    await registerFilter();
    await runOne();
    const remote = await seedRemote('remote-corrupt', 'corrupt me\n');
    const badKey = hex('b');
    const badPath = service.store.manifestPath(badKey);
    const assertScanFails = async (pattern) => {
      await assert.rejects(
        service.gc({}),
        (error) => error.code === 'validation_error' && pattern.test(error.message),
      );
      assert.ok(service.store.hasManifest(remote.key), 'a failed scan deletes nothing');
    };

    await mkdir(path.dirname(badPath), { recursive: true });
    await writeFile(badPath, 'this is not json');
    await assertScanFails(/not valid JSON/);

    await service.store.writeManifest(badKey, { key: hex('c'), digest: ZEROS, size: 1 });
    await assertScanFails(/claims a different key/);

    await service.store.writeManifest(badKey, { key: badKey, size: 1 });
    await assertScanFails(/digest/);

    await service.store.writeManifest(badKey, { key: badKey, digest: 'sha256:not-hex', size: 1 });
    await assertScanFails(/digest/);

    await service.store.writeManifest(badKey, { key: badKey, digest: `sha256:${hex('d')}`, size: 1 });
    await assertScanFails(/missing from the object store/);

    const digest = await service.store.writeBlob(Buffer.from('real bytes'));
    await writeFile(service.store.blobPath(digest), 'tampered');
    await service.store.writeManifest(badKey, { key: badKey, digest: `sha256:${digest}`, size: 10 });
    await assertScanFails(/does not match its digest/);

    await service.store.deleteManifest(badKey);
    await service.store.deleteBlob(digest);
    const clean = await service.gc({});
    assert.deepEqual(clean.removed_keys, [remote.key]);
  });

  test('the CLI prints the same report and honours --keep and --dry-run', async () => {
    await registerFilter();
    const run = await runOne();
    const remote = await seedRemote('remote-cli', 'cli peer\n');
    const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
    const data = path.join(root, 'data');
    const exec = promisify(execFile);

    const dry = JSON.parse(
      (await exec(process.execPath, [cli, 'gc', '--data', data, '--keep', remote.key, '--dry-run'])).stdout,
    );
    assert.equal(dry.dry_run, true);
    assert.deepEqual(dry.kept_keys, [run.nodes[0].key, remote.key].sort());
    assert.deepEqual(dry.removed_keys, []);
    assert.ok(service.store.hasManifest(remote.key), 'a dry run deletes nothing');

    const done = JSON.parse((await exec(process.execPath, [cli, 'gc', '--data', data])).stdout);
    assert.equal(done.dry_run, false);
    assert.deepEqual(done.removed_keys, [remote.key]);
    assert.ok(!service.store.hasManifest(remote.key));

    await assert.rejects(exec(process.execPath, [cli, 'gc', '--data', data, '--keep', 'nope']), (error) => {
      assert.equal(error.code, 1);
      assert.equal(JSON.parse(error.stderr).error.code, 'validation_error');
      return true;
    });
  });
});

describe('resource limits', () => {
  const writer = (name, content = name) =>
    service.putAction({ name, command: { kind: 'write-file', content }, inputs: [fileIn('src/app.txt')], env: [] });

  test('limits and resources are validated and a rejected PUT keeps the old graph', async () => {
    await writer('w');
    await service.putGraph('g', { id: 'g', limits: { cpu: 2 }, nodes: [{ id: 'a', action: 'w' }] });
    const base = { id: 'g', limits: { cpu: 2 }, nodes: [{ id: 'a', action: 'w' }] };
    const bad = [
      { limits: [] },
      { limits: 3 },
      { limits: { cpu: 0 } },
      { limits: { cpu: -1 } },
      { limits: { cpu: 1.5 } },
      { limits: { cpu: 1000001 } },
      { limits: { '': 1 } },
      { limits: { '1cpu': 1 } },
      { limits: { '-cpu': 1 } },
      { limits: { 'cpu!': 1 } },
      { limits: { [`a${'b'.repeat(32)}`]: 1 } },
      { nodes: [{ id: 'a', action: 'w', resources: [] }] },
      { nodes: [{ id: 'a', action: 'w', resources: { cpu: -1 } }] },
      { nodes: [{ id: 'a', action: 'w', resources: { cpu: 1.5 } }] },
      { nodes: [{ id: 'a', action: 'w', resources: { cpu: 1000001 } }] },
      { nodes: [{ id: 'a', action: 'w', resources: { gpu: 1 } }] },
      { nodes: [{ id: 'a', action: 'w', resources: { cpu: 3 } }] },
    ];
    for (const patch of bad) {
      await assert.rejects(
        service.putGraph('g', { ...base, ...patch }),
        (error) => error.code === 'validation_error',
        `expected ${JSON.stringify(patch)} to be refused`,
      );
    }
    const graph = await service.getGraph('g');
    assert.deepEqual(graph.limits, { cpu: 2 }, 'a failed write leaves the graph untouched');
    assert.deepEqual(graph.nodes[0].resources, {});
  });

  test('boundary names and amounts are accepted', async () => {
    await writer('bw');
    const name32 = `a${'b'.repeat(31)}`;
    const graph = await service.putGraph('bounds', {
      id: 'bounds',
      limits: { [name32]: 1000000, Z: 1, 'a-b_c': 5 },
      nodes: [{ id: 'a', action: 'bw', resources: { [name32]: 0, Z: 1 } }],
    });
    assert.equal(graph.limits['a-b_c'], 5);
    assert.deepEqual(graph.nodes[0].resources, { [name32]: 0, Z: 1 });
  });

  test('a graph without declarations reports empty objects everywhere', async () => {
    await writer('nw');
    await service.putGraph('nolimit', { id: 'nolimit', nodes: [{ id: 'a', action: 'nw' }] });
    const run = await service.runGraph('nolimit');
    assert.deepEqual(run.resource_limits, {});
    assert.deepEqual(run.peak_resources, {});
    assert.deepEqual(run.nodes[0].resources, {});
    const graph = await service.getGraph('nolimit');
    assert.deepEqual(graph.limits, {});
    assert.deepEqual(graph.nodes[0].resources, {});
  });

  test('GET returns limits and node resources; last_run keeps its shape', async () => {
    await writer('gw');
    await service.putGraph('getg', {
      id: 'getg',
      limits: { cpu: 2 },
      nodes: [{ id: 'a', action: 'gw', resources: { cpu: 1 } }],
    });
    await service.runGraph('getg');
    const graph = await service.getGraph('getg');
    assert.deepEqual(graph.limits, { cpu: 2 });
    assert.deepEqual(graph.nodes, [{ id: 'a', action: 'gw', needs: [], resources: { cpu: 1 } }]);
    assert.deepEqual(
      Object.keys(graph.last_run).sort(),
      ['cache_hits', 'cache_misses', 'completed_at', 'duration_ms', 'nodes', 'peak_parallel', 'run_key'],
    );
    assert.deepEqual(Object.keys(graph.last_run.nodes[0]).sort(), ['action', 'cache', 'digest', 'id', 'key']);
  });

  test('resource declarations never reach keys, manifests or artifacts', async () => {
    await writer('plain-act', 'same');
    await service.putGraph('plain', { id: 'plain', concurrency: 2, nodes: [{ id: 'a', action: 'plain-act' }] });
    await service.putGraph('decorated', {
      id: 'decorated',
      concurrency: 2,
      limits: { cpu: 2 },
      nodes: [{ id: 'a', action: 'plain-act', resources: { cpu: 1 } }],
    });
    const plain = await service.runGraph('plain');
    const decorated = await service.runGraph('decorated');
    assert.equal(decorated.run_key, plain.run_key);
    assert.equal(decorated.nodes[0].key, plain.nodes[0].key);
    assert.equal(decorated.cache_hits, 1, 'the resource declaration must not move the cache key');
    const { manifest } = await service.cacheGet(plain.nodes[0].key);
    assert.ok(!('resources' in manifest) && !('limits' in manifest));
  });

  test('quotas gate dispatch, a candidate that does not fit is skipped, and peaks are reported', async () => {
    for (const name of ['ra', 'rb', 'rc']) await writer(name);
    await service.putGraph('quota', {
      id: 'quota',
      concurrency: 3,
      limits: { cpu: 1, mem: 4 },
      nodes: [
        { id: 'a', action: 'ra', resources: { cpu: 1 } },
        { id: 'b', action: 'rb', resources: { cpu: 1 } },
        { id: 'c', action: 'rc' },
      ],
    });
    const run = await service.runGraph('quota');
    assert.equal(run.cache_misses, 3);
    assert.deepEqual(run.resource_limits, { cpu: 1, mem: 4 });
    assert.deepEqual(run.peak_resources, { cpu: 1, mem: 0 }, 'declared but unused resources peak at 0');
    assert.equal(run.peak_parallel, 2, 'b waits for a quota slot while c runs beside a');
    const byId = Object.fromEntries(run.nodes.map((node) => [node.id, node]));
    assert.deepEqual(byId.a.resources, { cpu: 1 });
    assert.deepEqual(byId.c.resources, {});

    const again = await service.runGraph('quota');
    assert.equal(again.cache_hits, 3);
    assert.deepEqual(again.peak_resources, run.peak_resources, 'hits reserve and release exactly like misses');
  });

  test('two nodes may share one quota up to its limit', async () => {
    for (const name of ['sa', 'sb']) await writer(name);
    await service.putGraph('shared', {
      id: 'shared',
      concurrency: 2,
      limits: { cpu: 2 },
      nodes: [
        { id: 'a', action: 'sa', resources: { cpu: 1 } },
        { id: 'b', action: 'sb', resources: { cpu: 1 } },
      ],
    });
    const run = await service.runGraph('shared');
    assert.equal(run.peak_parallel, 2);
    assert.deepEqual(run.peak_resources, { cpu: 2 });
  });

  test('a failed node releases its reservation and its dependents never start', async () => {
    const reader = await service.putAction({
      name: 'reader',
      command: { kind: 'copy-file', source: 'src/app.txt' },
      inputs: [fileIn('src/app.txt')],
      env: [],
    });
    await service.putAction({
      name: 'downstream',
      command: { kind: 'write-file', content: 'downstream' },
      inputs: [hashIn('in.txt', reader.key)],
      env: [],
      depends_on: ['reader'],
    });
    await service.putGraph('fails', {
      id: 'fails',
      concurrency: 2,
      limits: { cpu: 1 },
      nodes: [
        { id: 'a', action: 'reader', resources: { cpu: 1 } },
        { id: 'b', action: 'downstream', needs: ['a'] },
      ],
    });
    await rm(path.join(workspace, 'src', 'app.txt'));
    await assert.rejects(service.runGraph('fails'), (error) => error.code === 'action_failed');
    assert.equal((await service.stats()).artifacts_executed, 0, 'the dependent node never started');
  });

  test('the CLI run prints the same resource fields without new flags', async () => {
    await writer('cli-act');
    await service.putGraph('cli-graph', {
      id: 'cli-graph',
      limits: { cpu: 1 },
      nodes: [{ id: 'a', action: 'cli-act', resources: { cpu: 1 } }],
    });
    const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
    const exec = promisify(execFile);
    const out = JSON.parse(
      (await exec(process.execPath, [cli, 'run', '--graph', 'cli-graph', '--data', path.join(root, 'data'), '--workspace', workspace])).stdout,
    );
    assert.deepEqual(out.resource_limits, { cpu: 1 });
    assert.deepEqual(out.peak_resources, { cpu: 1 });
    assert.deepEqual(out.nodes[0].resources, { cpu: 1 });
  });
});

describe('HTTP contract', () => {
  let base;
  let httpRoot;
  let server;

  before(async () => {
    httpRoot = await mkdtemp(path.join(tmpdir(), 'cachelattice-http-'));
    const httpWorkspace = path.join(httpRoot, 'workspace');
    await mkdir(path.join(httpWorkspace, 'src'), { recursive: true });
    await writeFile(path.join(httpWorkspace, 'src', 'app.txt'), 'alpha\nbeta\ngamma\n');
    const httpService = new Cachelattice({
      dataDirectory: path.join(httpRoot, 'data'),
      workspace: httpWorkspace,
      ambientEnv: { LANG: 'en_US.UTF-8' },
    });
    await httpService.loading;
    server = createServer(httpService);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await rm(httpRoot, { recursive: true, force: true });
  });

  const call = async (method, route, body, headers = {}) => {
    const init = { method, headers: { ...headers } };
    if (body !== undefined && body !== null) {
      init.body = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
    }
    const response = await fetch(`${base}${route}`, init);
    const text = await response.text();
    const isJson = (response.headers.get('content-type') ?? '').includes('json');
    return { status: response.status, headers: response.headers, text, json: isJson ? JSON.parse(text) : null };
  };

  const actionBody = { name: 'filter', command: filterCmd(), inputs: [fileIn('src/app.txt')], env: ['LANG'] };

  test('health, unknown routes and the error envelope', async () => {
    assert.deepEqual((await call('GET', '/health')).json, { status: 'ok', service: 'cachelattice' });
    const route = await call('GET', '/nope');
    assert.deepEqual({ status: route.status, code: route.json.error.code }, { status: 404, code: 'not_found' });
    const resource = await call('GET', '/actions/absent');
    assert.deepEqual({ status: resource.status, keys: Object.keys(resource.json.error) }, { status: 404, keys: ['code', 'message'] });
    assert.equal((await call('POST', '/actions', 'not json')).json.error.code, 'validation_error');
    const extra = await call('POST', '/actions', { ...actionBody, surcharge: 1 });
    assert.deepEqual({ status: extra.status, error: extra.json.error.code }, { status: 400, error: 'validation_error' });
    assert.match(extra.json.error.message, /unknown field: surcharge/);
    assert.match((await call('POST', '/graphs/build/run', { use_cache: 'yes' })).json.error.message, /use_cache/);
    assert.equal((await call('GET', '/cache/not-a-key')).status, 400);
  });

  test('a full run reports a miss, then a hit with byte identical artifacts', async () => {
    const action = await call('POST', '/actions', actionBody, { 'idempotency-key': 'action-1' });
    assert.deepEqual({ status: action.status, isKey: /^[0-9a-f]{64}$/.test(action.json.key) }, { status: 201, isKey: true });
    assert.equal((await call('POST', '/graphs', { id: 'build', concurrency: 1, nodes: [{ id: 'compile', action: 'filter' }] })).status, 201);

    const miss = await call('POST', '/graphs/build/run', {});
    assert.deepEqual({ hits: miss.json.cache_hits, misses: miss.json.cache_misses }, { hits: 0, misses: 1 });
    const hit = await call('POST', '/graphs/build/run', {}, { 'idempotency-key': 'run-1' });
    assert.deepEqual(
      { hits: hit.json.cache_hits, misses: hit.json.cache_misses, cache: hit.json.nodes[0].cache },
      { hits: 1, misses: 0, cache: 'hit' },
    );
    assert.equal(hit.json.nodes[0].digest, miss.json.nodes[0].digest);
    assert.deepEqual((await call('POST', '/graphs/build/run', {}, { 'idempotency-key': 'run-1' })).json, hit.json, 'the key replays the answer');

    const key = miss.json.nodes[0].key;
    const first = await fetch(`${base}/cache/${key}`);
    const missBytes = Buffer.from(await first.arrayBuffer());
    assert.deepEqual(
      { digest: first.headers.get('x-cache-digest'), key: first.headers.get('x-cache-key'), body: missBytes.toString() },
      { digest: miss.json.nodes[0].digest, key, body: 'alpha\nbeta\ngamma\n' },
    );
    const second = await fetch(`${base}/cache/${hit.json.nodes[0].key}`);
    assert.ok(Buffer.from(await second.arrayBuffer()).equals(missBytes), 'hit and miss artifacts must be byte identical');

    const meta = await call('GET', `/cache/${key}?meta=1`);
    assert.deepEqual({ digest: meta.json.digest, size: meta.json.size }, { digest: miss.json.nodes[0].digest, size: missBytes.length });
    const state = await call('GET', '/graphs/build');
    assert.deepEqual({ hits: state.json.last_run.cache_hits, nodes: state.json.last_run.nodes.length }, { hits: 1, nodes: 1 });
    assert.equal((await call('GET', '/stats')).json.schema, 'cachelattice/stats/v1');
    const statsBefore = (await call('GET', '/stats')).json;
    const verify = await call('POST', '/graphs/build/verify', {});
    assert.deepEqual(
      { status: verify.status, schema: verify.json.schema, graph: verify.json.graph_id, run: verify.json.reference_run_key },
      { status: 200, schema: 'cachelattice/verify/v1', graph: 'build', run: hit.json.run_key },
    );
    assert.deepEqual(
      verify.json.verified.map((node) => [node.node_id, node.key, node.digest, node.size]),
      [['compile', key, miss.json.nodes[0].digest, missBytes.length]],
    );
    assert.deepEqual((await call('POST', '/graphs/build/verify')).json, verify.json, 'an empty body verifies the same');
    assert.deepEqual((await call('GET', '/stats')).json, statsBefore, 'verification is read-only');
    const badVerify = await call('POST', '/graphs/build/verify', { use_cache: false });
    assert.deepEqual({ status: badVerify.status, code: badVerify.json.error.code }, { status: 400, code: 'validation_error' });
    const ghostVerify = await call('POST', '/graphs/ghost/verify', {});
    assert.deepEqual({ status: ghostVerify.status, code: ghostVerify.json.error.code }, { status: 404, code: 'not_found' });
    const unrun = await call('POST', '/graphs', { id: 'unrun', nodes: [{ id: 'a', action: 'filter' }] });
    assert.equal(unrun.status, 201);
    const noRun = await call('POST', '/graphs/unrun/verify', {});
    assert.deepEqual({ status: noRun.status, code: noRun.json.error.code }, { status: 409, code: 'verification_unavailable' });
  });

  test('a remote upload must recompute to the key it claims', async () => {
    const content = Buffer.from('remote artifact\n');
    const rejected = await call('PUT', `/cache/${hex('a')}`, content, {
      'content-type': 'application/octet-stream',
      'x-cache-command': JSON.stringify({ kind: 'copy-file', source: 'src/app.txt' }),
      'x-cache-inputs': JSON.stringify([fileWith('src/app.txt', `sha256:${hex('b')}`)]),
      'x-cache-env': JSON.stringify([]),
    });
    assert.equal(rejected.status, 400);
    assert.match(rejected.json.error.message, /same fields hash to/);

    const seed = hashIn('seed.bin', hex('e'));
    const seedBody = { name: 'remote-seed', command: { kind: 'write-file', content: 'remote artifact\n' }, inputs: [seed], env: [] };
    const acceptedKey = (await call('POST', '/actions', seedBody)).json.key;
    const upload = {
      'content-type': 'application/octet-stream',
      'x-cache-action': 'peer',
      'x-cache-command': JSON.stringify(seedBody.command),
      'x-cache-inputs': JSON.stringify([seed]),
      'x-cache-env': JSON.stringify([]),
    };
    assert.equal((await call('PUT', `/cache/${acceptedKey}`, content, upload)).status, 201);
    assert.equal((await call('GET', `/cache/${acceptedKey}`)).text, 'remote artifact\n');
    assert.equal((await call('PUT', `/cache/${acceptedKey}`, content, upload)).status, 409);
    assert.equal((await call('GET', `/cache/${hex('d')}`)).status, 404);
  });

  test('graphs carry resource limits end to end', async () => {
    const action = { name: 'res-filter', command: filterCmd(), inputs: [fileIn('src/app.txt')], env: ['LANG'] };
    assert.equal((await call('POST', '/actions', action)).status, 201);
    const created = await call('POST', '/graphs', {
      id: 'res-build',
      concurrency: 2,
      limits: { cpu: 2 },
      nodes: [{ id: 'compile', action: 'res-filter', resources: { cpu: 1 } }],
    });
    assert.equal(created.status, 201);
    assert.deepEqual(created.json.limits, { cpu: 2 });
    assert.deepEqual(created.json.nodes[0].resources, { cpu: 1 });

    const rejected = await call('POST', '/graphs', {
      id: 'res-bad',
      nodes: [{ id: 'a', action: 'res-filter', resources: { gpu: 1 } }],
    });
    assert.deepEqual({ status: rejected.status, code: rejected.json.error.code }, { status: 400, code: 'validation_error' });
    assert.equal((await call('GET', '/graphs/res-bad')).status, 404, 'a rejected graph is not stored');

    const fetched = await call('GET', '/graphs/res-build');
    assert.deepEqual(fetched.json.limits, { cpu: 2 });
    assert.deepEqual(fetched.json.nodes[0].resources, { cpu: 1 });
    const run = await call('POST', '/graphs/res-build/run', {});
    assert.deepEqual(run.json.resource_limits, { cpu: 2 });
    assert.deepEqual(run.json.peak_resources, { cpu: 1 });
    assert.deepEqual(run.json.nodes[0].resources, { cpu: 1 });
  });

  test('POST /cache/gc keeps last-run entries and collects the rest', async () => {
    const gcAction = { name: 'gc-filter', command: filterCmd(), inputs: [fileIn('src/app.txt')], env: ['LANG'] };
    assert.equal((await call('POST', '/actions', gcAction)).status, 201);
    assert.equal((await call('POST', '/graphs', { id: 'gc-build', nodes: [{ id: 'a', action: 'gc-filter' }] })).status, 201);
    const run = await call('POST', '/graphs/gc-build/run', {});
    const keptKey = run.json.nodes[0].key;

    const seed = hashIn('seed.bin', hex('e'));
    const seedBody = { name: 'gc-remote', command: { kind: 'write-file', content: 'gc remote\n' }, inputs: [seed], env: [] };
    const remoteKey = (await call('POST', '/actions', seedBody)).json.key;
    const upload = {
      'content-type': 'application/octet-stream',
      'x-cache-command': JSON.stringify(seedBody.command),
      'x-cache-inputs': JSON.stringify([seed]),
      'x-cache-env': JSON.stringify([]),
    };
    assert.equal((await call('PUT', `/cache/${remoteKey}`, Buffer.from('gc remote\n'), upload)).status, 201);

    const dry = await call('POST', '/cache/gc', { dry_run: true });
    assert.equal(dry.status, 200);
    assert.equal(dry.json.dry_run, true);
    assert.ok(dry.json.kept_keys.includes(keptKey));
    assert.ok(dry.json.removed_keys.includes(remoteKey));
    assert.equal((await call('GET', `/cache/${remoteKey}`)).status, 200, 'a dry run deletes nothing');

    for (const body of [{ keep: ['nope'] }, { dry_run: 'yes' }, { keep: [], extra: 1 }]) {
      const rejected = await call('POST', '/cache/gc', body);
      assert.deepEqual({ status: rejected.status, code: rejected.json.error.code }, { status: 400, code: 'validation_error' });
    }
    const missing = await call('POST', '/cache/gc', { keep: [hex('a')] });
    assert.deepEqual({ status: missing.status, code: missing.json.error.code }, { status: 404, code: 'not_found' });
    assert.equal((await call('GET', `/cache/${remoteKey}`)).status, 200, 'a failed request deletes nothing');

    const done = await call('POST', '/cache/gc', {});
    assert.equal(done.status, 200);
    assert.equal(done.json.dry_run, false);
    assert.ok(done.json.kept_keys.includes(keptKey));
    assert.ok(done.json.removed_keys.includes(remoteKey));
    for (const field of ['kept_keys', 'removed_keys', 'removed_digests']) {
      assert.deepEqual(done.json[field], [...done.json[field]].sort(), `${field} is sorted`);
      assert.equal(new Set(done.json[field]).size, done.json[field].length, `${field} has no duplicates`);
    }
    assert.equal((await call('GET', `/cache/${remoteKey}`)).status, 404);
    assert.equal((await call('GET', `/cache/${keptKey}`)).status, 200);
  });
});
