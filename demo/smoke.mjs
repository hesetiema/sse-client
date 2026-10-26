// Headless smoke test: runs the real client against the direct endpoint, both
// gateway entries and a Last-Event-ID resume. Takes about 10 seconds and answers
// "is this a client problem or a gateway problem?" from the command line / CI.
//
//   node demo/smoke.mjs
//   DEMO_HOST=192.0.2.10 DEMO_PORT=8787 DEMO_NGINX=8081,8082 node demo/smoke.mjs
import { SSEClient } from "../dist/index.js";

const HOST = process.env.DEMO_HOST ?? "127.0.0.1";
const PORT = process.env.DEMO_PORT ?? "8787";
const BASE = `http://${HOST}:${PORT}`;
const NGINX_PORTS = (process.env.DEMO_NGINX ?? "8081,8082").split(",").filter(Boolean);

async function probe(url, { timeout = 2500, headers = {} } = {}) {
  const messages = [];
  const errors = [];
  const client = new SSEClient({
    url,
    body: { topics: ["alarm"] },
    headers,
    parse: (raw) => JSON.parse(raw),
    maxRetry: 1,
    onError: (error) => errors.push(error.kind),
  });
  client.on("*", (_data, message) =>
    messages.push(message.id ? `${message.event}:${message.id}` : message.event),
  );
  await Promise.race([client.done, new Promise((resolve) => setTimeout(resolve, timeout))]);
  const result = {
    status: client.status,
    count: messages.length,
    sample: messages.slice(0, 2),
    errors,
  };
  client.close();
  return result;
}

const token = (await (await fetch(`${BASE}/auth/token?ttl=120000`)).json()).token;
const auth = { authorization: `Bearer ${token}` };

const rows = [];
const direct = await probe(`${BASE}/subscribe?scenario=normal&interval=200`, { headers: auth });
rows.push(["Direct", BASE, direct]);

for (const port of NGINX_PORTS) {
  const url = `http://${HOST}:${port}/subscribe?scenario=normal&interval=200`;
  rows.push([`Nginx :${port}`, `http://${HOST}:${port}`, await probe(url, { headers: auth })]);
}

const resume = await probe(`${BASE}/subscribe?scenario=normal&interval=200`, {
  timeout: 1500,
  headers: { ...auth, "Last-Event-ID": "5" },
});

for (const [label, endpoint, result] of rows) {
  const down = result.errors.includes("network");
  const verdict = down
    ? "not running (skipped)"
    : result.count > 0
      ? `received ${result.count} events live`
      : `no data (status=${result.status}, typical gateway buffering)`;
  console.log(`${label.padEnd(11)} ${endpoint.padEnd(26)} ${verdict}`);
  if (result.sample.length) console.log(`${"".padEnd(11)} first: ${result.sample.join(", ")}`);
}

console.log(`\nLast-Event-ID resume: ${resume.sample.join(" → ") || "(no events)"}`);

const checks = [
  ["direct endpoint receives events", direct.count >= 3],
  ["resume starts at id=6", resume.sample.includes("ALARM:6")],
];
for (const [name, passed] of checks) console.log(`${passed ? "PASS" : "FAIL"}  ${name}`);
process.exit(checks.every(([, passed]) => passed) ? 0 : 1);
