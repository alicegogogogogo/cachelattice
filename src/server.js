import http from 'node:http';
import { URL } from 'node:url';

import { canonicalJson } from './canonical.js';
import { CachelatticeError, NotFoundError, ValidationError } from './errors.js';
import { Cachelattice, assertCacheKey } from './service.js';

const MAX_BODY = 4 * 1024 * 1024;

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };
const OCTET_HEADERS = { 'content-type': 'application/octet-stream' };

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new ValidationError('request body exceeds 4194304 bytes'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks)));
    request.on('error', reject);
  });
}

function parseJson(buffer) {
  if (buffer.length === 0) throw new ValidationError('request body must be JSON');
  try {
    return JSON.parse(buffer.toString('utf8'));
  } catch {
    throw new ValidationError('request body must be valid JSON');
  }
}

export function createServer(service) {
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    const segments = url.pathname.split('/').filter((segment) => segment.length > 0);
    const idempotencyKey = request.headers['idempotency-key'];
    let status = 200;
    let headers = JSON_HEADERS;
    let body;

    try {
      const route = await route_request(service, request, url, segments, idempotencyKey);
      status = route.status;
      headers = { ...(route.headers ?? JSON_HEADERS) };
      body = route.body;
      if (route.idempotent && typeof idempotencyKey === 'string' && idempotencyKey.length > 0) {
        await service.remember(route.operation, idempotencyKey, {
          status,
          body: route.body.toString('base64'),
        });
      }
    } catch (error) {
      if (error instanceof CachelatticeError) {
        status = error.status;
        body = Buffer.from(
          `${canonicalJson({ error: { code: error.code, message: error.message } })}\n`,
          'utf8',
        );
      } else {
        status = 500;
        body = Buffer.from(
          `${canonicalJson({ error: { code: 'internal_error', message: 'internal server error' } })}\n`,
          'utf8',
        );
        process.stderr.write(`cachelattice: ${error?.stack ?? error}\n`);
      }
      headers = JSON_HEADERS;
    }

    response.writeHead(status, {
      ...headers,
      'content-length': String(body.length),
      connection: 'close',
    });
    response.end(body);
  });

  server.on('clientError', (error, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
  });

  return server;
}

