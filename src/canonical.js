import { createHash } from 'node:crypto';
import { ValidationError } from './errors.js';

// Renders a JSON value with object keys sorted by code unit and no insignificant
// whitespace. Two values have the same canonical form if and only if they carry
// the same information in the same order, which is what makes every hash in this
// repository reproducible across runs and processes.
export function canonicalJson(value) {
  return render(value, new Set());
}

function render(value, seen) {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new ValidationError('numbers in hashed content must be finite');
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new ValidationError('hashed content must not contain cycles');
    seen.add(value);
    const body = value.map((item) => render(item, seen));
    seen.delete(value);
    return `[${body.join(',')}]`;
  }
  if (typeof value === 'object') {
    if (seen.has(value)) throw new ValidationError('hashed content must not contain cycles');
    seen.add(value);
    const keys = Object.keys(value).sort();
    const body = keys.map((key) => `${JSON.stringify(key)}:${render(value[key], seen)}`);
    seen.delete(value);
    return `{${body.join(',')}}`;
  }
  throw new ValidationError(`hashed content must not contain ${typeof value}`);
}

// Encoding form of a hash: "<algorithm>:<lowercase hex>".
export function sha256Bytes(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

export function sha256Text(text) {
  return sha256Bytes(Buffer.from(text, 'utf8'));
}

export function digestOf(buffer) {
  return `sha256:${sha256Bytes(buffer)}`;
}

export function digestOfValue(value) {
  return digestOf(Buffer.from(canonicalJson(value), 'utf8'));
}

export function assertDigest(value, label) {
  if (typeof value !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(value)) {
    throw new ValidationError(`${label} must look like "sha256:<64 lowercase hex characters>"`);
  }
  return value;
}

// Namespaced short identifier: printable, deterministic, and collision-resistant
// enough for the registries in this service.
export function shortId(namespace, payload) {
  return `${namespace}-${sha256Text(payload).slice(0, 12)}`;
}
