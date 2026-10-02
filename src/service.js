import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import { canonicalJson, digestOf, sha256Text } from './canonical.js';
import { ConflictError, NotFoundError, ValidationError } from './errors.js';
import { commandSources, executeArtifact, normalizeCommand } from './executor.js';
import {
  actionIdOf,
  actionKey,
  assertHash,
  assertName,
  normalizeCacheInputs,
  normalizeEnv,
  normalizeInputs,
  normalizePath,
  runKey,
  KEY_SCHEMA,
} from './key.js';
import { ObjectStore } from './store.js';

export const MANIFEST_SCHEMA = 'cachelattice/manifest/v1';
export const RUN_SCHEMA = 'cachelattice/run/v1';
const STATS_SCHEMA = 'cachelattice/stats/v1';

const GRAPH_FIELDS = ['id', 'nodes', 'concurrency'];
const NODE_FIELDS = ['id', 'action', 'needs'];
const ACTION_FIELDS = ['name', 'command', 'inputs', 'env', 'depends_on'];
const INPUT_FIELDS = ['kind', 'path', 'digest'];
const CACHE_ENTRY_FIELDS = ['action_id', 'command', 'inputs', 'env', 'depends_on'];

const HEX_KEY = /^[0-9a-f]{64}$/;
const ZERO_DIGEST = `sha256:${'0'.repeat(64)}`;

