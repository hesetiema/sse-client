// Browser check for the consumer examples: drives `demo/consumers/*` in a real
// browser and asserts the one behaviour each page exists to demonstrate.
//
//   node demo/consumers-check.mjs                # every installed browser
//   node demo/consumers-check.mjs --only=edge
//
// Prerequisites: pnpm build && node demo/server.mjs (the pages import dist/).
// Needs Node 22+ (built-in WebSocket) and Chrome or Edge; no Playwright.
//
// What it covers, and why these four and not more:
// - multi-tab:  roles split, relay works, and a follower takes over on leader close
//               (the `promote` path cannot be reached from a single tab)
// - vue-shared: switching the tenant changes the share key while staying open
// - point-board: the ring buffer fills and the page keeps rendering under pressure
// - alarm-center: F5 resumes from the stored id, and a revoked token heals itself
//               (runs last: it revokes every issued token)
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BROWSERS = [
  { id: "chrome", label: "Chrome", exe: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" },
  {
    id: "edge",
    label: "Edge",
    exe: "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  },
];

const args = new Map(
  process.argv.slice(2).map((item) => {
    const [key, value = "true"] = item.replace(/^--/, "").split("=");
    return [key, value];
  }),
);
const ONLY = args.get("only");
const BASE = process.env.DEMO_BASE ?? "http://127.0.0.1:8787";
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

const PAGES = {
  multiTab: `${BASE}/demo/consumers/multi-tab/index.html`,
  vueShared: `${BASE}/demo/consumers/vue-shared/index.html`,
  pointBoard: `${BASE}/demo/consumers/point-board/index.html`,
  alarmCenter: `${BASE}/demo/consumers/alarm-center/index.html`,
};

/* ------------------------------ preflight ------------------------------ */

try {
  const health = await (await fetch(`${BASE}/health`)).json();
  if (!health.ok) throw new Error("unhealthy");
} catch {
  console.error(`[consumers] demo server is not answering on ${BASE} — run: node demo/server.mjs`);
  process.exit(2);
}

try {
  const response = await fetch(`${BASE}/demo/consumers/multi-tab/main.js`);
  if (!response.ok) throw new Error(String(response.status));
} catch {
  console.error(`[consumers] consumer pages are not served from ${BASE}`);
  process.exit(2);
}

/* ------------------------------ CDP client ------------------------------ */

class Cdp {
  constructor(socketUrl) {
    this.socket = new WebSocket(socketUrl);
    this.nextId = 0;
    this.pending = new Map();
    this.listeners = new Map();
    this.opened = new Promise((resolve, reject) => {
      this.socket.addEventListener("open", () => resolve());
      this.socket.addEventListener("error", (event) => reject(new Error(String(event.message ?? "ws error"))));
    });
    this.socket.addEventListener("message", (event) => this.dispatch(event.data));
  }

  dispatch(raw) {
    const message = JSON.parse(raw);
    if (message.id && this.pending.has(message.id)) {
      const { resolve, reject } = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) reject(new Error(`${message.error.message} (${message.error.code})`));
      else resolve(message.result);
      return;
    }
    for (const handler of this.listeners.get(message.method) ?? []) handler(message.params ?? {});
  }

  on(method, handler) {
    if (!this.listeners.has(method)) this.listeners.set(method, []);
    this.listeners.get(method).push(handler);
  }

  send(method, params = {}, sessionId) {
    const id = ++this.nextId;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify(payload));
    });
  }

  close() {
    try {
      this.socket.close();
    } catch {
      // already gone
    }
  }
}

async function launchBrowser(browser, port) {
  const profile = mkdtempSync(join(tmpdir(), `sse-consumers-${browser.id}-`));
  const child = spawn(
    browser.exe,
    [
      "--headless=new",
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-gpu",
      "--window-size=1280,900",
      "about:blank",
    ],
    { stdio: "ignore" },
  );
  for (let i = 0; i < 60; i += 1) {
    try {
      const info = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
      return { child, info };
    } catch {
      await sleep(300);
    }
  }
  child.kill();
  throw new Error(`${browser.label} did not expose CDP on ${port}`);
}

