#!/usr/bin/env node
// Static file server for the dashboard.
//
//   node scripts/serve.mjs [--port=8080] [--dir=dashboard] [--open-path=/...]
//
// Exists because the dashboard needs a real origin: browsers refuse localStorage
// on file:// URLs, so the reviewed records would not survive a reload. Zero
// dependencies, no directory listing, and it only ever serves files inside this
// repository.
//
// It serves what is already on disk. It does not watch, rebuild, or re-run
// anything (build spec, Section 0, boundary 1).

import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, resolve, relative, isAbsolute, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const DEFAULT_PORT = 8080;
const DEFAULT_DIR = 'dashboard';
const DEFAULT_ENTRY = 'tyre_comparison_dashboard.html';

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.pdf': 'application/pdf',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
};

const USAGE = `
Serve the dashboard over http so the browser gives it a real origin.

  node scripts/serve.mjs [options]     (or: npm run serve:dashboard)

Options
  --port=N        Port to listen on. Default ${DEFAULT_PORT}.
  --dir=<path>    Directory to serve, relative to the repo root. Default ${DEFAULT_DIR}.
                  Must resolve inside the repository.
  --open-path=<p> Path printed as the URL to open. Default /${DEFAULT_ENTRY}.
  --help          This text.
`.trim();

function parseArgs(argv) {
  const flags = {};
  for (const token of argv) {
    if (token === '--help' || token === '-h') return { help: true };
    const match = /^--([a-z-]+)(?:=(.*))?$/.exec(token);
    if (!match) throw new Error(`unexpected argument '${token}' — run with --help`);
    const [, name, value] = match;
    if (!['port', 'dir', 'open-path'].includes(name)) throw new Error(`unknown option --${name}`);
    if (value === undefined) throw new Error(`--${name} needs a value, as --${name}=<value>`);
    flags[name] = value;
  }
  return flags;
}

function resolveOptions(flags) {
  const port = flags.port === undefined ? DEFAULT_PORT : Number(flags.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`--port must be an integer between 0 and 65535, got '${flags.port}'`);
  }

  const root = resolve(REPO_ROOT, flags.dir || DEFAULT_DIR);
  if (!contains(REPO_ROOT, root)) {
    throw new Error(`--dir must stay inside the repository (${REPO_ROOT}), got '${root}'`);
  }

  const openPath = flags['open-path'] || `/${DEFAULT_ENTRY}`;
  return { port, root, openPath: openPath.startsWith('/') ? openPath : `/${openPath}` };
}

/** True when `child` is `parent` itself or sits underneath it. */
function contains(parent, child) {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

/**
 * Map a request URL onto a file inside `root`.
 *
 * Returns null when the path escapes the served directory. Decoding happens
 * before the containment check, so an encoded traversal (`%2e%2e%2f`) is caught
 * by the same test as a plain one.
 */
export function resolveRequestPath(root, requestUrl) {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(requestUrl, 'http://localhost').pathname);
  } catch {
    return null;
  }
  if (pathname.includes('\0')) return null;

  const target = resolve(root, `.${pathname.endsWith('/') ? `${pathname}index.html` : pathname}`);
  if (!contains(root, target) || !contains(REPO_ROOT, target)) return null;
  return target;
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', ...headers });
  res.end(body);
}

async function handle(req, res, opts) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    send(res, 405, 'method not allowed\n', { allow: 'GET, HEAD' });
    return;
  }

  const { root } = opts;
  if (new URL(req.url, 'http://localhost').pathname === '/') {
    res.writeHead(302, { location: opts.openPath });
    res.end();
    return;
  }

  const filePath = resolveRequestPath(root, req.url);
  if (!filePath) {
    send(res, 403, 'forbidden — path is outside the served directory\n');
    return;
  }

  let info;
  try {
    info = await stat(filePath);
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') {
      send(res, 404, 'not found\n');
      return;
    }
    throw err;
  }

  if (info.isDirectory()) {
    // No directory listings: this server exists to hand out one page, not to
    // browse the repo.
    const { pathname } = new URL(req.url, 'http://localhost');
    res.writeHead(302, { location: `${pathname.replace(/\/?$/, '/')}index.html` });
    res.end();
    return;
  }

  const headers = {
    'content-type': CONTENT_TYPES[extname(filePath).toLowerCase()] || 'application/octet-stream',
    'content-length': String(info.size),
    'cache-control': 'no-cache'
  };

  if (req.method === 'HEAD') {
    res.writeHead(200, headers);
    res.end();
    return;
  }

  res.writeHead(200, headers);
  const stream = createReadStream(filePath);
  stream.pipe(res);
  stream.on('error', () => res.destroy());
}

async function main(argv) {
  let opts;
  try {
    const flags = parseArgs(argv);
    if (flags.help) {
      process.stdout.write(`${USAGE}\n`);
      return 0;
    }
    opts = resolveOptions(flags);
  } catch (err) {
    process.stderr.write(`${err.message}\n\n${USAGE}\n`);
    return 1;
  }

  try {
    const dir = await stat(opts.root);
    if (!dir.isDirectory()) throw new Error('not a directory');
  } catch {
    process.stderr.write(`nothing to serve: ${opts.root} is not a directory\n`);
    return 1;
  }

  const server = createServer((req, res) => {
    handle(req, res, opts).catch((err) => {
      process.stderr.write(`${req.method} ${req.url} failed: ${err.message}\n`);
      if (!res.headersSent) send(res, 500, 'internal error\n');
      else res.destroy();
    });
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      process.stderr.write(
        `port ${opts.port} is already in use — try: node scripts/serve.mjs --port=${opts.port + 1}\n`
      );
    } else {
      process.stderr.write(`server error: ${err.message}\n`);
    }
    process.exitCode = 1;
  });

  await new Promise((done) => server.listen(opts.port, '127.0.0.1', done));
  const { port } = server.address();
  process.stdout.write(
    `Serving ${relative(REPO_ROOT, opts.root) || '.'} from ${REPO_ROOT}\n` +
    `Open http://localhost:${port}${opts.openPath}\n` +
    'Ctrl-C to stop.\n'
  );

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      server.close(() => process.exit(0));
    });
  }
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
