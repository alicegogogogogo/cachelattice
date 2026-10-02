import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { canonicalJson, digestOf } from './canonical.js';
import { CachelatticeError, ValidationError } from './errors.js';
import { Cachelattice } from './service.js';
import { start } from './server.js';

const USAGE = `Cachelattice - content-addressed build cache and dependency scheduler.

Usage:
  node src/cli.js serve [--host H] [--port P] [--data DIR] [--workspace DIR]
  node src/cli.js run --graph ID [--data DIR] [--workspace DIR] [--out FILE] [--no-cache]
  node src/cli.js stats [--data DIR] [--workspace DIR]
  node src/cli.js gc [--data DIR] [--keep KEY ...] [--dry-run]

The data directory defaults to .cachelattice and the workspace to the current
directory. The service prints "Cachelattice listening on http://<host>:<port>"
once the port is bound.
`;

function parse(argv) {
  const [command, ...rest] = argv;
  const { values } = parseArgs({
    args: rest,
    options: {
      host: { type: 'string', default: '127.0.0.1' },
      port: { type: 'string', default: '18091' },
      data: { type: 'string', default: '.cachelattice' },
      workspace: { type: 'string', default: '.' },
      graph: { type: 'string' },
      out: { type: 'string' },
      keep: { type: 'string', multiple: true },
      'dry-run': { type: 'boolean', default: false },
      cache: { type: 'boolean', default: true },
      help: { type: 'boolean', default: false, short: 'h' },
    },
    allowPositionals: false,
  });
  return { command, values };
}

async function serve(values) {
  const port = Number.parseInt(values.port, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ValidationError('--port must be an integer between 1 and 65535');
  }
  const { server } = await start({
    host: values.host,
    port,
    dataDirectory: values.data,
    workspace: values.workspace,
  });
  const shutdown = () => {
    server.close(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

async function run(values) {
  if (!values.graph) throw new ValidationError('run requires --graph');
  const service = new Cachelattice({ dataDirectory: values.data, workspace: values.workspace });
  await service.loading;
  const result = await service.runGraph(values.graph, { useCache: values.cache });
  if (values.out) {
    const last = [...result.nodes].sort((left, right) => (left.id < right.id ? -1 : 1)).at(-1);
    const { buffer } = await service.cacheGet(last.key);
    const target = path.resolve(values.out);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, buffer);
    process.stdout.write(
      `${canonicalJson({ ...result, out: { path: target, digest: digestOf(buffer), size: buffer.length } })}\n`,
    );
    return;
  }
  process.stdout.write(`${canonicalJson(result)}\n`);
}

async function stats(values) {
  const service = new Cachelattice({ dataDirectory: values.data, workspace: values.workspace });
  await service.loading;
  const summary = await service.stats();
  const keys = await service.cacheEntries(100000);
  process.stdout.write(`${canonicalJson({ ...summary, keys })}\n`);
}

async function gc(values) {
  const service = new Cachelattice({ dataDirectory: values.data, workspace: values.workspace });
  await service.loading;
  const result = await service.collectGarbage({ keep: values.keep ?? [], dry_run: values['dry-run'] });
  process.stdout.write(`${canonicalJson(result)}\n`);
}

export async function main(argv = process.argv.slice(2)) {
  const { command, values } = parse(argv);
  if (values.help || !command) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (command === 'serve') await serve(values);
  else if (command === 'run') await run(values);
  else if (command === 'stats') await stats(values);
  else if (command === 'gc') await gc(values);
  else throw new ValidationError(`unknown command: ${command}`);
  return 0;
}

const invokedDirectly = process.argv[1] && import.meta.url === `file://${path.resolve(process.argv[1])}`;
if (invokedDirectly) {
  main().catch((error) => {
    if (error instanceof CachelatticeError) {
      process.stderr.write(`${canonicalJson({ error: { code: error.code, message: error.message } })}\n`);
      process.exit(1);
    }
    process.stderr.write(`${error?.stack ?? error}\n`);
    process.exit(1);
  });
}