function rejectUnknown(object, allowed, label) {
  for (const key of Object.keys(object)) {
    if (!allowed.includes(key)) {
      throw new ValidationError(`${label} contains an unknown field: ${key}`);
    }
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeProducers(value, label) {
  if (!Array.isArray(value)) throw new ValidationError(`${label} depends_on must be an array of action names`);
  const names = value.map((name) => assertName(name, `${label} dependency`));
  if (new Set(names).size !== names.length) {
    throw new ValidationError(`${label} lists a dependency twice`);
  }
  return [...names].sort();
}

export function assertCacheKey(value) {
  if (typeof value !== 'string' || !HEX_KEY.test(value)) {
    throw new ValidationError(
      `cache key must be 64 lowercase hex characters, received ${JSON.stringify(value)}`,
    );
  }
  return value;
}

// A node key is only salted when there is something to fold in, which keeps the
// root node key of a graph exactly equal to the action key it runs.
export function nodeKeyOf(actionKey, upstreamKeys) {
  if (upstreamKeys.length === 0) return actionKey;
  return sha256Text(
    `cachelattice/node-key/v1\n${actionKey}\n${[...upstreamKeys].sort().join('\n')}`,
  );
}

export function dependencyRunKey(dependencies) {
  const lines = dependencies
    .map((dependency) => `${dependency.action_id}:${dependency.key}`)
    .join('\n');
  return sha256Text(`cachelattice/dependency-run/v1\n${lines}`);
}

// A miss and a hit must produce byte-identical manifests as well as
// byte-identical artifacts, so the manifest is derived purely from the action
// definition, the resolved dependency keys, and the artifact bytes. It carries
// no wall-clock timestamp, no node id, and no hint about whether it was
// recomputed or read back.
export function buildManifest({ actionId, key, command, inputs, env, dependencies, digest, size }) {
  return {
    schema: MANIFEST_SCHEMA,
    key_schema: KEY_SCHEMA,
    action_id: actionId,
    key,
    command,
    inputs,
    env,
    dependency_run_key: dependencyRunKey(dependencies),
    dependencies,
    digest: `sha256:${digest}`,
    size,
  };
}

// Deterministic synthetic execution cost, so a graph run has the same shape on
// every machine and concurrency is observable without a real toolchain.
function syntheticDelay(command) {
  return 10 + (parseInt(sha256Text(canonicalJson(command)).slice(0, 4), 16) % 40);
}

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export class Cachelattice {
  constructor({ dataDirectory, workspace, ambientEnv = process.env, clock = () => new Date() }) {
    this.store = new ObjectStore(dataDirectory);
    this.workspace = path.resolve(workspace);
    this.ambientEnv = ambientEnv;
    this.clock = clock;
    this.actions = new Map();
    this.graphs = new Map();
    this.runs = new Map();
    this.statsCache = null;
    this.loading = this.load();
  }

  async load() {
    for (const entry of await this.readRegistry('actions')) this.actions.set(entry.name, entry);
    for (const entry of await this.readRegistry('graphs')) this.graphs.set(entry.id, entry);
    for (const entry of await this.readRegistry('runs')) this.runs.set(entry.graph_id, entry);
    this.statsCache = (await this.store.readMeta('stats.json')) ?? this.blankStats();
  }

  async readRegistry(kind) {
    const index = (await this.store.readMeta(`index/${kind}.json`)) ?? { items: [] };
    const items = [];
    for (const id of index.items) {
      const entry = await this.store.readMeta(`${kind}/${id}.json`);
      if (entry) items.push(entry);
    }
    return items;
  }

  async writeRegistry(kind, id, entry) {
    await this.store.writeMeta(`${kind}/${id}.json`, entry);
    const index = (await this.store.readMeta(`index/${kind}.json`)) ?? { items: [] };
    if (!index.items.includes(id)) {
      await this.store.writeMeta(`index/${kind}.json`, { items: [...index.items, id].sort() });
    }
    return entry;
  }

  blankStats() {
    return {
      schema: STATS_SCHEMA,
      actions_registered: 0,
      graphs_registered: 0,
      graph_runs: 0,
      nodes_scheduled: 0,
      cache_hits: 0,
      cache_misses: 0,
      artifacts_executed: 0,
      cache_writes: 0,
      remote_reads: 0,
      remote_writes: 0,
      cache_entries: 0,
    };
  }

  async stats() {
    await this.loading;
    this.statsCache.cache_entries = (await this.store.listKeys(100000)).length;
    return { ...this.statsCache };
  }

  bump(field, amount = 1) {
    this.statsCache[field] += amount;
  }
  async persistStats() {
    await this.store.writeMeta('stats.json', this.statsCache);
  }

  actionView(action) {
    return {
      name: action.name,
      action_id: action.action_id,
      key: action.key,
      command: action.command,
      inputs: action.inputs,
      env: action.env.names,
      env_values: action.env.values,
      depends_on: action.depends_on,
    };
  }

  graphView(graph) {
    return { id: graph.id, concurrency: graph.concurrency, nodes: graph.nodes };
  }

  // ---------------------------------------------------------------- actions

  // Validates the declared input list and resolves each entry to the digest that
  // enters the key. File inputs are snapshotted here, at registration time, so an
  // action key stays stable when the workspace changes underneath it.
  async resolveInputs(declaredInputs) {
    if (!Array.isArray(declaredInputs) || declaredInputs.length === 0) {
      throw new ValidationError('action inputs must be a non-empty array');
    }
    const declared = normalizeInputs(
      declaredInputs.map((input) => {
        if (!isPlainObject(input)) throw new ValidationError('each input must be an object');
        rejectUnknown(input, INPUT_FIELDS, 'input');
        if (input.kind !== 'file' && input.kind !== 'hash') {
          throw new ValidationError('input kind must be "file" or "hash"');
        }
        if (input.kind === 'file' && 'digest' in input) {
          throw new ValidationError('a file input must not carry a digest; the service hashes it');
        }
        if (input.kind === 'hash' && !('digest' in input)) {
          throw new ValidationError('a hash input must carry a digest');
        }
        // normalizeInputs only sorts and de-duplicates; the real digest replaces
        // this placeholder below.
        return input.kind === 'file' ? { kind: 'file', path: input.path, digest: ZERO_DIGEST } : input;
      }),
    );
    const resolved = [];
    for (const input of declared) {
      resolved.push(
        input.kind === 'hash'
          ? { kind: 'hash', path: input.path, digest: assertHash(input.digest, 'input hash') }
          : { kind: 'file', path: input.path, digest: digestOf(await readWorkspaceFile(this.workspace, input.path)) },
      );
    }
    return resolved;
  }

  async putAction(body, { refresh = false } = {}) {
    await this.loading;
    if (!isPlainObject(body)) throw new ValidationError('request body must be a JSON object');
    rejectUnknown(body, ACTION_FIELDS, 'action');
    const name = assertName(body.name, 'action name');
    if (!isPlainObject(body.command)) throw new ValidationError('action command must be an object');
    if (!Array.isArray(body.env)) throw new ValidationError('action env must be an array of names');
    const inputs = await this.resolveInputs(body.inputs);

    const command = normalizeCommand(body.command);
    for (const source of commandSources(command)) {
      const normalized = normalizePath(source, 'command source');
      if (!inputs.some((input) => input.path === normalized)) {
        throw new ValidationError(`command reads ${normalized}, which is not a declared input`);
      }
    }
    if (command.kind === 'concat-text' && command.sources.length === 0) {
      throw new ValidationError('command sources must not be empty');
    }

    // A declared producer must exist and must have produced one of the hash
    // inputs. This keeps the causal chain honest: a consumer's key can only move
    // for a producer whose artifact it actually consumes.
    const dependsOn = normalizeProducers(body.depends_on ?? [], `action ${name}`);
    for (const producerName of dependsOn) {
      const producer = this.actions.get(producerName);
      if (!producer) throw new ValidationError(`action ${name} depends on unregistered action ${producerName}`);
      if (!inputs.some((input) => input.kind === 'hash' && input.digest === producer.key)) {
        throw new ValidationError(
          `action ${name} depends on ${producerName} but does not declare its artifact as a hash input`,
        );
      }
    }
    const env = normalizeEnv(body.env, this.ambientEnv);
    const entry = {
      name,
      action_id: actionIdOf(name),
      command,
      inputs,
      env,
      // The artifact of every producer named here must be declared as a hash
      // input, and the graph must wire exactly these producers as `needs`. The
      // producer *keys* are folded into the node key at run time (see plan()),
      // which is what makes an upstream change invalidate everything below it.
      depends_on: dependsOn,
    };
    entry.key = actionKey({ command: entry.command, inputs, env });

    // A name identifies one action. Registering it again is a conflict no matter
    // how similar the definition is, so that replacing an action is always the
    // explicit, reviewable act of a PUT.
    const previous = this.actions.get(name);
    if (previous && !refresh) {
      throw new ConflictError(
        `action ${name} is already registered; PUT /actions/${name} to replace it`,
      );
    }
    this.actions.set(name, entry);
    if (!previous) this.bump('actions_registered');
    await this.writeRegistry('actions', name, entry);
    await this.persistStats();
    return this.actionView(entry);
  }

  async getAction(name) {
    await this.loading;
    const entry = this.actions.get(name);
    if (!entry) throw new NotFoundError(`action ${name} is not registered`);
    return this.actionView(entry);
  }

  async listActions() {
    await this.loading;
    return [...this.actions.values()]
      .map((action) => this.actionView(action))
      .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  }

  // ---------------------------------------------------------------- graphs

  async putGraph(graphId, body) {
    await this.loading;
    const id = assertName(graphId, 'graph id');
    if (!isPlainObject(body)) throw new ValidationError('request body must be a JSON object');
    rejectUnknown(body, GRAPH_FIELDS, 'graph');
    if (body.id !== undefined && body.id !== id) {
      throw new ValidationError('graph body id must match the path id');
    }
    if (!Array.isArray(body.nodes) || body.nodes.length === 0) {
      throw new ValidationError('graph nodes must be a non-empty array');
    }
    const concurrency = body.concurrency === undefined ? 1 : body.concurrency;
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 64) {
      throw new ValidationError('graph concurrency must be an integer between 1 and 64');
    }

    const nodes = body.nodes.map((node) => {
      if (!isPlainObject(node)) throw new ValidationError('each graph node must be an object');
      rejectUnknown(node, NODE_FIELDS, 'graph node');
      const nodeId = assertName(node.id, 'node id');
      const action = assertName(node.action, 'node action');
      const needs = node.needs === undefined ? [] : node.needs;
      if (!Array.isArray(needs)) throw new ValidationError(`node ${nodeId} needs must be an array`);
      if (new Set(needs).size !== needs.length) {
        throw new ValidationError(`node ${nodeId} lists a dependency twice`);
      }
      for (const dependency of needs) assertName(dependency, `node ${nodeId} dependency`);
      return { id: nodeId, action, needs: [...needs].sort() };
    });

    const seen = new Set();
    for (const node of nodes) {
      if (seen.has(node.id)) throw new ValidationError(`duplicate node id: ${node.id}`);
      for (const dependency of node.needs) {
        if (dependency === node.id) throw new ValidationError(`node ${node.id} needs itself`);
        if (!seen.has(dependency)) {
          throw new ValidationError(
            `node ${node.id} needs ${dependency}, which is not defined earlier in the graph; a dependency cycle is not allowed`,
          );
        }
      }
      if (!this.actions.has(node.action)) {
        throw new ValidationError(`node ${node.id} references unregistered action ${node.action}`);
      }
      seen.add(node.id);
    }

    const entry = { id, concurrency, nodes };
    const existed = this.graphs.has(id);
    this.graphs.set(id, entry);
    if (!existed) this.bump('graphs_registered');
    await this.writeRegistry('graphs', id, entry);
    await this.persistStats();
    return this.graphView(entry);
  }

  async getGraph(graphId) {
    await this.loading;
    const graph = this.graphs.get(graphId);
    if (!graph) throw new NotFoundError(`graph ${graphId} is not registered`);
    const lastRun = this.runs.get(graphId) ?? null;
    return {
      ...this.graphView(graph),
      last_run: lastRun
        ? {
            run_key: lastRun.run_key,
            completed_at: lastRun.completed_at,
            duration_ms: lastRun.duration_ms,
            peak_parallel: lastRun.peak_parallel,
            cache_hits: lastRun.cache_hits,
            cache_misses: lastRun.cache_misses,
            nodes: lastRun.nodes.map((node) => ({
              id: node.id,
              action: node.action,
              key: node.key,
              digest: node.digest,
              cache: node.cache,
            })),
          }
        : null,
    };
  }

  async listGraphs() {
    await this.loading;
    return [...this.graphs.values()]
      .map((graph) => this.graphView(graph))
      .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  }

  // --------------------------------------------------------------- planning

  // Resolves every node to a concrete action key. A node's key folds in the keys
  // of every action it needs, so a change anywhere upstream moves every key
  // downstream of it.
  plan(graphId) {
    const graph = this.graphs.get(graphId);
    if (!graph) throw new NotFoundError(`graph ${graphId} is not registered`);
    const byId = new Map(graph.nodes.map((node) => [node.id, node]));
    const planned = new Map();

    const visit = (nodeId, trail) => {
      const known = planned.get(nodeId);
      if (known) return known;
      if (trail.has(nodeId)) {
        throw new ConflictError(`graph ${graphId} contains a dependency cycle through ${nodeId}`);
      }
      trail.add(nodeId);
      const node = byId.get(nodeId);
      if (!node) throw new ValidationError(`graph ${graphId} has no node ${nodeId}`);
      const action = this.actions.get(node.action);
      if (!action) {
        throw new ConflictError(`node ${nodeId} references action ${node.action}, which no longer exists`);
      }
      const upstream = node.needs.map((needed) => visit(needed, trail));
      const produced = upstream.map((entry) => entry.action.name).sort();
      const declared = action.depends_on;
      if (produced.join('\n') !== declared.join('\n')) {
        throw new ConflictError(
          `node ${nodeId} is wired to [${produced.join(', ')}] but action ${action.name} declares ` +
            `depends_on [${declared.join(', ')}]; re-register the action or rewire the graph`,
        );
      }
      const key = nodeKeyOf(action.key, upstream.map((entry) => entry.key));
      trail.delete(nodeId);
      const resolved = {
        node,
        action,
        key,
        dependencies: upstream
          .map((entry) => ({ action_id: entry.action.name, key: entry.key }))
          .sort((left, right) =>
            left.action_id < right.action_id ? -1 : left.action_id > right.action_id ? 1 : 0,
          ),
      };
      planned.set(nodeId, resolved);
      return resolved;
    };

    for (const node of graph.nodes) visit(node.id, new Set());
    return planned;
  }

  // -------------------------------------------------------------- execution

  async runGraph(graphId, { useCache = true } = {}) {
    await this.loading;
    const graph = this.graphs.get(graphId);
    if (!graph) throw new NotFoundError(`graph ${graphId} is not registered`);
    const planned = this.plan(graphId);
    const key = runKey(
      graph.nodes.map((node) => ({ action_id: planned.get(node.id).action.name, key: planned.get(node.id).key })),
    );

    // A run is always scheduled; there is no whole-run fast path, because the
    // answer to "was this a cache hit?" must come from the store on every run.
    // `plan_reused` only reports that no key moved since the previous run.
    const previous = this.runs.get(graphId) ?? null;
    const stale = graph.nodes.flatMap((node) => {
      const before = previous?.nodes.find((candidate) => candidate.id === node.id);
      const action = planned.get(node.id);
      return before && before.key !== action.key
        ? [{ id: node.id, action: action.action.name, was: before.key, now: action.key }]
        : [];
    });
    const planReused = previous !== null && previous.run_key === key;

    const state = new Map(graph.nodes.map((node) => [node.id, { node, status: 'pending' }]));
    const isReady = (id) =>
      state.get(id).status === 'pending' &&
      state.get(id).node.needs.every((needed) => state.get(needed).status === 'done');
    const readyIds = () => graph.nodes.map((node) => node.id).filter(isReady).sort();

    let hits = 0;
    let misses = 0;
    let inFlight = 0;
    let peakParallel = 0;
    const startedAt = Date.now();
    this.bump('graph_runs');
    this.bump('nodes_scheduled', graph.nodes.length);

    const results = [];
    while (results.length < graph.nodes.length) {
      // Deterministic dispatch order: lexicographic by node id. Concurrency is
      // the only source of timing freedom and never changes an artifact.
      while (inFlight < graph.concurrency && readyIds().length > 0) {
        const entry = state.get(readyIds()[0]);
        entry.status = 'running';
        inFlight += 1;
        peakParallel = Math.max(peakParallel, inFlight);
        const dependencies = entry.node.needs.map((needed) => {
          const produced = state.get(needed).result;
          return { action_id: produced.action_id, key: produced.key };
        });
        entry.promise = this.executeNode(planned.get(entry.node.id), dependencies, { useCache })
          .then((outcome) => {
            entry.status = 'done';
            entry.result = outcome;
            results.push(outcome);
            if (outcome.cache === 'hit') hits += 1;
            else misses += 1;
          })
          .catch((error) => {
            entry.status = 'failed';
            entry.error = error;
          })
          .finally(() => {
            inFlight -= 1;
          });
      }
      const running = [...state.values()].filter((entry) => entry.status === 'running');
      if (running.length === 0) {
        // A failed node must surface as a failed request, never as a hang.
        const failed = [...state.values()].find((entry) => entry.status === 'failed');
        if (failed) throw failed.error;
        if (results.length < graph.nodes.length) {
          throw new ConflictError(`graph ${graphId} has no schedulable node; check its dependencies`);
        }
        break;
      }
      await Promise.all(running.map((entry) => entry.promise));
    }

    const nodes = results
      .map((result) => ({
        id: result.id,
        action: result.action_id,
        key: result.key,
        digest: result.digest,
        size: result.size,
        cache: result.cache,
        dependencies: result.dependencies,
      }))
      .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));

    const record = {
      schema: RUN_SCHEMA,
      graph_id: graphId,
      run_key: key,
      completed_at: this.clock().toISOString(),
      concurrency: graph.concurrency,
      duration_ms: Date.now() - startedAt,
      peak_parallel: peakParallel,
      plan_reused: planReused,
      cache_hits: hits,
      cache_misses: misses,
      stale_nodes: stale,
      nodes,
    };
    this.runs.set(graphId, record);
    await this.writeRegistry('runs', graphId, record);
    this.bump('cache_hits', hits);
    this.bump('cache_misses', misses);
    await this.persistStats();

    return {
      graph_id: graphId,
      run_key: key,
      plan_reused: planReused,
      cache_hits: hits,
      cache_misses: misses,
      peak_parallel: peakParallel,
      stale_nodes: stale,
      nodes,
    };
  }

  async executeNode(planned, dependencies, { useCache }) {
    const { node, action, key } = planned;
    if (useCache && this.store.hasManifest(key)) {
      const { manifest } = await this.store.readArtifact(key);
      this.assertManifestMatches(manifest, action, key);
      return {
        id: node.id,
        action_id: action.name,
        key,
        digest: manifest.digest,
        size: manifest.size,
        cache: 'hit',
        dependencies,
      };
    }

    await sleep(syntheticDelay(action.command));
    const buffer = await executeArtifact({
      command: action.command,
      inputs: action.inputs,
      env: action.env,
      dependencies,
      workspace: this.workspace,
    });
    const digest = await this.store.writeBlob(buffer);
    const manifest = buildManifest({
      actionId: action.name,
      key,
      command: action.command,
      inputs: action.inputs,
      env: action.env,
      dependencies,
      digest,
      size: buffer.length,
    });
    // A concurrent miss for the same key may have won the race. The manifests
    // are identical by construction, so the winner is irrelevant; the blob is
    // content-addressed, so there is only ever one possibility.
    if (!this.store.hasManifest(key)) await this.store.writeManifest(key, manifest);
    this.bump('artifacts_executed');
    this.bump('cache_writes');
    return {
      id: node.id,
      action_id: action.name,
      key,
      digest: manifest.digest,
      size: manifest.size,
      cache: 'miss',
      dependencies,
    };
  }

  // ---------------------------------------------------------------- verify

  // Re-executes the graph with cache reads disabled and compares every node with
  // what the cache already holds, by digest and byte by byte. A cache entry that
  // cannot even be read back (missing blob, tampered bytes) is reported as an
  // issue rather than raised, because that is exactly what verification is for.
  async verifyGraph(graphId) {
    await this.loading;
    const baseline = this.runs.get(graphId);
    if (!baseline) throw new NotFoundError(`graph ${graphId} has no completed run to verify`);
    const cached = new Map();
    const issues = [];
    for (const node of baseline.nodes) {
      try {
        const entry = await this.store.readArtifact(node.key);
        cached.set(node.id, { digest: node.digest, buffer: entry.buffer });
      } catch (error) {
        issues.push({ id: node.id, issue: 'cache_unreadable', detail: error.message });
      }
    }
    const rerun = await this.runGraph(graphId, { useCache: false });
    let byteIdentical = 0;
    for (const node of rerun.nodes) {
      const before = cached.get(node.id);
      if (!before) {
        if (!issues.some((issue) => issue.id === node.id)) {
          issues.push({ id: node.id, issue: 'missing_from_baseline' });
        }
        continue;
      }
      if (before.digest !== node.digest) {
        issues.push({ id: node.id, issue: 'digest_changed', cached: before.digest, recomputed: node.digest });
        continue;
      }
      let after;
      try {
        after = await this.store.readArtifact(node.key);
      } catch (error) {
        issues.push({ id: node.id, issue: 'cache_unreadable', detail: error.message });
        continue;
      }
      if (before.buffer.equals(after.buffer)) byteIdentical += 1;
      else issues.push({ id: node.id, issue: 'bytes_differ', digest: node.digest });
    }
    return {
      graph_id: graphId,
      run_key: rerun.run_key,
      identical: issues.length === 0,
      comparisons: rerun.nodes.length,
      byte_identical: byteIdentical,
      issues,
    };
  }

  // ----------------------------------------------------------------- cache

  async cacheGet(key) {
    await this.loading;
    const normalized = assertCacheKey(key);
    const { manifest, buffer } = await this.store.readArtifact(normalized);
    return { manifest, buffer };
  }

  // Ingest an action manifest. Any peer that knows a cached action key may push
  // the entry, and it is accepted only when every hashed field in the manifest
  // still recomputes to the key being claimed.
  async cachePut(key, entry, buffer) {
    await this.loading;
    const normalized = assertCacheKey(key);
    if (!isPlainObject(entry)) throw new ValidationError('cache entry must be a JSON object');
    rejectUnknown(entry, CACHE_ENTRY_FIELDS, 'cache entry');
    if (!isPlainObject(entry.command)) throw new ValidationError('cache entry command must be an object');
    if (!Array.isArray(entry.inputs) || !Array.isArray(entry.env)) {
      throw new ValidationError('cache entry inputs and env must be arrays');
    }
    for (const input of entry.inputs) {
      if (!isPlainObject(input)) throw new ValidationError('cache entry inputs must be objects');
      rejectUnknown(input, INPUT_FIELDS, 'cache entry input');
      if (input.kind !== 'file' && input.kind !== 'hash') {
        throw new ValidationError('cache entry input kind must be "file" or "hash"');
      }
    }
    const command = normalizeCommand(entry.command);
    const inputsValue = normalizeCacheInputs(entry.inputs);
    const names = entry.env.map((name) => {
      if (typeof name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
        throw new ValidationError('cache entry env must be an array of variable names');
      }
      return name;
    });
    if (new Set(names).size !== names.length) {
      throw new ValidationError('cache entry env names must be unique');
    }
    // Copied so the manifest never aliases caller-owned state.
    const inputs = inputsValue.map((input) => ({ ...input }));
    const env = { names: [...names].sort(), values: {} };
    const recomputed = actionKey({ command, inputs, env });
    if (recomputed !== normalized) {
      throw new ValidationError(
        `cache entry does not describe key ${normalized}: the same fields hash to ${recomputed}`,
      );
    }
    const manifestKey = normalized;
    if (this.store.hasManifest(manifestKey)) {
      throw new ConflictError(`cache entry ${normalized} already exists`);
    }
    const digest = await this.store.writeBlob(buffer);
    // A remote entry carries no resolved dependency keys, so it is only ever
    // reachable as the entry of a root node - exactly the entries a peer can
    // hand over without shipping its whole graph.
    const manifest = buildManifest({
      actionId: entry.action_id ?? 'remote',
      key: normalized,
      command,
      inputs,
      env,
      dependencies: [],
      digest,
      size: buffer.length,
    });
    await this.store.writeManifest(manifestKey, manifest);
    this.bump('remote_writes');
    this.bump('cache_writes');
    await this.persistStats();
    return manifest;
  }

  async remoteRead(key) {
    await this.loading;
    const entry = await this.cacheGet(key);
    this.bump('remote_reads');
    await this.persistStats();
    return entry;
  }

  async cacheEntries(limit = 500) {
    await this.loading;
    return this.store.listKeys(limit);
  }

  // ----------------------------------------------------------- idempotency

  async recall(operation, idempotencyKey) {
    await this.loading;
    if (typeof idempotencyKey !== 'string' || idempotencyKey.length === 0) return null;
    if (idempotencyKey.length > 255) {
      throw new ValidationError('Idempotency-Key must be at most 255 characters');
    }
    const record = await this.store.readMeta(
      `idempotency/${sha256Text(`${operation}\n${idempotencyKey}`)}.json`,
    );
    return record ? { status: record.status, body: record.body } : null;
  }

  async remember(operation, idempotencyKey, response) {
    await this.loading;
    if (typeof idempotencyKey !== 'string' || idempotencyKey.length === 0) return;
    await this.store.writeMeta(
      `idempotency/${sha256Text(`${operation}\n${idempotencyKey}`)}.json`,
      {
        schema: 'cachelattice/idempotency/v1',
        operation,
        status: response.status,
        body: response.body,
      },
    );
  }

  // A cache entry is valid for a node when the manifest's hashed fields still
  // describe the action the node runs: same command, same input digests, same
  // environment variable names. The action_id is provenance only - two
  // differently named actions with the same definition legitimately share one
  // entry, and the first one to run wins the label.
  assertManifestMatches(manifest, action, key) {
    if (manifest.key !== key) {
      throw new ConflictError(`cache entry ${key} claims to belong to ${manifest.key}`);
    }
    const shape = (command, inputs, envNames) =>
      canonicalJson({ command, inputs, env_names: envNames });
    if (
      shape(manifest.command, manifest.inputs, manifest.env.names) !==
      shape(action.command, action.inputs, action.env.names)
    ) {
      throw new ConflictError(`cache entry for ${key} was produced from different inputs`);
    }
  }
}

export async function readWorkspaceFile(workspace, relative) {
  const absolute = path.join(workspace, relative);
  if (absolute !== workspace && !absolute.startsWith(workspace + path.sep)) {
    throw new ValidationError(`path escapes the workspace: ${relative}`);
  }
  let info;
  try {
    info = await stat(absolute);
  } catch (error) {
    if (error.code === 'ENOENT') throw new ValidationError(`input file does not exist: ${relative}`);
    throw error;
  }
  if (!info.isFile()) throw new ValidationError(`input path is not a regular file: ${relative}`);
  return readFile(absolute);
}
