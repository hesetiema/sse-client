// Browser matrix automation: drives real Chrome / Edge over CDP and runs the key
// scenarios of the demo console.
//
//   node demo/browser-matrix.mjs
//   node demo/browser-matrix.mjs --only=chrome
//   node demo/browser-matrix.mjs --shots=%TEMP%\sse-matrix
//
// Prerequisites: pnpm build && node demo/server.mjs, plus Nginx on 8081/8082
// (see demo/README.md). Dependencies: Node's built-in WebSocket (Node 22+), no Playwright.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BROWSERS = [
  {
    id: "chrome",
    label: "Chrome",
    exe: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  },
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

const PAGE_URL = process.env.DEMO_PAGE ?? "http://127.0.0.1:8787/demo/index.html";
const SHOT_DIR = args.get("shots") ?? join(tmpdir(), "sse-matrix");
const ONLY = args.get("only");
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/* ------------------------------ CDP client ------------------------------ */

class Cdp {
  constructor(socketUrl) {
    this.socket = new WebSocket(socketUrl);
    this.nextId = 0;
    this.pending = new Map();
    this.listeners = new Map();
    this.sessionId = null;
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

  send(method, params = {}, sessionId = this.sessionId) {
    const id = ++this.nextId;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify(payload));
    });
  }

  on(method, handler) {
    if (!this.listeners.has(method)) this.listeners.set(method, new Set());
    this.listeners.get(method).add(handler);
  }

  close() {
    this.socket.close();
  }
}

async function getJson(url) {
  const response = await fetch(url);
  return response.json();
}

async function launchBrowser(browser, port) {
  const profile = mkdtempSync(join(tmpdir(), `sse-${browser.id}-`));
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

  const deadline = Date.now() + 20000;
  for (;;) {
    try {
      const info = await getJson(`http://127.0.0.1:${port}/json/version`);
      return { child, info };
    } catch {
      if (Date.now() > deadline) throw new Error(`${browser.label} did not start in time`);
      await sleep(300);
    }
  }
}

async function openPage(port) {
  const cdp = new Cdp((await getJson(`http://127.0.0.1:${port}/json/version`)).webSocketDebuggerUrl);
  await cdp.opened;
  const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
  const attached = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
  cdp.sessionId = attached.sessionId;

  const errors = [];
  cdp.on("Runtime.exceptionThrown", (params) => {
    errors.push(params.exceptionDetails?.exception?.description ?? params.exceptionDetails?.text ?? "unknown");
  });
  cdp.on("Log.entryAdded", (params) => {
    if (params.entry?.level !== "error") return;
    // The error500/error401 cases assert these responses on purpose; counting them
    // as page errors would make the summary noisy without adding signal.
    const url = params.entry.url ?? "";
    if (url.includes("/subscribe?") && /\((Internal Server Error|Unauthorized)\)/.test(params.entry.text)) {
      return;
    }
    errors.push(params.entry.text);
  });

  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Log.enable");
  await cdp.send("Network.enable");

  const loaded = new Promise((resolve) => cdp.on("Page.loadEventFired", resolve));
  await cdp.send("Page.navigate", { url: PAGE_URL });
  await loaded;

  // Pin the UI to English: the console follows navigator.language by default and
  // the assertions below match English copy.
  await evaluate(cdp, 'window.__setLang?.("en")');

  return { cdp, errors, targetId };
}

async function evaluate(cdp, expression, sessionId = cdp.sessionId) {
  const { result, exceptionDetails } = await cdp.send(
    "Runtime.evaluate",
    { expression, awaitPromise: true, returnByValue: true },
    sessionId,
  );
  if (exceptionDetails) {
    throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
  }
  return result.value;
}

/* ------------------------------ page driving ------------------------------ */

