import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import { canonicalJson, digestOf, sha256Text, assertDigest } from './canonical.js';import {
  CachelatticeError,
  ConflictError,
  NotFoundError,
  ReproducibilityMismatchError,
  ValidationError,
  VerificationUnavailableError,
} from './errors.js';
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
const VERIFY_SCHEMA = 'cachelattice/verify/v1';
const AUDIT_SCHEMA = 'cachelattice/audit/v1';
const STATS_SCHEMA = 'cachelattice/stats/v1';

const GRAPH_FIELDS = ['id', 'nodes', 'concurrency', 'limits'];
const NODE_FIELDS = ['id', 'action', 'needs', 'resources'];
const ACTION_FIELDS = ['name', 'command', 'inputs', 'env', 'depends_on'];
const INPUT_FIELDS = ['kind', 'path', 'digest'];
const CACHE_ENTRY_FIELDS = ['action_id', 'command', 'inputs', 'env', 'depends_on'];

const HEX_KEY = /^[0-9a-f]{64}$/;
const ZERO_DIGEST = `sha256:${'0'.repeat(64)}`;
const RESOURCE_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;
const RESOURCE_MAX = 1000000;

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

// Resource declarations are scheduling hints only: they gate when a node may
// start, never what it computes, so they live outside every key, manifest and
// artifact. Both limits and resources are plain objects from a resource name to
// a non-negative integer amount.
function normalizeResourceMap(value, label, minimum) {
  if (!isPlainObject(value)) throw new ValidationError(`${label} must be a plain object`);
  const normalized = {};
  for (const [name, amount] of Object.entries(value)) {
    if (!RESOURCE_NAME.test(name)) {
      throw new ValidationError(
        `resource name must match [A-Za-z][A-Za-z0-9_-]{0,31}, received ${JSON.stringify(name)}`,
      );
    }
    if (!Number.isInteger(amount) || amount < minimum || amount > RESOURCE_MAX) {
      throw new ValidationError(`${label} ${name} must be an integer between ${minimum} and ${RESOURCE_MAX}`);
    }
    normalized[name] = amount;
  }
  return normalized;
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

const byNodeId = (left, right) => (left.node_id < right.node_id ? -1 : left.node_id > right.node_id ? 1 : 0);

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

const MANIFEST_FIELDS = [
  'schema',
  'key_schema',
  'action_id',
  'key',
  'command',
  'inputs',
  'env',
  'dependency_run_key',
  'dependencies',
  'digest',
  'size',
];

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

// Structural validation of a stored manifest, mirroring buildManifest's output.
// Returns a human-readable reason when the document cannot be a manifest, and
// null when it is structurally sound. The digest/size *format* check is left to
// the audit's manifest_invalid_digest stage, which owns that code.
function validateManifestSchema(manifest) {
  if (!isPlainObject(manifest)) return 'manifest must be a JSON object';
  const fields = Object.keys(manifest);
  for (const field of fields) {
    if (!MANIFEST_FIELDS.includes(field)) return `manifest contains an unknown field: ${field}`;
  }
  for (const field of MANIFEST_FIELDS) {
    if (!(field in manifest)) return `manifest is missing the ${field} field`;
  }
  if (manifest.schema !== MANIFEST_SCHEMA) return `manifest schema must be ${MANIFEST_SCHEMA}`;
  if (manifest.key_schema !== KEY_SCHEMA) return `manifest key_schema must be ${KEY_SCHEMA}`;
  if (typeof manifest.action_id !== 'string' || manifest.action_id.length === 0) {
    return 'manifest action_id must be a non-empty string';
  }
  if (typeof manifest.key !== 'string' || !HEX_KEY.test(manifest.key)) {
    return 'manifest key must be 64 lowercase hex characters';
  }
  if (typeof manifest.dependency_run_key !== 'string' || !HEX_KEY.test(manifest.dependency_run_key)) {
    return 'manifest dependency_run_key must be 64 lowercase hex characters';
  }
  if (!isPlainObject(manifest.command)) return 'manifest command must be an object';
  if (typeof manifest.command.kind !== 'string') return 'manifest command must carry a string kind';
  // A stored command is already normalized, so re-normalizing is idempotent for
  // a genuine manifest and rejects an unknown kind or a malformed command shape
  // as a schema failure (rather than letting it hash to a bogus address).
  try {
    normalizeCommand(manifest.command);
  } catch (error) {
    return `manifest command is not valid: ${error.message}`;
  }

  if (!Array.isArray(manifest.inputs)) return 'manifest inputs must be an array';
  for (const input of manifest.inputs) {
    if (!isPlainObject(input)) return 'manifest inputs must be objects';
    for (const field of Object.keys(input)) {
      if (!INPUT_FIELDS.includes(field)) return `manifest input contains an unknown field: ${field}`;
    }
    if (input.kind !== 'file' && input.kind !== 'hash') {
      return 'manifest input kind must be "file" or "hash"';
    }
    if (typeof input.path !== 'string' || input.path.length === 0) {
      return 'manifest input path must be a non-empty string';
    }
    if (typeof input.digest !== 'string') return 'manifest input digest must be a string';
    const digestPattern = input.kind === 'file' ? /^sha256:[0-9a-f]{64}$/ : HEX_KEY;
    if (!digestPattern.test(input.digest)) {
      return `manifest ${input.kind} input ${input.path} carries a malformed digest`;
    }
  }

  if (!isPlainObject(manifest.env)) return 'manifest env must be an object';
  if (!Array.isArray(manifest.env.names) || !isPlainObject(manifest.env.values)) {
    return 'manifest env must carry a names array and a values object';
  }
  const envNames = manifest.env.names;
  if (new Set(envNames).size !== envNames.length) return 'manifest env names must be unique';
  for (const name of envNames) {
    if (typeof name !== 'string' || !ENV_NAME.test(name)) {
      return `manifest env names an invalid variable: ${JSON.stringify(name)}`;
    }
    if (typeof manifest.env.values[name] !== 'string') {
      return `manifest env value for ${name} must be a string`;
    }
  }
  for (const name of Object.keys(manifest.env.values)) {
    if (!envNames.includes(name)) return `manifest env value for ${name} has no matching name`;
  }

  if (!Array.isArray(manifest.dependencies)) return 'manifest dependencies must be an array';
  const dependencyActions = new Set();
  for (const dependency of manifest.dependencies) {
    if (!isPlainObject(dependency)) return 'manifest dependencies must be objects';
    const dependencyFields = ['action_id', 'key'];
    for (const field of Object.keys(dependency)) {
      if (!dependencyFields.includes(field)) return `manifest dependency contains an unknown field: ${field}`;
    }
    if (typeof dependency.action_id !== 'string' || dependency.action_id.length === 0) {
      return 'manifest dependency action_id must be a non-empty string';
    }
    if (dependencyActions.has(dependency.action_id)) {
      return `manifest lists dependency ${dependency.action_id} twice`;
    }
    dependencyActions.add(dependency.action_id);
    if (typeof dependency.key !== 'string' || !HEX_KEY.test(dependency.key)) {
      return `manifest dependency ${dependency.action_id} key must be 64 lowercase hex characters`;
    }
  }

  // digest and size presence is guaranteed by the required-field check above;
  // their *format* is owned by the audit's manifest_invalid_digest stage (the
  // only code that covers a malformed digest or size), so wrong types do not
  // count as a schema failure here.
  return null;
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
    for (const entry of await this.readRegistry('graphs')) {
      // Graphs persisted before resource limits existed carry no declarations.
      entry.limits ??= {};
      for (const node of entry.nodes) node.resources ??= {};
      this.graphs.set(entry.id, entry);
    }
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
    return { id: graph.id, concurrency: graph.concurrency, limits: graph.limits, nodes: graph.nodes };
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
    const limits = normalizeResourceMap(body.limits === undefined ? {} : body.limits, 'graph limits', 1);

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
      const resources = normalizeResourceMap(
        node.resources === undefined ? {} : node.resources,
        `node ${nodeId} resources`,
        0,
      );
      // Every reserved resource must be backed by a graph-level quota, and one
      // node may never ask for more than the whole graph allows.
      for (const [name, amount] of Object.entries(resources)) {
        if (!(name in limits)) {
          throw new ValidationError(`node ${nodeId} reserves resource ${name}, which has no graph limit`);
        }
        if (amount > limits[name]) {
          throw new ValidationError(
            `node ${nodeId} reserves ${amount} of ${name}, over the graph limit of ${limits[name]}`,
          );
        }
      }
      return { id: nodeId, action, needs: [...needs].sort(), resources };
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

    const entry = { id, concurrency, limits, nodes };
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

    // Resource bookkeeping for this run only; quotas never leak across graphs.
    // `reserved` is what running nodes currently hold, `peak` the high-water
    // mark, with every declared limit present from the start so an unused
    // resource reports a peak of 0.
    const reserved = {};
    const peakResources = {};
    for (const name of Object.keys(graph.limits)) {
      reserved[name] = 0;
      peakResources[name] = 0;
    }
    const fits = (resources) =>
      Object.entries(resources).every(([name, amount]) => reserved[name] + amount <= graph.limits[name]);
    const reserve = (resources) => {
      for (const [name, amount] of Object.entries(resources)) {
        reserved[name] += amount;
        peakResources[name] = Math.max(peakResources[name], reserved[name]);
      }
    };
    const release = (resources) => {
      for (const [name, amount] of Object.entries(resources)) reserved[name] -= amount;
    };

    const results = [];
    while (results.length < graph.nodes.length) {
      // Deterministic dispatch order: lexicographic by node id. A candidate
      // starts only when the concurrency budget and every resource it reserves
      // fit; one that does not fit is skipped for now, so a resource-hungry
      // candidate never blocks later ready nodes. Concurrency remains the only
      // source of timing freedom and never changes an artifact.
      for (const id of readyIds()) {
        if (inFlight >= graph.concurrency) break;
        const entry = state.get(id);
        if (!fits(entry.node.resources)) continue;
        entry.status = 'running';
        reserve(entry.node.resources);
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
            release(entry.node.resources);
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
        resources: { ...result.resources },
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
      resource_limits: { ...graph.limits },
      peak_resources: { ...peakResources },
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
      resource_limits: { ...graph.limits },
      peak_resources: { ...peakResources },
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
        resources: node.resources,
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
      resources: node.resources,
    };
  }

  // ---------------------------------------------------------------- verify

  // Reproducible-build verification against the most recent successful run.
  // Unlike runGraph({use_cache:false}) this path is strictly read-only: it
  // never writes a blob or manifest, never moves last_run or idempotency
  // records, never bumps a counter, and never touches the workspace. Each node
  // key from the reference run locates a manifest and its blob, the manifest is
  // address-checked (its frozen fields must recompute to the node key) and the
  // blob digest-checked, then the frozen command is re-executed in memory and
  // its digest and size are compared with what the cache holds.
  async verifyGraph(graphId) {
    await this.loading;
    const graph = this.graphs.get(graphId);
    if (!graph) throw new NotFoundError(`graph ${graphId} is not registered`);
    // A run record exists only for a run that completed every node, so this is
    // exactly "the graph has one successful run".
    const reference = this.runs.get(graphId);
    if (!reference) {
      throw new VerificationUnavailableError(
        `graph ${graphId} has no successful run to verify; run it before verifying`,
      );
    }

    // Each distinct node key is located and re-executed once; two nodes that
    // share one key (identical definitions) still each get their own verified
    // entry afterwards.
    const reexecuted = new Map();
    const unavailable = (nodeId, reason) => {
      throw new VerificationUnavailableError(
        `verification of graph ${graphId} is unavailable for node ${nodeId}: ${reason}`,
      );
    };

    for (const node of reference.nodes) {
      if (reexecuted.has(node.key)) continue;
      let entry;
      try {
        entry = await this.store.readArtifact(node.key);
      } catch (error) {
        if (error instanceof NotFoundError || error instanceof ValidationError) {
          unavailable(node.id, error.message);
        }
        throw error;
      }
      const { manifest, buffer } = entry;

      // The run record and the manifest must describe the same artifact.
      if (manifest.digest !== node.digest || manifest.size !== node.size) {
        unavailable(
          node.id,
          `the cache manifest for key ${node.key} does not describe the artifact recorded by run ${reference.run_key}`,
        );
      }

      // Address validation: the frozen command, inputs, environment and
      // dependency node keys must recompute to exactly the node key that named
      // this manifest, and the stored bytes must be the bytes it names.
      const recomputedKey = nodeKeyOf(
        actionKey({ command: manifest.command, inputs: manifest.inputs, env: manifest.env }),
        manifest.dependencies.map((dependency) => dependency.key),
      );
      if (recomputedKey !== manifest.key) {
        unavailable(node.id, `cache manifest for key ${node.key} fails address validation`);
      }
      if (digestOf(buffer) !== manifest.digest) {
        unavailable(node.id, `cache blob for key ${node.key} fails digest validation`);
      }

      let recomputed;
      try {
        recomputed = await executeArtifact({
          command: manifest.command,
          inputs: manifest.inputs,
          env: manifest.env,
          dependencies: manifest.dependencies,
          workspace: this.workspace,
        });
      } catch (error) {
        if (error instanceof CachelatticeError) unavailable(node.id, error.message);
        throw error;
      }
      reexecuted.set(node.key, { digest: digestOf(recomputed), size: recomputed.length });
    }

    const mismatches = [];
    const verified = [];
    for (const node of reference.nodes) {
      const expected = { digest: node.digest, size: node.size };
      const actual = reexecuted.get(node.key);
      if (actual.digest !== expected.digest || actual.size !== expected.size) {
        mismatches.push({
          node_id: node.id,
          expected_digest: expected.digest,
          expected_size: expected.size,
          actual_digest: actual.digest,
          actual_size: actual.size,
        });
      } else {
        verified.push({ node_id: node.id, key: node.key, digest: expected.digest, size: expected.size });
      }
    }
    verified.sort(byNodeId);
    mismatches.sort(byNodeId);

    if (mismatches.length > 0) throw new ReproducibilityMismatchError(mismatches);

    return {
      schema: VERIFY_SCHEMA,
      graph_id: graphId,
      reference_run_key: reference.run_key,
      verified,
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

  // --------------------------------------------------------------------- gc

  // Cache retention. The keep set is the node keys of every registered graph's
  // last run plus whatever the caller asked to keep; a graph that never ran
  // contributes nothing. Every manifest is scanned and validated first, so a
  // corrupt store fails the whole request before a single object is deleted.
  // Everything outside the keep set is collected: the manifests, the blobs only
  // they referenced, and orphan blobs. A dry run reports the exact same sets
  // and byte counts without deleting anything.
  async gc(request = {}) {
    await this.loading;
    if (!isPlainObject(request)) throw new ValidationError('gc request must be a JSON object');
    rejectUnknown(request, ['keep', 'dry_run'], 'gc request');
    const dryRun = request.dry_run === undefined ? false : request.dry_run;
    if (typeof dryRun !== 'boolean') throw new ValidationError('gc dry_run must be a boolean');
    const keepRequested = new Set();
    if (request.keep !== undefined) {
      if (!Array.isArray(request.keep)) throw new ValidationError('gc keep must be an array of cache keys');
      for (const key of request.keep) keepRequested.add(assertCacheKey(key));
    }

    const keep = new Set(keepRequested);
    for (const run of this.runs.values()) {
      for (const node of run.nodes) keep.add(node.key);
    }

    // Validate before anything is deleted: an unreadable manifest, a key
    // mismatch, a missing or dishonest digest, or a missing or tampered blob
    // fails the request and leaves the store untouched.
    const keys = await this.store.listKeys(Number.MAX_SAFE_INTEGER);
    const manifests = new Map();
    for (const key of keys) {
      const manifest = await this.store.readManifest(key);
      const digest = assertDigest(manifest.digest, `cache manifest for key ${key} digest`);
      const hexDigest = digest.slice('sha256:'.length);
      let buffer;
      try {
        buffer = await readFile(this.store.blobPath(hexDigest));
      } catch (error) {
        if (error.code === 'ENOENT') {
          throw new ValidationError(
            `cache manifest for key ${key} references a blob that is missing from the object store`,
          );
        }
        throw error;
      }
      if (digestOf(buffer) !== digest) {
        throw new ValidationError(`blob referenced by cache manifest for key ${key} does not match its digest`);
      }
      manifests.set(key, hexDigest);
    }

    for (const key of keepRequested) {
      if (!manifests.has(key)) throw new NotFoundError(`keep key ${key} does not name a cache entry`);
    }

    const keptKeys = keys.filter((key) => keep.has(key));
    const removedKeys = keys.filter((key) => !keep.has(key));
    const keptDigests = new Set(keptKeys.map((key) => manifests.get(key)));

    const blobSizes = new Map();
    for (const hexDigest of await this.store.listBlobDigests()) {
      blobSizes.set(hexDigest, (await stat(this.store.blobPath(hexDigest))).size);
    }
    let keptBytes = 0;
    for (const hexDigest of keptDigests) keptBytes += blobSizes.get(hexDigest);
    const removedDigests = [...blobSizes.keys()].filter((hexDigest) => !keptDigests.has(hexDigest));
    let removedBytes = 0;
    for (const hexDigest of removedDigests) removedBytes += blobSizes.get(hexDigest);

    if (!dryRun) {
      for (const key of removedKeys) await this.store.deleteManifest(key);
      for (const hexDigest of removedDigests) await this.store.deleteBlob(hexDigest);
    }

    return {
      dry_run: dryRun,
      kept_keys: keptKeys,
      removed_keys: removedKeys,
      removed_digests: removedDigests.map((hexDigest) => `sha256:${hexDigest}`),
      kept_bytes: keptBytes,
      removed_bytes: removedBytes,
    };
  }

  // ------------------------------------------------------------------- audit

  // Whole-store, strictly read-only inspection. Unlike gc it never aborts on a
  // corrupt object: every managed object is examined independently and every
  // defect becomes an entry in `issues`. It walks blobs/sha256 and manifests
  // without a limit, and writes nothing - no blob, manifest, meta entry,
  // idempotency record, statistic or workspace file changes.
  async audit() {
    await this.loading;
    const issues = [];
    const addIssue = (code, file, message, identity = {}) => {
      const issue = { code, path: file.rel, message };
      if (identity.key !== undefined) issue.key = identity.key;
      if (identity.digest !== undefined) issue.digest = identity.digest;
      issues.push(issue);
    };

    // ---- manifests ---------------------------------------------------------
    let manifestCount = 0;
    // Blob digests named by a manifest that got far enough to be a real cache
    // entry (valid location, JSON, schema, key and address, and a well-formed
    // digest). Such a blob is *referenced* even when the bytes themselves are
    // missing or tampered, so a corrupt blob is reported once instead of being
    // mislabeled an orphan as well.
    const resolvedReferences = new Set();
    // Subset whose blob exists and whose digest and size check out: only these
    // feed referenced_bytes. An unresolvable reference is never healthy.
    const healthyReferences = new Set();

    for (const file of await this.store.listManifestFiles()) {
      const key = file.key;
      if (key === null) {
        // A strange file or a misplaced object is not recognized as a manifest,
        // so it does not contribute to manifest_count.
        addIssue(
          'unexpected_object',
          file,
          'file is not a managed manifest (expected manifests/<2-hex>/<64-hex>.json with a matching prefix)',
        );
        continue;
      }
      manifestCount += 1;

      let text;
      try {
        text = await readFile(file.absolute, 'utf8');
      } catch (error) {
        addIssue('unexpected_object', file, `manifest could not be read: ${error.message}`, { key });
        continue;
      }
      let manifest;
      try {
        manifest = JSON.parse(text);
      } catch {
        addIssue('manifest_invalid_json', file, 'manifest is not valid JSON', { key });
        continue;
      }

      const schemaError = validateManifestSchema(manifest);
      if (schemaError) {
        addIssue('manifest_invalid_schema', file, schemaError, {
          key: typeof manifest?.key === 'string' ? manifest.key : key,
        });
        continue;
      }
      if (manifest.key !== key) {
        addIssue('manifest_key_mismatch', file, `manifest key ${manifest.key} does not match its storage path (key ${key})`, {
          key: manifest.key,
        });
        continue;
      }

      // Recompute the action key from command, inputs and environment, and the
      // node key by folding in the dependency node keys; both must equal the
      // manifest key. An unresolvable reference (an unnormalizable command,
      // input or dependency) makes the address unverifiable and is never a
      // healthy reference.
      let address;
      try {
        address = nodeKeyOf(
          actionKey({ command: manifest.command, inputs: manifest.inputs, env: manifest.env }),
          manifest.dependencies.map((dependency) => dependency.key),
        );
      } catch {
        address = null;
      }
      if (address !== key) {
        addIssue(
          'manifest_address_mismatch',
          file,
          'manifest command, inputs, environment and dependencies do not recompute to its key',
          { key },
        );
        continue;
      }

      // The digest must be well formed before it can name a referenced blob.
      const declaredDigest = manifest.digest;
      let hexDigest;
      try {
        hexDigest = assertDigest(declaredDigest, 'manifest digest').slice('sha256:'.length);
      } catch {
        addIssue('manifest_invalid_digest', file, `manifest digest is not valid: ${String(declaredDigest)}`, { key });
        continue;
      }
      // From here the reference is resolvable: the named blob is referenced
      // and must not be classified as an orphan even if the bytes are bad.
      resolvedReferences.add(hexDigest);

      if (!Number.isInteger(manifest.size) || manifest.size < 0) {
        addIssue(
          'manifest_invalid_digest',
          file,
          `manifest size must be a non-negative integer, received ${JSON.stringify(manifest.size)}`,
          { key, digest: declaredDigest },
        );
        continue;
      }

      const blobFile = this.store.blobPath(hexDigest);
      let buffer;
      try {
        buffer = await readFile(blobFile);
      } catch (error) {
        if (error.code === 'ENOENT') {
          addIssue('blob_missing', file, `manifest references blob sha256:${hexDigest}, which is absent`, {
            key,
            digest: declaredDigest,
          });
        } else {
          addIssue('blob_missing', file, `referenced blob could not be read: ${error.message}`, {
            key,
            digest: declaredDigest,
          });
        }
        continue;
      }
      const actualDigest = digestOf(buffer);
      if (actualDigest !== declaredDigest) {
        addIssue(
          'blob_digest_mismatch',
          file,
          `referenced blob has digest ${actualDigest} but the manifest declares ${declaredDigest}`,
          { key, digest: declaredDigest },
        );
        continue;
      }
      if (buffer.length !== manifest.size) {
        addIssue(
          'blob_size_mismatch',
          file,
          `referenced blob is ${buffer.length} bytes but the manifest declares ${manifest.size}`,
          { key, digest: declaredDigest },
        );
        continue;
      }

      // Address, digest and size all check out: this is the only kind of
      // reference that counts toward referenced_bytes.
      healthyReferences.add(hexDigest);
    }

    // ---- blobs -------------------------------------------------------------
    let blobCount = 0;
    const blobFiles = new Map();
    for (const file of await this.store.listBlobFiles()) {
      if (file.digest === null) {
        // Not named like a managed blob: classified, not counted.
        addIssue(
          'unexpected_object',
          file,
          'file is not a managed blob (expected blobs/sha256/<2-hex>/<64-hex> with a matching prefix)',
        );
        continue;
      }
      blobCount += 1;
      blobFiles.set(file.digest, file);
    }

    // Healthy blob sizes, de-duplicated by digest.
    let referencedBytes = 0;
    for (const hexDigest of healthyReferences) {
      referencedBytes += (await stat(blobFiles.get(hexDigest).absolute)).size;
    }

    // A blob with no resolvable reference is an orphan, regardless of whether
    // its own bytes happen to hash to its name; a referenced-but-bad blob is
    // already reported against its manifest above.
    let orphanBytes = 0;
    const orphanDigests = [...blobFiles.keys()]
      .filter((hexDigest) => !resolvedReferences.has(hexDigest))
      .sort();
    for (const hexDigest of orphanDigests) {
      const file = blobFiles.get(hexDigest);
      const declared = `sha256:${hexDigest}`;
      orphanBytes += (await stat(file.absolute)).size;
      addIssue('orphan_blob', file, 'blob is not referenced by any valid manifest', { digest: declared });
    }

    // path first, then code, for a stable and diffable report.
    issues.sort((left, right) =>
      left.path < right.path
        ? -1
        : left.path > right.path
          ? 1
          : left.code < right.code
            ? -1
            : left.code > right.code
              ? 1
              : 0,
    );

    return {
      schema: AUDIT_SCHEMA,
      healthy: issues.length === 0,
      manifest_count: manifestCount,
      blob_count: blobCount,
      referenced_bytes: referencedBytes,
      orphan_bytes: orphanBytes,
      issues,
    };
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
