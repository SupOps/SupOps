import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { detonateWithDocker, hasRunsc, validate, type Config } from './engine.ts';

/**
 * The detonation runner's HTTP endpoint. SupOps' core posts a script to `/detonate`;
 * this process runs it in a locked-down throwaway container and returns the raw
 * outputs. It is meant to run as its own container/host with the Docker socket, on a
 * loopback or private address only SupOps can reach -- never exposed publicly, and
 * never given SupOps' own credentials.
 */

const PORT = Number(process.env.PORT ?? 7077);
const dockerBin = process.env.DOCKER_BIN ?? 'docker';
const image = process.env.SANDBOX_IMAGE ?? 'supops-detonate-sandbox';
const network = process.env.SANDBOX_NETWORK ?? 'detonate-sinks';
const sinkDir = process.env.SINK_LOG_DIR ?? '/sinks';

/** The DNS and TCP sinks write per-container logs to a shared volume, keyed by name. */
const readSinkLogs: Config['readSinkLogs'] = async (tag) => ({
  dnsLog: await readFile(join(sinkDir, `${tag}.dns`), 'utf8').catch(() => ''),
  tcpLog: await readFile(join(sinkDir, `${tag}.tcp`), 'utf8').catch(() => ''),
});

async function main() {
  const runsc = await hasRunsc(dockerBin).catch(() => false);
  const cfg: Config = { image, network, runsc, dockerBin, readSinkLogs };
  console.log(`detonator on :${PORT} — engine ${runsc ? 'gVisor (runsc)' : 'runc'}, image ${image}`);

  const server = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') { res.writeHead(200).end('ok'); return; }
    if (req.method !== 'POST' || req.url !== '/detonate') { res.writeHead(404).end(); return; }
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 256 * 1024) req.destroy(); });
    req.on('end', async () => {
      let parsed: unknown;
      try { parsed = JSON.parse(body); } catch { res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'invalid JSON' })); return; }
      const v = validate(parsed);
      if (!v.ok) { res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: v.error })); return; }
      const result = await detonateWithDocker(v.req, cfg).catch((e) => ({ error: e instanceof Error ? e.message : String(e) }));
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(result));
    });
  });
  server.listen(PORT, process.env.BIND ?? '127.0.0.1');
}

void main();
