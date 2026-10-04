import { existsSync, mkdirSync } from 'node:fs';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { canonicalJson, digestOf } from './canonical.js';
import { NotFoundError, ValidationError } from './errors.js';

const HEX = /^[0-9a-f]{64}$/;
const HEX_PREFIX = /^[0-9a-f]{2}$/;

function assertHex(value, label) {
  if (typeof value !== 'string' || !HEX.test(value)) {
    throw new ValidationError(`${label} must be 64 lowercase hex characters`);
  }
  return value;
}

// Content-addressed object store. Every byte written lands under the digest of
// those exact bytes, so the same content can never occupy two paths and an
// existing object is never overwritten with different content.
//
//   <root>/blobs/sha256/<d0d1>/<digest-hex>      artifact bytes
//   <root>/manifests/<k0k1>/<key>.json           node key -> artifact manifest
//   <root>/meta/idempotency/<o0o1>/<hex>.json    idempotent response replay
//   <root>/meta/stats.json                       lifetime counters
//   <root>/meta/actions/<action-id>.json         registered action
//   <root>/meta/graphs/<graph-id>.json           registered graph
//   <root>/meta/graphs/<graph-id>.last-run.json  last materialized run
export class ObjectStore {
  constructor(root) {
    this.root = path.resolve(root);
    this.blobRoot = path.join(this.root, 'blobs', 'sha256');
    this.manifestRoot = path.join(this.root, 'manifests');
    this.metaRoot = path.join(this.root, 'meta');
    for (const directory of [this.blobRoot, this.manifestRoot, this.metaRoot]) {
      mkdirSync(directory, { recursive: true });
    }
  }

  blobPath(digest) {
    assertHex(digest, 'digest');
    return path.join(this.blobRoot, digest.slice(0, 2), digest);
  }

  manifestPath(key) {
    assertHex(key, 'action key');
    return path.join(this.manifestRoot, key.slice(0, 2), `${key}.json`);
  }

  metaPath(...parts) {
    return path.join(this.metaRoot, ...parts);
  }

  hasBlob(digest) {
    return existsSync(this.blobPath(digest));
  }

  hasManifest(key) {
    return existsSync(this.manifestPath(key));
  }

  async writeBlob(buffer) {
    const digest = digestOf(buffer).slice('sha256:'.length);
    const target = this.blobPath(digest);
    await mkdir(path.dirname(target), { recursive: true });
    if (!existsSync(target)) {
      const temporary = `${target}.tmp-${process.pid}`;
      await writeFile(temporary, buffer);
      await rename(temporary, target);
    }
    return digest;
  }

  // Returns the exact bytes stored for a node key, or throws when the manifest or
  // the blob behind it is gone.
  async readArtifact(nodeKey) {
    const key = assertHex(nodeKey, 'action key');
    const manifest = await this.readManifest(key);
    const file = this.blobPath(manifest.digest.slice('sha256:'.length));
    let buffer;
    try {
      buffer = await readFile(file);
    } catch (error) {
      if (error.code === 'ENOENT') {
        throw new NotFoundError(`artifact for key ${key} is missing from the object store`);
      }
      throw error;
    }
    const actual = digestOf(buffer);
    if (actual !== manifest.digest) {
      throw new ValidationError(`artifact for key ${key} does not match its manifest digest`);
    }
    return { manifest, buffer };
  }

