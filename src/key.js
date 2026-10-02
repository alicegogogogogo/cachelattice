import path from 'node:path';

import { assertDigest, canonicalJson, sha256Text } from './canonical.js';
import { ValidationError } from './errors.js';

export const KEY_SCHEMA = 'cachelattice/action-key/v1';

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const HASH = /^[0-9a-f]{64}$/;

// Hash inputs reference another action by its action key, which is plain
// lowercase hex - no algorithm prefix, so that a key can be pasted straight out
// of a cache response into the next action's input list.
export function assertHash(value, label) {
  if (typeof value !== 'string' || !HASH.test(value)) {
    throw new ValidationError(`${label} must be 64 lowercase hex characters, received ${JSON.stringify(value)}`);
  }
  return value;
}

export function assertName(value, label) {
  if (typeof value !== 'string' || !NAME.test(value)) {
    throw new ValidationError(
      `${label} must match [A-Za-z0-9][A-Za-z0-9._-]{0,63}`,
    );
  }
  return value;
}

// Workspace-relative paths are normalized once, before anything else looks at
// them, so that "./a/b.txt", "a/./b.txt" and "a/b.txt" are one and the same
// input everywhere: in the key, in the file access, and in the error messages.
export function normalizePath(value, label = 'path') {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ValidationError(`${label} must be a non-empty string`);
  }
  if (value.includes('\0')) throw new ValidationError(`${label} must not contain NUL`);
  const candidate = value.split('\\').join('/');
  if (candidate.startsWith('/') || /^[A-Za-z]:/.test(candidate)) {
    throw new ValidationError(`${label} must be relative to the workspace: ${value}`);
  }
  const normalized = path.posix.normalize(candidate);
  if (normalized === '.' || normalized === '..' || normalized.startsWith('../')) {
    throw new ValidationError(`${label} must stay inside the workspace: ${value}`);
  }
  return normalized;
}

export function normalizeInputs(inputs) {
  const seen = new Set();
  const normalized = inputs.map((input) => {
    const file = normalizePath(input.path, 'input path');
    if (seen.has(file)) throw new ValidationError(`input path is listed twice: ${file}`);
    seen.add(file);
    if (input.kind === 'file') return { kind: 'file', path: file };
    return { kind: 'hash', path: file, digest: assertHash(input.digest, 'input hash') };
  });
  return normalized.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
}

// The same normalizer serves cache uploads, where file inputs do carry a digest
// because no workspace is involved.
export function normalizeCacheInputs(inputs) {
  const seen = new Set();
  const normalized = inputs.map((input) => {
    const file = normalizePath(input.path, 'input path');
    if (seen.has(file)) throw new ValidationError(`input path is listed twice: ${file}`);
    seen.add(file);
    if (input.kind === 'file' && !('digest' in input)) {
      throw new ValidationError('a cache entry must carry the digest of every input');
    }
    return {
      kind: input.kind,
      path: file,
      digest: input.kind === 'hash'
        ? assertHash(input.digest, 'input hash')
        : assertDigest(input.digest, 'input digest'),
    };
  });
  return normalized.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
}

// The environment is an allow-listed projection, never the ambient process
// environment: only the named variables are read, and the recorded names are
// sorted so that the declaration order cannot leak into the key.
export function normalizeEnv(env, ambient) {
  const names = env.map((name) => {
    if (typeof name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw new ValidationError(`environment variable name is invalid: ${JSON.stringify(name)}`);
    }
    return name;
  });
  if (new Set(names).size !== names.length) {
    throw new ValidationError('environment variable names must be unique');
  }
  const unique = [...new Set(names)].sort();
  const values = {};
  for (const name of unique) {
    if (typeof ambient[name] !== 'string') {
      throw new ValidationError(`environment variable ${name} is not set in the service environment`);
    }
    values[name] = ambient[name];
  }
  return { names: unique, values };
}

// dependencies is [{ action_id, key }]; sorting by action_id keeps the parent
// key insensitive to the order in which the graph declared its edges.
export function normalizeDependencies(dependencies) {
  const seen = new Set();
  const normalized = dependencies.map((dependency) => {
    const actionId = assertName(dependency.action_id, 'dependency action id');
    if (seen.has(actionId)) {
      throw new ValidationError(`dependency ${actionId} is listed twice`);
    }
    seen.add(actionId);
    return { action_id: actionId, key: assertDigest(dependency.key, 'dependency key') };
  });
  return normalized.sort((left, right) =>
    left.action_id < right.action_id ? -1 : left.action_id > right.action_id ? 1 : 0,
  );
}

// The action key is the hex SHA-256 of the canonical serialization below. Every
// field of this object is part of the identity of the action; nothing else is.
// Input order, env declaration order and object key order are removed by
// normalizeInputs/normalizeEnv and by canonicalJson, so only content matters.
export function actionKey({ command, inputs, env }) {
  const material = {
    schema: KEY_SCHEMA,
    command,
    inputs: inputs.map((input) =>
      input.kind === 'file'
        ? { digest: input.digest, kind: 'file', path: input.path }
        : { digest: input.digest, kind: 'hash', path: input.path },
    ),
    env: { names: [...env.names], values: { ...env.values } },
  };
  return sha256Text(canonicalJson(material));
}

export function runKey(nodes) {
  const material = {
    schema: 'cachelattice/run-key/v1',
    nodes: nodes
      .map((node) => ({ action_id: node.action_id, key: node.key }))
      .sort((left, right) =>
        left.action_id < right.action_id ? -1 : left.action_id > right.action_id ? 1 : 0,
      ),
  };
  return sha256Text(canonicalJson(material));
}

export function actionIdOf(name) {
  return `${name}-${sha256Text(`cachelattice/action-id/v1\n${name}`).slice(0, 12)}`;
}