/* ------------------------------ page helpers ------------------------------ */

/**
 * One tab, with its own CDP session. Two tabs of the same profile share origin
 * storage and BroadcastChannel, which is exactly what the multi-tab case needs.
 */
async function openTab(cdp, url) {
  const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
  const evaluate = async (expression) => {
    const { result, exceptionDetails } = await cdp.send(
      "Runtime.evaluate",
      { expression, returnByValue: true, awaitPromise: true },
      sessionId,
    );
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
    return result.value;
  };
  await cdp.send("Page.enable", {}, sessionId);
  await cdp.send("Runtime.enable", {}, sessionId);
  await cdp.send("Log.enable", {}, sessionId);
  await cdp.send("Network.enable", {}, sessionId);
  await cdp.send("Page.navigate", { url }, sessionId);
  return {
    evaluate,
    sessionId,
    reload: async () => {
      await cdp.send("Page.reload", {}, sessionId);
    },
    close: () => cdp.send("Target.closeTarget", { targetId }),
    offlineFor: async (ms) => {
      await cdp.send(
        "Network.emulateNetworkConditions",
        { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 },
        sessionId,
      );
      await sleep(ms);
      await cdp.send(
        "Network.emulateNetworkConditions",
        { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 },
        sessionId,
      );
    },
  };
}

/** Poll until `read()` satisfies `predicate`, then return the last value. */
async function waitUntil(read, predicate, timeout = 6000) {
  const started = Date.now();
  for (;;) {
    const value = await read();
    if (predicate(value)) return value;
    if (Date.now() - started > timeout) return value;
    await sleep(200);
  }
}

/** Edit a panel field the way a user would, so the page reconnects on its own. */
const setPanelField = (tab, key, value) =>
  tab.evaluate(`(() => {
    const root = document.querySelector('#panel [data-key="${key}"]');
    const input = root?.querySelector("input, select");
    if (!input) return false;
    if (input.tagName === "SELECT") {
      input.value = ${JSON.stringify(String(value))};
      input.dispatchEvent(new Event("change", { bubbles: true }));
    } else if (input.type === "checkbox") {
      input.checked = ${value ? "true" : "false"};
      input.dispatchEvent(new Event("change", { bubbles: true }));
    } else {
      input.value = ${JSON.stringify(String(value))};
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }
    return true;
  })()`);

/* ------------------------------ cases ------------------------------ */

async function checkMultiTab(cdp, report) {
  const first = await openTab(cdp, PAGES.multiTab);
  const second = await openTab(cdp, PAGES.multiTab);
  await sleep(1200);

  const readRole = (tab) => tab.evaluate('document.querySelector("#role")?.textContent');
  const readCount = (tab) =>
    tab.evaluate(`(() => {
      const text = document.querySelector("#stats")?.textContent ?? "";
      return Number((text.match(/收到 (\\d+) 条/) ?? [])[1] ?? 0);
    })()`);

  // Which tab wins the lock is up to the browser, so assert exactly one leader and
  // one follower rather than "the first tab is the leader" (Edge picks differently).
  const isSplit = (roles) =>
    (roles.first === "leader" && roles.second === "follower") ||
    (roles.first === "follower" && roles.second === "leader");
  const roles = await waitUntil(
    async () => ({ first: await readRole(first), second: await readRole(second) }),
    isSplit,
  );
  report("multi-tab splits roles", isSplit(roles), `tab1=${roles.first} tab2=${roles.second}`);

  const leader = roles.first === "leader" ? first : second;
  const follower = leader === first ? second : first;

  const counts = await waitUntil(
    async () => ({ leader: await readCount(leader), follower: await readCount(follower) }),
    (value) => value.leader > 0 && value.follower > 0,
  );
  report(
    "multi-tab relays to the follower",
    counts.leader > 0 && counts.follower > 0,
    `${counts.leader} / ${counts.follower} events`,
  );

  await leader.close();
  const promoted = await waitUntil(
    async () => ({ role: await readRole(follower), count: await readCount(follower) }),
    (state) => state.role === "leader" && state.count > counts.follower,
  );
  report(
    "multi-tab promotes on leader close",
    promoted.role === "leader" && promoted.count > counts.follower,
    `role=${promoted.role} events ${counts.follower} → ${promoted.count}`,
  );
  await follower.close();
}

