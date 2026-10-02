import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { after, afterEach, before, beforeEach, describe, test } from 'node:test';

import { canonicalJson, digestOf } from '../src/canonical.js';
import { ConflictError, NotFoundError, ValidationError } from '../src/errors.js';
import { executeArtifact, normalizeCommand } from '../src/executor.js';
import { actionKey, normalizeCacheInputs, normalizeEnv, normalizeInputs, normalizePath } from '../src/key.js';
import { Cachelattice } from '../src/service.js';
import { createServer } from '../src/server.js';
import { ObjectStore } from '../src/store.js';

const runCli = promisify(execFile);
const CLI_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.js');

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

  test('verify reports byte identical artifacts, or corruption', async () => {
    await registerFilter();
    const run = await runOne();
    const clean = await service.verifyGraph('build');
    assert.deepEqual(
      { identical: clean.identical, comparisons: clean.comparisons, bytes: clean.byte_identical, issues: clean.issues },
      { identical: true, comparisons: 1, bytes: 1, issues: [] },
    );
    await writeFile(service.store.blobPath(run.nodes[0].digest.slice('sha256:'.length)), 'tampered');
    const tampered = await service.verifyGraph('build');
    assert.deepEqual(
      { identical: tampered.identical, bytes: tampered.byte_identical, issue: tampered.issues[0].issue },
      { identical: false, bytes: 0, issue: 'cache_unreadable' },
    );
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

describe('garbage collection', () => {
  // Two distinct commands so the two graphs produce distinct keys, digests and
  // blob sizes: pattern 'a' matches all three lines (18 bytes), 'beta' matches
  // only "beta" (5 bytes).
  const seedTwo = async () => {
    await registerFilter('first');
    await registerFilter('second', { pattern: 'beta' });
    await service.putGraph('g1', { id: 'g1', nodes: [{ id: 'a', action: 'first' }] });
    await service.putGraph('g2', { id: 'g2', nodes: [{ id: 'b', action: 'second' }] });
    const r1 = await service.runGraph('g1');
    const r2 = await service.runGraph('g2');
    return {
      key1: r1.nodes[0].key,
      key2: r2.nodes[0].key,
      digest1: r1.nodes[0].digest,
      digest2: r2.nodes[0].digest,
      size1: r1.nodes[0].size,
      size2: r2.nodes[0].size,
    };
  };

  // A valid cache entry with no graph run pinning it, exactly what default
  // retention must collect.
  const seedUnpinned = async (name = 'extra') => {
    const bytes = Buffer.from('unpinned extra\n');
    const input = hashIn(`${name}.bin`, hex('c'));
    const action = await service.putAction({
      name,
      command: { kind: 'write-file', content: 'unpinned extra\n' },
      inputs: [input],
      env: [],
    });
    await service.cachePut(
      action.key,
      { action_id: 'peer', command: { kind: 'write-file', content: 'unpinned extra\n' }, inputs: [input], env: [] },
      bytes,
    );
    return { action, bytes, digest: digestOf(bytes) };
  };

  test('keeps last_run keys by default and removes the rest with their blobs', async () => {
    const seeded = await seedTwo();
    const extra = await seedUnpinned();
    const result = await service.collectGarbage({});
    assert.deepEqual([...result.kept_keys].sort(), [seeded.key1, seeded.key2].sort());
    assert.deepEqual(result.removed_keys, [extra.action.key]);
    assert.deepEqual(result.removed_digests, [extra.digest]);
    assert.equal(result.removed_bytes, extra.bytes.length);
    assert.equal(service.store.hasManifest(extra.action.key), false);
    assert.equal(service.store.hasBlob(extra.digest.slice('sha256:'.length)), false);
  });

  test('sums unique referenced blob bytes and keeps serving retained entries', async () => {
    const seeded = await seedTwo();
    const result = await service.collectGarbage({ keep: [] });
    assert.equal(result.dry_run, false);
    assert.deepEqual([...result.kept_keys].sort(), [seeded.key1, seeded.key2].sort());
    assert.deepEqual(result.removed_keys, []);
    assert.deepEqual(result.removed_digests, []);
    assert.equal(result.kept_bytes, seeded.size1 + seeded.size2);
    assert.equal(result.removed_bytes, 0);
    assert.equal((await service.cacheGet(seeded.key1)).buffer.toString(), 'alpha\nbeta\ngamma\n');
    assert.equal((await service.cacheGet(seeded.key2)).buffer.toString(), 'beta\n');
  });

  test('an orphan blob is removed and counted once', async () => {
    const seeded = await seedTwo();
    const orphan = Buffer.from('nobody references me\n');
    const orphanDigest = await service.store.writeBlob(orphan);
    const result = await service.collectGarbage({});
    assert.deepEqual(result.removed_digests, [`sha256:${orphanDigest}`]);
    assert.equal(result.removed_bytes, orphan.length);
    assert.equal(service.store.hasBlob(orphanDigest), false);
    assert.equal(service.store.hasBlob(seeded.digest1.slice('sha256:'.length)), true);
  });

  test('keep pins extra keys; order and repetition are irrelevant', async () => {
    const seeded = await seedTwo();
    const extra = await seedUnpinned();
    const result = await service.collectGarbage({ keep: [extra.action.key, seeded.key1, extra.action.key] });
    assert.deepEqual([...result.kept_keys].sort(), [seeded.key1, seeded.key2, extra.action.key].sort());
    assert.deepEqual(result.removed_keys, []);
    assert.deepEqual(result.removed_digests, []);
    assert.equal(service.store.hasManifest(extra.action.key), true);
  });

  test('dry run reports the same sets and bytes but deletes nothing', async () => {
    const seeded = await seedTwo();
    const extra = await seedUnpinned();
    const dry = await service.collectGarbage({ dry_run: true, keep: [] });
    assert.equal(dry.dry_run, true);
    assert.deepEqual(dry.removed_keys, [extra.action.key]);
    assert.equal(dry.removed_bytes, extra.bytes.length);
    assert.equal(service.store.hasManifest(extra.action.key), true, 'a dry run deletes no manifest');
    assert.equal(service.store.hasBlob(extra.digest.slice('sha256:'.length)), true, 'a dry run deletes no blob');

    const real = await service.collectGarbage({});
    assert.equal(real.dry_run, false);
    assert.deepEqual(real.kept_keys, dry.kept_keys);
    assert.deepEqual(real.removed_keys, dry.removed_keys);
    assert.deepEqual(real.removed_digests, dry.removed_digests);
    assert.equal(real.kept_bytes, dry.kept_bytes);
    assert.equal(real.removed_bytes, dry.removed_bytes);
    assert.equal(service.store.hasManifest(extra.action.key), false);
  });

  test('a graph without a last run contributes no retained key', async () => {
    const seeded = await seedTwo();
    const lonely = await registerFilter('lonely', { pattern: 'gamma' });
    await service.putGraph('never-run', { id: 'never-run', nodes: [{ id: 'z', action: 'lonely' }] });
    // The entry exists (a standalone run produced it) but no surviving last run pins it.
    await runOne('lonely', 'lonely-run');
    service.runs.delete('lonely-run');
    await service.store.deleteMeta('runs/lonely-run.json');
    const result = await service.collectGarbage({});
    assert.ok(result.removed_keys.includes(lonely.key));
    assert.ok(!result.kept_keys.includes(lonely.key));
    assert.ok(result.kept_keys.includes(seeded.key1));
  });

  test('a missing keep key is 404 and deletes nothing', async () => {
    await seedTwo();
    const ghost = hex('9');
    await assert.rejects(
      service.collectGarbage({ keep: [ghost] }),
      (error) => error instanceof NotFoundError && new RegExp(ghost).test(error.message),
    );
    assert.equal((await service.cacheEntries()).length, 2, 'the aborted collection left both entries');
  });

  test('illegal keys, bad dry_run, unknown fields and a non-object body are 400', async () => {
    await seedTwo();
    await assert.rejects(service.collectGarbage({ keep: ['nope'] }), (e) => e instanceof ValidationError);
    await assert.rejects(service.collectGarbage({ keep: ['XYZ'] }), (e) => e instanceof ValidationError);
    await assert.rejects(service.collectGarbage({ keep: 'x' }), (e) => e instanceof ValidationError);
    await assert.rejects(service.collectGarbage({ keep: [123] }), (e) => e instanceof ValidationError);
    await assert.rejects(service.collectGarbage({ dry_run: 'yes' }), (e) => e instanceof ValidationError);
    await assert.rejects(service.collectGarbage({ surprise: 1 }), /unknown field: surprise/);
    await assert.rejects(service.collectGarbage(null), (e) => e instanceof ValidationError);
    assert.equal((await service.cacheEntries()).length, 2, 'failed collections delete nothing');
  });

  test('every unsound manifest or blob aborts with 400 before any deletion', async () => {
    const seeded = await seedTwo();
    const m1 = (await service.cacheGet(seeded.key1)).manifest;
    const digest1Hex = seeded.digest1.slice('sha256:'.length);
    const digest2Hex = seeded.digest2.slice('sha256:'.length);
    const expectAbort = async () => {
      await assert.rejects(service.collectGarbage({}), (e) => e instanceof ValidationError);
      assert.equal(service.store.hasManifest(seeded.key1), true);
      assert.equal(service.store.hasManifest(seeded.key2), true);
      assert.equal(service.store.hasBlob(digest2Hex), true, 'a failed scan deletes no objects');
    };

    // Invalid manifest JSON.
    await writeFile(service.store.manifestPath(seeded.key1), '{not json\n');
    await expectAbort();

    // Manifest whose stored key does not match its file name.
    await service.store.writeManifest(seeded.key1, { ...m1, key: seeded.key2 });
    await expectAbort();

    // A missing digest value and an illegally shaped digest both fail validation.
    const { digest: omitted, ...withoutDigest } = m1;
    await writeFile(service.store.manifestPath(seeded.key1), `${canonicalJson(withoutDigest)}\n`);
    await expectAbort();
    await service.store.writeManifest(seeded.key1, { ...m1, digest: 'sha256:zz' });
    await expectAbort();

    // A well-formed digest naming a blob that is not on disk.
    await service.store.writeManifest(seeded.key1, { ...m1, digest: `sha256:${hex('d')}` });
    await expectAbort();

    // A present blob whose bytes do not hash to the claimed digest.
    await writeFile(service.store.blobPath(digest1Hex), 'wrong bytes');
    await service.store.writeManifest(seeded.key1, { ...m1, digest: seeded.digest1 });
    await expectAbort();
  });

  test('gc leaves cache reads, stats, runs and verification working', async () => {
    const seeded = await seedTwo();
    await service.collectGarbage({});
    assert.equal((await service.cacheGet(seeded.key1)).manifest.digest, seeded.digest1);
    const run = await service.runGraph('g1');
    assert.equal(run.cache_hits, 1);
    const verify = await service.verifyGraph('g1');
    assert.equal(verify.identical, true);
    assert.equal((await service.stats()).cache_entries, 2);
  });
});

describe('gc CLI', () => {
  test('gc prints the same JSON and honors --keep and --dry-run', async () => {
    const dataDir = path.join(root, 'cli-data');
    const local = new Cachelattice({ dataDirectory: dataDir, workspace, ambientEnv: AMBIENT });
    await local.loading;
    const action = await local.putAction({
      name: 'cli-filter',
      command: filterCmd(),
      inputs: [fileIn('src/app.txt')],
      env: ['LANG'],
    });
    await local.putGraph('b', { id: 'b', nodes: [{ id: 'n', action: 'cli-filter' }] });
    await local.runGraph('b');

    const dry = await runCli(process.execPath, [CLI_PATH, 'gc', '--data', dataDir, '--dry-run']);
    assert.deepEqual(JSON.parse(dry.stdout), {
      dry_run: true,
      kept_keys: [action.key],
      removed_keys: [],
      removed_digests: [],
      kept_bytes: 'alpha\nbeta\ngamma\n'.length,
      removed_bytes: 0,
    });
    // The dry run removed nothing, so the entry is still there.
    const repeated = await runCli(process.execPath, [
      CLI_PATH,
      'gc',
      '--data',
      dataDir,
      '--keep',
      action.key,
    ]);
    const repeatedJson = JSON.parse(repeated.stdout);
    assert.equal(repeatedJson.dry_run, false);
    assert.deepEqual(repeatedJson.kept_keys, [action.key]);
    assert.deepEqual(repeatedJson.removed_keys, []);
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
    const verify = await call('POST', '/graphs/build/verify', {});
    assert.deepEqual(
      { identical: verify.json.identical, bytes: verify.json.byte_identical, issues: verify.json.issues },
      { identical: true, bytes: 1, issues: [] },
    );
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

  test('POST /cache/gc retains last run keys, dry runs, collects and reports errors', async () => {
    const graph = await call('GET', '/graphs/build');
    const pinned = graph.json.last_run.nodes[0].key;
    const before = await call('GET', '/cache');
    const removable = before.json.entries.filter((key) => key !== pinned);
    assert.equal(removable.length, 1, 'the remote-uploaded entry is pinned by no graph run');

    const dry = await call('POST', '/cache/gc', { dry_run: true });
    assert.equal(dry.status, 200);
    assert.equal(dry.json.dry_run, true);
    assert.deepEqual(dry.json.kept_keys, [pinned]);
    assert.deepEqual(dry.json.removed_keys, removable);
    assert.equal(dry.json.removed_bytes, 'remote artifact\n'.length);
    // A dry run leaves every object in place.
    assert.deepEqual((await call('GET', '/cache')).json.entries, before.json.entries);

    const real = await call('POST', '/cache/gc', {});
    assert.equal(real.status, 200);
    assert.equal(real.json.dry_run, false);
    assert.deepEqual(real.json.kept_keys, [pinned]);
    assert.deepEqual(real.json.removed_keys, removable);
    assert.deepEqual((await call('GET', '/cache')).json.entries, [pinned]);
    assert.equal((await call('GET', `/cache/${pinned}?meta=1`)).status, 200, 'the retained entry still serves');

    assert.equal((await call('POST', '/cache/gc', { keep: [hex('9')] })).status, 404);
    assert.equal((await call('POST', '/cache/gc', { keep: ['nope'] })).status, 400);
    assert.equal((await call('POST', '/cache/gc', { dry_run: 1 })).status, 400);
    assert.equal((await call('POST', '/cache/gc', { bogus: true })).status, 400);
    assert.equal((await call('POST', '/cache/gc', 'nope')).status, 400);
  });
});