function applyConfig(config) {
  const set = (id, value) => `document.getElementById(${JSON.stringify(id)}).value = ${JSON.stringify(String(value))};`;
  const check = (id, value) => `document.getElementById(${JSON.stringify(id)}).checked = ${Boolean(value)};`;
  return `(() => {
    ${set("endpoint", config.endpoint ?? "direct")}
    ${set("scenario", config.scenario ?? "normal")}
    ${set("interval", config.interval ?? 250)}
    ${set("idle", config.idle ?? 0)}
    ${set("rotate", config.rotate ?? 0)}
    ${set("maxRetry", config.maxRetry ?? 2)}
    ${set("ttl", config.ttl ?? 60000)}
    ${set("yieldEvery", config.yieldEvery ?? 0)}
    ${check("pauseHidden", config.pauseHidden)}
    ${check("refreshToken", config.refreshToken)}
    ${check("reconnectOnEnd", config.reconnectOnEnd ?? true)}
    ${check("overflowDrop", config.overflowDrop)}
    document.getElementById("connect").click();
    return true;
  })()`;
}

async function resetUi(cdp) {
  await evaluate(
    cdp,
    `(() => { document.getElementById("close").click(); document.getElementById("clear").click(); return true; })()`,
  );
  await sleep(150);
}

async function readUi(cdp, sessionId) {
  return evaluate(
    cdp,
    `(() => {
      const rows = [...document.querySelectorAll(".row")].map((row) => row.innerText.replace(/\\s+/g, " ").trim());
      return {
        status: document.getElementById("status").textContent,
        attempts: Number(document.getElementById("attempts").textContent),
        lastId: document.getElementById("lastId").textContent,
        count: Number(document.getElementById("count").textContent),
        rows,
        text: rows.join("\\n"),
      };
    })()`,
    sessionId,
  );
}

async function waitUntil(cdp, predicate, timeout, sessionId) {
  const start = Date.now();
  for (;;) {
    const ui = await readUi(cdp, sessionId);
    if (predicate(ui)) return ui;
    if (Date.now() - start > timeout) return ui;
    await sleep(150);
  }
}

/* ------------------------------ scenarios ------------------------------ */