async function route_request(service, request, url, segments, idempotencyKey) {
  const method = request.method;
  const jsonOut = (status, value, extra = {}) => ({
    status,
    headers: JSON_HEADERS,
    body: Buffer.from(`${canonicalJson(value)}\n`, 'utf8'),
    ...extra,
  });

  if (method === 'GET' && segments.length === 1 && segments[0] === 'health') {
    return jsonOut(200, { status: 'ok', service: 'cachelattice' });
  }

  if (method === 'GET' && segments.length === 1 && segments[0] === 'actions') {
    return jsonOut(200, { actions: await service.listActions() });
  }
  if (method === 'GET' && segments.length === 2 && segments[0] === 'actions') {
    return jsonOut(200, await service.getAction(segments[1]));
  }
  if ((method === 'POST' || method === 'PUT') && segments.length === 1 && segments[0] === 'actions') {
    const body = parseJson(await readBody(request));
    const replayed = await service.recall('POST /actions', idempotencyKey);
    if (replayed) return jsonOut(replayed.status, JSON.parse(Buffer.from(replayed.body, 'base64').toString('utf8')));
    return jsonOut(201, await service.putAction(body), { idempotent: true, operation: 'POST /actions' });
  }
  if (method === 'PUT' && segments.length === 2 && segments[0] === 'actions') {
    const body = parseJson(await readBody(request));
    if (body.name !== undefined && body.name !== segments[1]) {
      throw new ValidationError('action body name must match the path name');
    }
    return jsonOut(200, await service.putAction({ ...body, name: segments[1] }, { refresh: true }));
  }

  if (method === 'GET' && segments.length === 1 && segments[0] === 'graphs') {
    return jsonOut(200, { graphs: await service.listGraphs() });
  }
  if ((method === 'POST' || method === 'PUT') && segments.length === 1 && segments[0] === 'graphs') {
    const body = parseJson(await readBody(request));
    if (typeof body.id !== 'string') throw new ValidationError('graph body must carry an id');
    const replayed = await service.recall('POST /graphs', idempotencyKey);
    if (replayed) return jsonOut(replayed.status, JSON.parse(Buffer.from(replayed.body, 'base64').toString('utf8')));
    return jsonOut(201, await service.putGraph(body.id, body), { idempotent: true, operation: 'POST /graphs' });
  }
  if (method === 'PUT' && segments.length === 2 && segments[0] === 'graphs') {
    const body = parseJson(await readBody(request));
    if (body.id !== undefined && body.id !== segments[1]) {
      throw new ValidationError('graph body id must match the path id');
    }
    return jsonOut(200, await service.putGraph(segments[1], body));
  }
  if (method === 'GET' && segments.length === 2 && segments[0] === 'graphs') {
    return jsonOut(200, await service.getGraph(segments[1]));
  }
  if (method === 'POST' && segments.length === 3 && segments[0] === 'graphs' && segments[2] === 'run') {
    const raw = await readBody(request);
    const body = raw.length === 0 ? {} : parseJson(raw);
    for (const key of Object.keys(body)) {
      if (key !== 'use_cache') throw new ValidationError(`run request contains an unknown field: ${key}`);
    }
    const useCache = body.use_cache === undefined ? true : body.use_cache;
    if (typeof useCache !== 'boolean') throw new ValidationError('use_cache must be a boolean');
    const operation = `POST /graphs/${segments[1]}/run`;
    const replayed = await service.recall(operation, idempotencyKey);
    if (replayed) return jsonOut(replayed.status, JSON.parse(Buffer.from(replayed.body, 'base64').toString('utf8')));
    return jsonOut(200, await service.runGraph(segments[1], { useCache }), { idempotent: true, operation });
  }  if (method === 'POST' && segments.length === 3 && segments[0] === 'graphs' && segments[2] === 'verify') {
    const raw = await readBody(request);
    if (raw.length > 0) parseJson(raw);
    return jsonOut(200, await service.verifyGraph(segments[1]));
  }

  if (method === 'GET' && segments.length === 1 && segments[0] === 'stats') {
    return jsonOut(200, await service.stats());
  }
  if (method === 'GET' && segments.length === 1 && segments[0] === 'cache') {
    return jsonOut(200, { entries: await service.cacheEntries() });
  }
  if (method === 'GET' && segments.length === 2 && segments[0] === 'cache') {
    const key = assertCacheKey(segments[1]);
    const { manifest, buffer } = await service.remoteRead(key);
    if (url.searchParams.get('meta') === '1') {
      return jsonOut(200, {
        key,
        action_id: manifest.action_id,
        digest: manifest.digest,
        size: manifest.size,
        command: manifest.command,
        key_schema: manifest.key_schema,
      });
    }
    return {
      status: 200,
      headers: {
        ...OCTET_HEADERS,
        'x-cache-key': key,
        'x-cache-digest': manifest.digest,
        'x-cache-size': String(buffer.length),
      },
      body: buffer,
    };
  }
  if (method === 'POST' && segments.length === 2 && segments[0] === 'cache' && segments[1] === 'gc') {
    const raw = await readBody(request);
    const body = raw.length === 0 ? {} : parseJson(raw);
    return jsonOut(200, await service.gc(body));
  }
  if ((method === 'PUT' || method === 'POST') && segments.length === 2 && segments[0] === 'cache') {
    const key = assertCacheKey(segments[1]);
    const buffer = await readBody(request);
    if (buffer.length === 0) throw new ValidationError('cache upload body must carry the artifact bytes');
    const entry = {
      action_id: request.headers['x-cache-action'] ?? 'remote',
      command: JSON.parse(request.headers['x-cache-command'] ?? 'null'),
      inputs: JSON.parse(request.headers['x-cache-inputs'] ?? 'null'),
      env: JSON.parse(request.headers['x-cache-env'] ?? 'null'),
    };
    const manifest = await service.cachePut(key, entry, buffer);
    return jsonOut(201, { key, digest: manifest.digest, size: manifest.size });
  }

  throw new NotFoundError('route was not found');
}

export async function start({ host = '127.0.0.1', port = 18091, dataDirectory, workspace }) {
  const service = new Cachelattice({ dataDirectory, workspace });
  await service.loading;
  const server = createServer(service);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  const address = server.address();
  process.stdout.write(
    `Cachelattice listening on http://${host}:${address.port}\n`,
  );
  return { server, service, port: address.port };
}
