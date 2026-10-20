// Reference DNS sink: answers every A/AAAA query with the TCP sink's address and logs
// the queried name, per source IP, to /sinks/<srcip>.dns. Set the sandbox network's
// resolver to this. Minimal DNS: enough to capture what a script tries to resolve.
import { createSocket } from 'node:dgram';
import { appendFile, mkdir } from 'node:fs/promises';
const DIR = process.env.SINK_LOG_DIR ?? '/sinks';
const SINK_IP = (process.env.TCP_SINK_IP ?? '127.0.0.1').split('.').map(Number);
await mkdir(DIR, { recursive: true });
const sock = createSocket('udp4');
sock.on('message', (msg, rinfo) => {
  try {
    // Parse the single question name from the DNS query.
    let off = 12, labels = [];
    while (msg[off]) { const len = msg[off]; labels.push(msg.subarray(off + 1, off + 1 + len).toString()); off += len + 1; }
    const name = labels.join('.');
    const src = rinfo.address.replace(/^::ffff:/, '');
    if (name) void appendFile(`${DIR}/${src}.dns`, `A ${name}\n`).catch(() => {});
    // Build a minimal answer pointing at the TCP sink.
    const qend = off + 5;
    const header = Buffer.from(msg.subarray(0, 12)); header[2] = 0x81; header[3] = 0x80; header[6] = 0; header[7] = 1;
    const answer = Buffer.from([0xc0, 0x0c, 0, 1, 0, 1, 0, 0, 0, 30, 0, 4, ...SINK_IP]);
    sock.send(Buffer.concat([header, msg.subarray(12, qend), answer]), rinfo.port, rinfo.address);
  } catch { /* ignore malformed */ }
});
sock.bind(53, '0.0.0.0', () => console.log('dns-sink on :53 ->', SINK_IP.join('.')));