const SCENARIOS = [
  {
    id: "direct-normal",
    title: "Direct stream",
    config: { endpoint: "direct", scenario: "normal" },
    wait: 2200,
    check: (ui) => [ui.count >= 4 && ui.status === "open", `count=${ui.count} status=${ui.status}`],
  },
  {
    id: "nginx-ok",
    title: "Nginx 8081 (correct)",
    config: { endpoint: "nginx", scenario: "normal" },
    wait: 2200,
    check: (ui) => [ui.count >= 4 && ui.status === "open", `count=${ui.count} status=${ui.status}`],
  },
  {
    id: "nginx-broken",
    title: "Nginx 8082 (misconfigured)",
    config: { endpoint: "broken", scenario: "normal" },
    wait: 2600,
    check: (ui) => [ui.count === 0, `count=${ui.count} status=${ui.status} (expected 0 events)`],
  },
  {
    id: "chunked-multibyte",
    title: "Chunked + multibyte",
    config: { endpoint: "direct", scenario: "chunked", interval: 400 },
    wait: 2600,
    check: (ui) => [
      ui.count >= 2 && ui.text.includes("Cooling-Tower") && ui.text.includes("😀") && !ui.text.includes("\uFFFD"),
      `count=${ui.count} mojibake=${ui.text.includes("\uFFFD")}`,
    ],
  },
  {
    id: "buffer-overflow",
    title: "2MB over the cap",
    config: { endpoint: "direct", scenario: "huge", interval: 500 },
    wait: 2200,
    check: (ui) => [
      ui.text.includes("protocol") && ui.status === "closed",
      `status=${ui.status} protocol=${ui.text.includes("protocol")}`,
    ],
  },
  {
    id: "overflow-drop",
    title: "2MB dropped, stream survives",
    // The oversized message must cost exactly one message, not the connection:
    // the stream then ends normally (reason=end), never with a protocol error.
    config: {
      endpoint: "direct",
      scenario: "huge",
      interval: 500,
      overflowDrop: true,
      reconnectOnEnd: false,
    },
    wait: 2600,
    // The loss surfaces as a gap (`reason: "drop"`) plus the `dropped` counter,
    // not as a dedicated overflow callback.
    check: (ui) => [
      ui.status === "closed" &&
        ui.text.includes("gap") &&
        ui.text.includes("drop") &&
        !ui.text.includes("protocol"),
      `status=${ui.status} gapRow=${ui.text.includes("gap")} protocol=${ui.text.includes("protocol")}`,
    ],
  },
  {
    id: "end-signal",
    title: "[DONE] terminates",
    config: { endpoint: "direct", scenario: "done", interval: 300 },
    wait: 1800,
    check: (ui) => [
      ui.count === 2 && ui.status === "closed" && ui.text.includes("end"),
      `count=${ui.count} status=${ui.status}`,
    ],
  },
  {
    id: "end-no-reconnect",
    title: "Server end, no reconnect",
    config: { endpoint: "direct", scenario: "end", interval: 300, reconnectOnEnd: false },
    wait: 2200,
    check: (ui) => [
      ui.count === 3 && ui.status === "closed" && ui.text.includes("end"),
      `count=${ui.count} status=${ui.status}`,
    ],
  },
  {
    id: "silent-idle-timeout",
    title: "Silent stream + idleTimeout",
    config: { endpoint: "direct", scenario: "silent", idle: 1500, maxRetry: 2 },
    wait: 3200,
    // `check` must return a boolean first: an interpolated string is always truthy,
    // which silently turned this case into an unconditional pass.
    check: (ui) => [
      ui.text.includes("heartbeat") && ui.attempts >= 1,
      `heartbeat=${ui.text.includes("heartbeat")} attempts=${ui.attempts}`,
    ],
  },
  {
    id: "offline-recover",
    title: "Offline 0.8s recovery",
    config: { endpoint: "direct", scenario: "normal" },
    wait: 1600,
    prepare: async (cdp) => {
      await cdp.send("Network.emulateNetworkConditions", {
        offline: true,
        latency: 0,
        downloadThroughput: -1,
        uploadThroughput: -1,
      });
    },
    afterPrepare: 900,
    recover: async (cdp) => {
      await cdp.send("Network.emulateNetworkConditions", {
        offline: false,
        latency: 0,
        downloadThroughput: -1,
        uploadThroughput: -1,
      });
    },
    recoverWait: 2600,
    check: (ui) => [
      ui.status === "open" && ui.count > 4 && !/close error/.test(ui.text),
      `status=${ui.status} count=${ui.count} closedByRace=${/close error/.test(ui.text)}`,
    ],
  },
  {
    id: "heartbeat-watchdog",
    title: "Heartbeat comments + idleTimeout",
    // Comments are not events, so the counter stays at 0; an idleTimeout below the
    // heartbeat interval must still notice the stream is alive... and, when the
    // heartbeat is slower than the timeout, reconnect instead of hanging.
    config: { endpoint: "direct", scenario: "heartbeat", interval: 2000, idle: 1000, maxRetry: 2 },
    wait: 3600,
    check: (ui) => [
      ui.count === 0 && ui.text.includes("heartbeat") && ui.attempts >= 1,
      `count=${ui.count} heartbeatError=${ui.text.includes("heartbeat")} attempts=${ui.attempts}`,
    ],
  },
  {
    id: "retry-field",
    title: "retry: field parsed, reconnect",
    // The `retry:` line must not be dispatched as an event and must not break the
    // stream; the replayed ids prove the reconnect happened. The ~2s delay itself
    // is not asserted: the log only has second resolution.
    config: { endpoint: "direct", scenario: "retry-field", interval: 200, maxRetry: 2 },
    wait: 2600,
    check: (ui) => [
      ui.count >= 2 && !ui.text.includes("protocol"),
      `count=${ui.count} protocol=${ui.text.includes("protocol")}`,
    ],
  },
  {
    id: "no-blank-line",
    title: "Unterminated event hits the cap",
    // 4KB per 10ms ≈ 400KB/s, so the 1MB cap needs a bit over 2.5s; wait for margin.
    config: { endpoint: "direct", scenario: "no-blank-line", interval: 100 },
    wait: 5000,
    check: (ui) => [
      ui.text.includes("protocol") && ui.status === "closed",
      `status=${ui.status} protocol=${ui.text.includes("protocol")}`,
    ],
  },
  {
    id: "slow-handshake",
    title: "Slow headers stay 'connecting'",
    // 3s before the response headers: nothing should look open, and no event may
    // be counted before the handshake completes.
    config: { endpoint: "direct", scenario: "slow", interval: 300 },
    wait: 2000,
    check: (ui) => [
      ui.count === 0 && ui.status === "connecting",
      `count=${ui.count} status=${ui.status}`,
    ],
  },
  {
    id: "html-login-page",
    title: "200 + text/html is rejected",
    config: { endpoint: "direct", scenario: "html" },
    wait: 2200,
    check: (ui) => [
      ui.count === 0 && ui.status === "closed" && ui.attempts === 1 && ui.text.includes("protocol"),
      `count=${ui.count} status=${ui.status} attempts=${ui.attempts}`,
    ],
  },
  {
    id: "error500-backoff",
    title: "500 retried, then exhausted",
    config: { endpoint: "direct", scenario: "error500", maxRetry: 2 },
    wait: 5000,
    check: (ui) => [
      ui.status === "closed" && ui.attempts >= 2 && ui.text.includes("500"),
      `status=${ui.status} attempts=${ui.attempts} saw500=${ui.text.includes("500")}`,
    ],
  },
  {
    id: "error401-terminal",
    title: "401 is terminal, no retry",
    config: { endpoint: "direct", scenario: "error401", maxRetry: 2 },
    wait: 2600,
    check: (ui) => [
      ui.status === "closed" && ui.attempts === 1 && ui.text.includes("401"),
      `status=${ui.status} attempts=${ui.attempts} saw401=${ui.text.includes("401")}`,
    ],
  },
  {
    id: "accel-direct",
    title: "accel: X-Accel-Buffering stream",
    // `accel` is the normal stream plus `X-Accel-Buffering: no`. Asserted on the
    // direct endpoint, where the header is inert; its effect on :8082 depends on
    // gzip and is left to the manual demo instead of flaking CI.
    config: { endpoint: "direct", scenario: "accel", interval: 250 },
    wait: 2200,
    check: (ui) => [ui.count >= 4 && ui.status === "open", `count=${ui.count} status=${ui.status}`],
  },
];

