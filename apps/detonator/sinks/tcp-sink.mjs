// Reference TCP sink for the detonation network. The DNS sink points every name here,
// so any connection a detonated script makes lands on this catch-all. It logs, per
// source container IP, "<dst-ip-or-name>:<port> <first-bytes>" to /sinks/<srcip>.tcp.
// It listens on a wide range of common ports. A canary marker appearing in the bytes
// is how exfiltration is proven downstream (core assembles and judges the logs).
import { createServer } from 'node:net';
import { appendFile, mkdir } from 'node:fs/promises';
const DIR = process.env.SINK_LOG_DIR ?? '/sinks';
await mkdir(DIR, { recursive: true });
const PORTS = (process.env.SINK_PORTS ?? '80,443,53,4444,1337,8080,9001,25,587,3333,14444').split(',').map(Number);
for (const port of PORTS) {
  createServer((sock) => {
    const src = (sock.remoteAddress ?? 'unknown').replace(/^::ffff:/, '');
    sock.once('data', (d) => {
      const preview = d.toString('latin1').replace(/[\r\n]+/g, ' ').slice(0, 200);
      void appendFile(`${DIR}/${src}.tcp`, `127.0.0.1:${port} ${preview}\n`).catch(() => {});
    });
    sock.on('error', () => {});
    sock.end();
  }).listen(port, '0.0.0.0');
}
console.log('tcp-sink listening on', PORTS.join(','));
