import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { canonicalJson } from './canonical.js';
import { ExecutionError, ValidationError } from './errors.js';
import { normalizePath } from './key.js';

// Every command is a pure function of bytes that are already addressed by the
// action key. That is the whole reason a cache hit and a cache miss can be
// guaranteed to emit the same artifact: the miss path recomputes the same
// function from the same bytes, and the hit path reuses the bytes the miss path
// stored.
export const COMMAND_KINDS = [
  'copy-file',
  'write-file',
  'concat-text',
  'substitute-text',
  'filter-lines',
  'template-hash',
];

export function normalizeCommand(command) {
  const kind = command.kind;
  if (!COMMAND_KINDS.includes(kind)) {
    throw new ValidationError(`command kind must be one of ${COMMAND_KINDS.join(', ')}`);
  }
  const normalized = { kind };
  if (kind === 'copy-file') {
    normalized.source = String(command.source);
  } else if (kind === 'write-file') {
    normalized.content = String(command.content);
  } else if (kind === 'concat-text') {
    assertArray(command.sources, 'command sources');
    normalized.sources = command.sources.map((value) => String(value));
    normalized.separator = typeof command.separator === 'string' ? command.separator : '\n';
  } else if (kind === 'substitute-text') {
    normalized.source = String(command.source);
    assertArray(command.replacements, 'command replacements');
    if (command.replacements.length === 0) {
      throw new ValidationError('command replacements must not be empty');
    }
    normalized.replacements = command.replacements
      .map((replacement) => {
        if (typeof replacement.find !== 'string' || replacement.find.length === 0) {
          throw new ValidationError('replacement find must be a non-empty string');
        }
        if (typeof replacement.replace !== 'string') {
          throw new ValidationError('replacement replace must be a string');
        }
        return { find: replacement.find, replace: replacement.replace };
      })
      // Sorted so that the order in which replacements were declared cannot
      // change the key, and so that "aa"->"b" then "b"->"c" is always applied
      // in the same sequence.
      .sort((left, right) => (left.find < right.find ? -1 : left.find > right.find ? 1 : 0));
  } else if (kind === 'filter-lines') {
    normalized.source = String(command.source);
    if (typeof command.pattern !== 'string') {
      throw new ValidationError('command pattern must be a string');
    }
    try {
      new RegExp(command.pattern);
    } catch (error) {
      throw new ValidationError(`command pattern is not a valid regular expression: ${error.message}`);
    }
    normalized.pattern = command.pattern;
    normalized.match = command.match === 'drop' ? 'drop' : 'keep';
    normalized.keep_final_newline = command.keep_final_newline !== false;
  } else if (kind === 'template-hash') {
    assertArray(command.fields, 'command fields');
    const fields = command.fields.map((field) => {
      if (typeof field !== 'string' || field.length === 0) {
        throw new ValidationError('command fields must be non-empty strings');
      }
      return field;
    });
    const unique = [...new Set(fields)].sort();
    if (unique.length !== fields.length) {
      throw new ValidationError('command fields must be unique');
    }
    normalized.fields = unique;
  }
  // Every workspace path inside a command is normalized here, with the same
  // rules as action inputs, so that "./src/a.txt" and "src/a.txt" can never be
  // two different keys for the same read.
  if ('source' in normalized) {
    normalized.source = normalizePath(normalized.source, 'command source');
  }
  if (normalized.kind === 'concat-text') {
    normalized.sources = normalized.sources.map((value) => normalizePath(value, 'command source'));
  }
  return normalized;
}

function assertArray(value, label) {
  if (!Array.isArray(value)) throw new ValidationError(`${label} must be an array`);
}

function utf8(text) {
  if (typeof text !== 'string') {
    throw new ExecutionError('prepared input is not UTF-8 decodable text');
  }
  return text;
}

// Workspace-relative source references inside a command. They are normalized
// with the same rules as action inputs so that a command and the input list can
// never disagree about what "a/../b.txt" names.
export function commandSources(command) {
  if (command.kind === 'copy-file' || command.kind === 'substitute-text' || command.kind === 'filter-lines') {
    return [command.source];
  }
  if (command.kind === 'concat-text') return [...command.sources];
  return [];
}

export async function executeArtifact({ command: requested, inputs, env, dependencies, workspace }) {
  // The executor is the authority on command semantics: it normalizes whatever
  // it is handed, so a caller that skipped normalization still gets the same
  // bytes as one that did not.
  const command = normalizeCommand(requested);
  const local = new Map(inputs.map((input) => [input.path, input]));
  const readSource = async (relative) => {
    const localInput = local.get(relative);
    if (localInput && localInput.kind === 'hash') {
      throw new ExecutionError(
        `command reads ${relative} as a file but the action declares it as a precomputed hash`,
      );
    }
    const absolute = path.join(workspace, relative);
    if (absolute !== workspace && !absolute.startsWith(workspace + path.sep)) {
      throw new ExecutionError(`path escapes the workspace: ${relative}`);
    }
    try {
      return await readFile(absolute);
    } catch (error) {
      if (error.code === 'ENOENT') {
        throw new ExecutionError(`input file is missing from the workspace: ${relative}`);
      }
      if (error.code === 'EISDIR') {
        throw new ExecutionError(`input path is a directory: ${relative}`);
      }
      throw error;
    }
  };

  if (command.kind === 'copy-file') {
    return readSource(command.source);
  }
  if (command.kind === 'write-file') {
    return Buffer.from(command.content, 'utf8');
  }
  if (command.kind === 'concat-text') {
    const pieces = [];
    for (const source of command.sources) pieces.push(utf8((await readSource(source)).toString('utf8')));
    return Buffer.from(pieces.join(command.separator), 'utf8');
  }
  if (command.kind === 'substitute-text') {
    let text = utf8((await readSource(command.source)).toString('utf8'));
    for (const replacement of command.replacements) {
      text = text.split(replacement.find).join(replacement.replace);
    }
    return Buffer.from(text, 'utf8');
  }
  if (command.kind === 'filter-lines') {
    const text = utf8((await readSource(command.source)).toString('utf8'));
    const expression = new RegExp(command.pattern);
    // split() yields a trailing empty element for a trailing newline; dropping it
    // means the joined body carries no trailing newline, which keeps
    // keep_final_newline a genuine choice rather than a no-op.
    const lines = text.split('\n');
    if (lines.length > 1 && lines.at(-1) === '') lines.pop();
    const body = lines
      .filter((line) => expression.test(line) === (command.match === 'keep'))
      .join('\n');
    return Buffer.from(command.keep_final_newline && body.length > 0 ? `${body}\n` : body, 'utf8');
  }
  if (command.kind === 'template-hash') {
    const fields = {};
    for (const field of command.fields) {
      if (!(field in env.values)) {
        throw new ExecutionError(`template field ${field} is not a whitelisted environment variable`);
      }
      fields[field] = env.values[field];
    }
    const payload = {
      schema: 'cachelattice/template-hash/v1',
      fields,
      inputs: inputs.map((input) => ({ path: input.path, digest: input.digest })),
      dependencies: dependencies.map((dependency) => ({
        action_id: dependency.action_id,
        key: dependency.key,
      })),
    };
    return Buffer.from(`${canonicalJson(payload)}\n`, 'utf8');
  }
  throw new ValidationError(`command kind is not executable: ${command.kind}`);
}