/**
 * Headless cannot really toggle tab visibility: background tabs stay "visible"
 * and Page.setWebLifecycleState("active") never restores visibilityState. So only
 * document.hidden is faked; the visibilitychange event and the client path are real.
 */
async function runHiddenTests(cdp) {
  const results = [];
  await evaluate(
    cdp,
    `(() => {
      window.__setHidden = (value) => {
        Object.defineProperty(document, "hidden", { configurable: true, get: () => value });
        document.dispatchEvent(new Event("visibilitychange"));
      };
      window.__clearHidden = () => { delete document.hidden; };
      return true;
    })()`,
  );

  // 1) hide a live connection, then bring it back
  await resetUi(cdp);
  await evaluate(cdp, applyConfig({ endpoint: "direct", scenario: "normal", pauseHidden: true }));
  await waitUntil(cdp, (ui) => ui.count >= 3, 3000);

  await evaluate(cdp, "window.__setHidden(true)");
  await sleep(500);
  const parked = await readUi(cdp);
  await sleep(1200);
  const parkedStill = await readUi(cdp);

  await evaluate(cdp, "window.__setHidden(false)");
  // The status pill refreshes every 300ms, so require both growth and status=open.
  const resumed = await waitUntil(cdp, (ui) => ui.count > parkedStill.count && ui.status === "open", 3500);
  await evaluate(cdp, "window.__clearHidden()");

  results.push({
    id: "hidden-live",
    title: "Background suspend → resume",
    pass:
      parked.status === "idle" &&
      parkedStill.count === parked.count &&
      resumed.status === "open" &&
      resumed.count > parkedStill.count,
    detail: `parked ${parked.status}/${parked.count} events, silent 1.2s=${parkedStill.count === parked.count} → resumed ${resumed.status}/${resumed.count} events`,
  });

  // 2) construct the client while the page is hidden (WebView preload, the P0 fix)
  await resetUi(cdp);
  await evaluate(cdp, "window.__setHidden(true)");
  await evaluate(cdp, applyConfig({ endpoint: "direct", scenario: "normal", pauseHidden: true }));
  await sleep(1500);
  const idle = await readUi(cdp);

  await evaluate(cdp, "window.__setHidden(false)");
  const resumedAtStart = await waitUntil(cdp, (ui) => ui.count > 0 && ui.status === "open", 3500);
  await evaluate(cdp, "window.__clearHidden()");

  results.push({
    id: "hidden-at-start",
    title: "Constructed while hidden",
    pass: idle.count === 0 && idle.status === "idle" && resumedAtStart.count > 0 && resumedAtStart.status === "open",
    detail: `before ${idle.count} events/${idle.status} → after ${resumedAtStart.count} events/${resumedAtStart.status}`,
  });

  return results;
}

