'use strict';

const http = require('node:http');
const path = require('node:path');
const { loadHostConfig } = require('./config');

function parseArgs(argv) {
  if (argv.length < 2 || argv[0] !== '--config' || !path.isAbsolute(argv[1])
    || (argv.length === 3 && argv[2] !== '--ready') || argv.length > 3) {
    throw new Error('invalid_arguments');
  }
  return { configPath: argv[1], route: argv[2] === '--ready' ? '/readyz' : '/healthz' };
}

function probe(config, route, { requestImpl = http.request, timeoutMs = 2_000 } = {}) {
  const hostname = config.listenHost === '0.0.0.0' ? '127.0.0.1'
    : config.listenHost === '::' ? '::1' : config.listenHost;
  return new Promise((resolve, reject) => {
    const request = requestImpl({ hostname, port: config.port, path: route, method: 'GET',
      headers: { Host: new URL(config.canonicalOrigin).host, Origin: config.canonicalOrigin } }, (response) => {
      response.resume();
      response.once('end', () => response.statusCode === 200
        ? resolve() : reject(new Error('host_unhealthy')));
    });
    request.setTimeout(timeoutMs, () => request.destroy(new Error('host_healthcheck_timeout')));
    request.once('error', reject);
    request.end();
  });
}

async function main(argv = process.argv.slice(2)) {
  const { configPath, route } = parseArgs(argv);
  await probe(loadHostConfig(configPath), route);
}

if (require.main === module) {
  main().catch(() => { process.exitCode = 1; });
}

module.exports = { main, parseArgs, probe };