  async writeManifest(nodeKey, manifest) {
    const target = this.manifestPath(nodeKey);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, `${canonicalJson(manifest)}\n`);
    return manifest;
  }

  async readManifest(nodeKey) {
    const key = assertHex(nodeKey, 'action key');
    let text;
    try {
      text = await readFile(this.manifestPath(key), 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') {
        throw new NotFoundError(`no cache entry exists for key ${key}`);
      }
      throw error;
    }
    let manifest;
    try {
      manifest = JSON.parse(text);
    } catch {
      throw new ValidationError(`cache manifest for key ${key} is not valid JSON`);
    }
    if (manifest === null || typeof manifest !== 'object' || manifest.key !== key) {
      throw new ValidationError(`cache manifest stored for key ${key} claims a different key`);
    }
    return manifest;
  }

  async listKeys(limit = 200) {
    const keys = [];
    let prefixes;
    try {
      prefixes = await readdir(this.manifestRoot, { withFileTypes: true });
    } catch (error) {
      if (error.code === 'ENOENT') return keys;
      throw error;
    }
    for (const prefix of prefixes.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort()) {
      const files = await readdir(path.join(this.manifestRoot, prefix));
      for (const file of files.sort()) {
        if (file.endsWith('.json')) keys.push(file.slice(0, -'.json'.length));
        if (keys.length >= limit) return keys;
      }
    }
    return keys;
  }

  // Every blob digest on disk, sorted. A file not named by a 64-digit lowercase
  // hex digest is not a cache object and is left alone.
  async listBlobDigests() {
    const digests = [];
    for (const blob of await this.listBlobFiles()) {
      if (blob.digest !== null) digests.push(blob.digest);
    }
    return digests;
  }

  // Recursively collects every regular file below `directory`, as a POSIX
  // path relative to that directory. Directories of any depth are followed so
  // that misplaced objects and strange files cannot hide outside the expected
  // two-level layout; there is no result limit.
  async collectRelativeFiles(directory, prefix = '') {
    const files = [];
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error.code === 'ENOENT') return files;
      throw error;
    }
    entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
    for (const entry of entries) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        for (const nested of await this.collectRelativeFiles(absolute, rel)) files.push(nested);
      } else {
        // Every non-directory entry is reported; anything that is not named
        // like a managed object is classified as an unexpected object by the
        // caller, so a stray symlink cannot hide from the audit.
        files.push(rel);
      }
    }
    return files;
  }

  // Classifies every file below manifests/: a managed manifest must sit at
  // <2-hex>/<64-hex>.json and its prefix must match its key. Anything else
  // (strange files, wrongly named prefixes, misplaced or malformed names) is
  // reported with key === null so the audit can call it an unexpected object.
  async listManifestFiles() {
    const out = [];
    for (const rel of await this.collectRelativeFiles(this.manifestRoot)) {
      const parts = rel.split('/');
      let key = null;
      if (parts.length === 2 && HEX_PREFIX.test(parts[0]) && parts[1].endsWith('.json')) {
        const candidate = parts[1].slice(0, -'.json'.length);
        if (HEX.test(candidate) && candidate.startsWith(parts[0])) key = candidate;
      }
      out.push({ key, rel: `manifests/${rel}`, absolute: path.join(this.manifestRoot, rel) });
    }
    return out;
  }

  // Classifies every file below blobs/sha256/: a managed blob must sit at
  // <2-hex>/<64-hex> with the prefix equal to the first two digits of the
  // digest naming it.
  async listBlobFiles() {
    const out = [];
    for (const rel of await this.collectRelativeFiles(this.blobRoot)) {
      const parts = rel.split('/');
      let digest = null;
      if (parts.length === 2 && HEX_PREFIX.test(parts[0]) && HEX.test(parts[1]) && parts[1].startsWith(parts[0])) {
        digest = parts[1];
      }
      out.push({ digest, rel: `blobs/sha256/${rel}`, absolute: path.join(this.blobRoot, rel) });
    }
    return out;
  }

  async deleteManifest(key) {
    await rm(this.manifestPath(key), { force: true });
  }

  async deleteBlob(digest) {
    await rm(this.blobPath(digest), { force: true });
  }

  async writeMeta(name, value) {
    const target = this.metaPath(name);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, `${canonicalJson(value)}\n`);
    return value;
  }

  async readMeta(name) {
    try {
      return JSON.parse(await readFile(this.metaPath(name), 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }

  async deleteMeta(name) {
    await rm(this.metaPath(name), { force: true });
  }
}