/* ------------------------------ runner ------------------------------ */

async function runBrowser(browser) {
  const port = browser.id === "chrome" ? 9333 : 9334;
  const { child, info } = await launchBrowser(browser, port);
  const { cdp, errors } = await openPage(port);
  const results = [];

  try {
    for (const scenario of SCENARIOS) {
      await resetUi(cdp);
      await evaluate(cdp, applyConfig(scenario.config));

      if (scenario.prepare) {
        await sleep(scenario.wait);
        await scenario.prepare(cdp);
        await sleep(scenario.afterPrepare ?? 800);
        if (scenario.recover) {
          await scenario.recover(cdp);
          await sleep(scenario.recoverWait ?? 2000);
        }
      } else {
        await sleep(scenario.wait);
      }

      const ui = await readUi(cdp);
      const [pass, detail] = scenario.check(ui);
      results.push({ id: scenario.id, title: scenario.title, pass, detail });

      const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
      writeFileSync(join(SHOT_DIR, `${browser.id}-${scenario.id}.png`), Buffer.from(shot.data, "base64"));
    }

    const hidden = await runHiddenTests(cdp);
    results.push(...hidden);
    const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
    writeFileSync(join(SHOT_DIR, `${browser.id}-hidden-resume.png`), Buffer.from(shot.data, "base64"));
  } finally {
    cdp.close();
    child.kill();
  }

  return { version: info.Browser, results, errors };
}

mkdirSync(SHOT_DIR, { recursive: true });

const summary = [];
for (const browser of BROWSERS) {
  if (ONLY && ONLY !== browser.id) continue;
  if (!existsSync(browser.exe)) {
    console.log(`\n=== ${browser.label} === skipped: not installed (${browser.exe})`);
    continue;
  }
  console.log(`\n=== ${browser.label} ===`);
  const outcome = await runBrowser(browser);
  console.log(`version: ${outcome.version}`);
  for (const item of outcome.results) {
    console.log(`${item.pass ? "PASS" : "FAIL"}  ${item.title.padEnd(28)} ${item.detail}`);
  }
  if (outcome.errors.length) {
    console.log(`page errors: ${outcome.errors.slice(0, 3).join(" | ")}`);
  }
  summary.push({ browser: browser.label, ...outcome });
}

const failed = summary.flatMap((item) =>
  item.results.filter((result) => !result.pass).map((result) => `${item.browser}/${result.id}`),
);
console.log(`\nscreenshots: ${SHOT_DIR}`);
console.log(failed.length ? `FAILED: ${failed.join(", ")}` : `ALL PASS (${summary.length} browsers)`);
process.exit(failed.length ? 1 : 0);