async function checkVueShared(cdp, report) {
  const tab = await openTab(cdp, PAGES.vueShared);
  const read = () =>
    tab.evaluate(`(() => {
      const text = document.querySelector("#app header")?.innerText ?? "";
      return {
        status: document.querySelector("#app .chip")?.textContent?.trim(),
        key: (text.match(/key ([^\\s·]+)/) ?? [])[1] ?? "",
        count: Number((text.match(/收到 (\\d+) 条/) ?? [])[1] ?? 0),
        tenants: [...document.querySelectorAll("#app button")].map((button) => button.textContent.trim()),
      };
    })()`);

  const before = await waitUntil(read, (state) => state.status === "open" && state.count > 0);
  report("vue-shared connects", before.status === "open" && before.count > 0, `key=${before.key} count=${before.count}`);

  const next = before.tenants.find((name) => name !== before.tenants[0]);
  await tab.evaluate(
    `[...document.querySelectorAll("#app button")].find((b) => b.textContent.trim() === ${JSON.stringify(next)})?.click()`,
  );
  // A key switch releases the old connection and opens the new one, so `open`
  // comes back after a round trip rather than immediately.
  const after = await waitUntil(
    read,
    (state) => state.status === "open" && state.key !== before.key && state.count > 0,
  );
  report(
    "vue-shared switches tenant key",
    after.status === "open" && after.key !== before.key && after.key !== "" && after.count > 0,
    `${before.key} → ${after.key} status=${after.status}`,
  );

  // Editing the panel writes the same refs the subscription getter reads, so a
  // config edit must land as a new share key without reloading the page.
  const edited = await setPanelField(tab, "interval", 900);
  const rekeyed = await waitUntil(
    async () => ({ ...(await read()) }),
    (state) => state.status === "open" && state.key !== after.key && state.key !== "",
  );
  report(
    "vue-shared re-keys on config edit",
    edited && rekeyed.status === "open" && rekeyed.key !== after.key,
    `${after.key} → ${rekeyed.key} status=${rekeyed.status}`,
  );
  await tab.close();
}

async function checkPointBoard(cdp, report) {
  const tab = await openTab(cdp, PAGES.pointBoard);
  const read = () =>
    tab.evaluate(`(() => {
      const text = document.querySelector("#stats")?.textContent ?? "";
      return {
        status: document.querySelector("#status")?.textContent,
        rows: document.querySelectorAll("#rows tr").length,
        buffered: Number((text.match(/窗口 (\\d+)\\//) ?? [])[1] ?? 0),
      };
    })()`);

  const state = await waitUntil(read, (value) => value.status === "open" && value.rows > 0);
  report("point-board streams into the ring", state.status === "open" && state.rows > 0, `rows=${state.rows} buffered=${state.buffered}`);

  // Changing yieldEvery rebuilds the client (generation 2) while the ring buffer
  // survives: that is the point of keeping history outside the connection.
  const edited = await setPanelField(tab, "yieldEvery", 5);
  const rebuilt = await waitUntil(
    async () => ({
      ...(await read()),
      generation: await tab.evaluate("document.body.dataset.generation ?? \"\""),
    }),
    (value) => value.generation === "2" && value.status === "open" && value.rows > 0,
  );
  report(
    "point-board applies edited config",
    edited && rebuilt.generation === "2" && rebuilt.status === "open" && rebuilt.rows > 0,
    `generation=${rebuilt.generation} status=${rebuilt.status} rows=${rebuilt.rows}`,
  );
  await tab.close();
}

async function checkAlarmCenter(cdp, report) {
  const tab = await openTab(cdp, PAGES.alarmCenter);
  const read = () =>
    tab.evaluate(`(() => {
      const rows = [...document.querySelectorAll("#list li")].map((row) => row.textContent.trim());
      return { status: document.querySelector("#status")?.textContent, rows };
    })()`);

  const first = await waitUntil(read, (value) => value.status === "open" && value.rows.length > 0);
  report("alarm-center connects", first.status === "open" && first.rows.length > 0, `${first.rows.length} rows`);

  // F5: the stored resume point is flushed on pagehide, so the next connection
  // continues from it. `skipped` is firstId - lastId, hence 1 for a clean join.
  await tab.reload();
  const resumed = await waitUntil(
    read,
    (value) => value.status === "open" && value.rows.some((row) => row.includes("resume skipped=")),
  );
  const resumeRow = resumed.rows.find((row) => row.includes("resume skipped=")) ?? "";
  report(
    "alarm-center resumes after F5",
    resumeRow.includes("skipped=1") && resumeRow.includes("continuous=true"),
    `"${resumeRow}"`,
  );

  // Revoke every token, then force a reconnect: the 401 must be classified,
  // refreshed and retried instead of ending the stream.
  await fetch(`${BASE}/auth/revoke`, { method: "POST" });
  await tab.offlineFor(800);
  const healed = await waitUntil(
    read,
    (value) => value.status === "open" && value.rows.some((row) => row.includes("error http 401")),
  );
  report(
    "alarm-center heals a 401",
    healed.status === "open" && healed.rows.some((row) => row.includes("error http 401")),
    `status=${healed.status}`,
  );

  // Ids must keep growing: a resumed stream that rewinds or duplicates would show
  // up here before it shows up in production.
  const ids = healed.rows
    .map((row) => Number((row.match(/#(\d+)/) ?? [])[1]))
    .filter((id) => Number.isFinite(id))
    .reverse();
  report(
    "alarm-center keeps ids monotonic",
    ids.every((id, index) => index === 0 || id > ids[index - 1]),
    ids.length ? `ids ${ids.slice(-5).join(",")}` : "no ids",
  );
  await tab.close();
}

/* ------------------------------ runner ------------------------------ */

const CASES = [checkMultiTab, checkVueShared, checkPointBoard, checkAlarmCenter];

async function runBrowser(browser, port) {
  const { child, info } = await launchBrowser(browser, port);
  const cdp = new Cdp((await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()).webSocketDebuggerUrl);
  await cdp.opened;

  const problems = [];
  cdp.on("Runtime.exceptionThrown", (params) => {
    problems.push(params.exceptionDetails?.exception?.description ?? params.exceptionDetails?.text ?? "exception");
  });
  cdp.on("Log.entryAdded", (params) => {
    if (params.entry?.level !== "error") return;
    const url = params.entry.url ?? "";
    // Benign or expected: the server ships no favicon, the revoke step is supposed
    // to produce one 401, and releasing a share key aborts the old subscription.
    if (url.endsWith("/favicon.ico")) return;
    if (url.includes("/subscribe?") && /\((Unauthorized|Internal Server Error)\)/.test(params.entry.text)) return;
    if (params.entry.text.includes("ERR_CONNECTION_RESET")) return;
    problems.push(params.entry.text);
  });

  const results = [];
  const report = (title, pass, detail) => results.push({ title, pass, detail });

  try {
    for (const run of CASES) await run(cdp, report);
  } finally {
    cdp.close();
    child.kill();
  }

  return { version: info.Browser, results, problems };
}

let failed = 0;
for (const [index, browser] of BROWSERS.entries()) {
  if (ONLY && ONLY !== browser.id) continue;
  if (!existsSync(browser.exe)) {
    console.log(`\n=== ${browser.label} === skipped: not installed (${browser.exe})`);
    continue;
  }
  console.log(`\n=== ${browser.label} ===`);
  const port = 9336 + index;
  const outcome = await runBrowser(browser, port);
  console.log(`version: ${outcome.version}`);
  for (const item of outcome.results) {
    if (!item.pass) failed += 1;
    console.log(`${item.pass ? "PASS" : "FAIL"}  ${item.title.padEnd(34)} ${item.detail}`);
  }
  for (const problem of outcome.problems) {
    failed += 1;
    console.log(`FAIL  page error${" ".repeat(28)} ${problem.slice(0, 160)}`);
  }
}

console.log(failed ? `\nFAILED: ${failed}` : "\nALL PASS");
process.exit(failed ? 1 : 0);
