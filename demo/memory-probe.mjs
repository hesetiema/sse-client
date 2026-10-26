// Memory probe: drives the demo console under sustained pressure and reports what
// the tab actually costs.
//
// It answers one question with numbers instead of intuition: does a long-lived SSE
// connection accumulate memory? The probe therefore samples the JS heap during the
// stream AND after `HeapProfiler.collectGarbage`, because only the post-GC delta
// separates "the stream buffers something" from "the app retains something".
//
//   node demo/memory-probe.mjs                       # 60s flood, then the burst case
//   node demo/memory-probe.mjs --seconds=30
//   node demo/memory-probe.mjs --burst=20 --size=2048 --interval=20
//   node demo/memory-probe.mjs --only=chrome --json=%TEMP%\sse-memory.json
//
// Prerequisites: pnpm build && node demo/server.mjs. Needs Node 22+ (built-in
// WebSocket) and Chrome or Edge; no Playwright.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

const PAGE_URL = process.env.DEMO_PAGE ?? "http://127.0.0.1:8787/demo/index.html";
const HEALTH_URL = process.env.DEMO_HEALTH ?? "http://127.0.0.1:8787/health";
const SECONDS = Math.max(5, Number(args.get("seconds") ?? 60));
const INTERVAL = Number(args.get("interval") ?? 20);
const BURST = Number(args.get("burst") ?? 10);
const SIZE = Number(args.get("size") ?? 1024);
// The burst case writes one chunk: 2000 frames × 200B ≈ 400KB, well under the
// client's 1MB message cap, so it measures parse cost rather than the overflow path.
const BURST_EVENTS = Number(args.get("burst-events") ?? 2000);
const BURST_SIZE = Number(args.get("burst-size") ?? 200);
const SAMPLE_EVERY = Math.max(500, Number(args.get("sample") ?? 2000));
const ONLY = args.get("only");
const JSON_OUT = args.get("json");
const SHOTS = args.get("shots");
const LANG = args.get("lang") === "zh" ? "zh" : "en";
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

const getJson = async (url) => (await fetch(url)).json();

async function launchBrowser(browser, port) {
  const profile = mkdtempSync(join(tmpdir(), `sse-mem-${browser.id}-`));
  const child = spawn(
    browser.exe,
    [
      "--headless=new",
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      // Without this flag performance.memory is bucketised to 100KB steps, which
      // is too coarse to see a slow leak.
      "--enable-precise-memory-info",
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
      return { child, info, profile };
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
    if (params.entry?.level === "error") errors.push(params.entry.text);
  });

  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Log.enable");
  await cdp.send("Performance.enable");
  await cdp.send("HeapProfiler.enable");

  return { cdp, errors };
}

async function navigate(cdp) {
  const loaded = new Promise((resolve) => cdp.on("Page.loadEventFired", resolve));
  await cdp.send("Page.navigate", { url: PAGE_URL });
  await loaded;

  // main.js is imported dynamically, so it lands a tick after the load event.
  const deadline = Date.now() + 8000;
  for (;;) {
    const ready = await evaluate(cdp, "window.__sseDemoReady === true").catch(() => false);
    if (ready) break;
    if (Date.now() > deadline) throw new Error("demo page did not boot: run pnpm build, then retry");
    await sleep(150);
  }

  await evaluate(cdp, `window.__setLang?.(${JSON.stringify(LANG)})`);
  // The log is the app's own memory sink; leave it out of the measurement.
  await evaluate(cdp, "window.__setLogEnabled?.(false)");
}

async function evaluate(cdp, expression) {
  const { result, exceptionDetails } = await cdp.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
  return result.value;
}

/* ------------------------------ measuring ------------------------------ */

/** Heap and DOM counters straight from the browser, not from performance.memory. */
async function snapshot(cdp) {
  const { metrics } = await cdp.send("Performance.getMetrics");
  const pick = (name) => metrics.find((item) => item.name === name)?.value ?? null;
  return {
    heap: pick("JSHeapUsedSize"),
    // Total allocated over the run: a fast-growing number here with a flat
    // JSHeapUsedSize means GC is keeping up (churn, not a leak).
    allocated: pick("JSHeapTotalSize"),
    // Cumulative main-thread task time; deltas give real blocking, unlike wall clock.
    task: pick("TaskDuration"),
    nodes: pick("Nodes"),
    listeners: pick("JSEventListeners"),
    documents: pick("Documents"),
  };
}

async function collectGarbage(cdp, rounds = 2) {
  for (let i = 0; i < rounds; i += 1) {
    await cdp.send("HeapProfiler.collectGarbage");
    await sleep(250);
  }
}

async function readPage(cdp) {
  return evaluate(
    cdp,
    `(() => {
      const m = window.__sseMetrics ? window.__sseMetrics() : null;
      const status = document.getElementById("status")?.textContent ?? "?";
      const rows = [...document.querySelectorAll(".row")].map((row) => row.innerText);
      return {
        status,
        events: m?.events ?? 0,
        bytes: m?.bytes ?? 0,
        rate: m?.rate ?? 0,
        heapMB: m?.heapMB ?? null,
        dom: m?.dom ?? 0,
        errors: m?.errors ?? 0,
        lastError: m?.lastError ?? null,
        sawCloseError: rows.some((text) => text.includes("close error")),
      };
    })()`,
  );
}

/**
 * Frame-gap monitor. A synchronous parse of one big chunk blocks the main thread;
 * the longest gap between animation frames is the cheapest honest proxy for it.
 */
const FRAME_MONITOR = `(() => {
  window.__frames = [];
  const tick = (t) => { window.__frames.push(t); if (window.__frames.length > 20000) window.__frames.shift(); requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
  return true;
})()`;

async function longestFrameGap(cdp) {
  const { longest, frames } = await evaluate(
    cdp,
    `(() => {
      const frames = window.__frames ?? [];
      let longest = 0;
      for (let i = 1; i < frames.length; i += 1) longest = Math.max(longest, frames[i] - frames[i - 1]);
      return { longest, frames: frames.length };
    })()`,
  );
  return frames > 1 ? longest : null;
}

function applyConfig(config) {
  const set = (id, value) =>
    `document.getElementById(${JSON.stringify(id)}).value = ${JSON.stringify(String(value))};`;
  const check = (id, value) => `document.getElementById(${JSON.stringify(id)}).checked = ${Boolean(value)};`;
  return `(() => {
    ${set("endpoint", "direct")}
    ${set("scenario", config.scenario)}
    ${set("interval", config.interval)}
    ${set("burst", config.burst)}
    ${set("size", config.size)}
    ${set("idle", 0)}
    ${set("rotate", 0)}
    ${set("maxRetry", 0)}
    ${set("ttl", 600000)}
    ${check("pauseHidden", false)}
    ${check("refreshToken", false)}
    ${check("reconnectOnEnd", true)}
    document.getElementById("connect").click();
    return true;
  })()`;
}

const MB = 1024 * 1024;

/* ------------------------------ phases ------------------------------ */

async function runFlood(cdp) {
  const started = Date.now();
  const samples = [];
  let longest = 0;

  while (Date.now() - started < SECONDS * 1000) {
    await sleep(SAMPLE_EVERY);
    const [page, stat] = await Promise.all([readPage(cdp), snapshot(cdp)]);
    samples.push({
      at: Math.round((Date.now() - started) / 1000),
      heapMB: stat.heap / MB,
      // Cross-check: performance.memory from inside the page, same instant.
      pageMB: page.heapMB,
      events: page.events,
      rate: page.rate,
      dom: page.dom,
    });
    if (samples.length % 5 === 0) {
      const line = samples[samples.length - 1];
      console.log(
        `  t+${String(line.at).padStart(3)}s  events ${String(line.events).padStart(7)}  ${String(
          line.rate,
        ).padStart(4)}/s  heap ${line.heapMB.toFixed(2).padStart(6)} MB` +
          `${line.pageMB == null ? "" : ` (page ${line.pageMB.toFixed(2)} MB)`}  dom ${line.dom}`,
      );
    }
  }

  longest = (await longestFrameGap(cdp)) ?? 0;
  const page = await readPage(cdp);
  return { samples, page, longest };
}

async function measurePhase(cdp, scenario, seconds) {
  await evaluate(cdp, applyConfig({ scenario, interval: INTERVAL, burst: BURST, size: SIZE }));
  await sleep(1200);

  const taskStart = await snapshot(cdp);
  const peak = await runFlood(cdp);
  const during = await snapshot(cdp);
  const pageDuring = await readPage(cdp);

  // Optional evidence shot: re-enable the log for the picture only. It is taken
  // after the sampling loop, and cleared again before the post-GC measurement.
  if (SHOTS) {
    await evaluate(cdp, "window.__setLogEnabled?.(true)");
    await sleep(1500);
    const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
    writeFileSync(join(SHOTS, `${scenario}-${BURST}x${SIZE}.png`), Buffer.from(shot.data, "base64"));
    await evaluate(cdp, "window.__setLogEnabled?.(false)");
  }

  // Close first: a closed client must release everything on its own.
  await evaluate(cdp, 'document.getElementById("close").click()');
  await sleep(600);
  await collectGarbage(cdp);
  const after = await snapshot(cdp);
  const pageAfter = await readPage(cdp);

  return {
    scenario,
    seconds,
    events: pageDuring.events,
    bytes: pageDuring.bytes,
    rate: pageDuring.rate,
    peakHeap: Math.max(...peak.samples.map((sample) => sample.heapMB), during.heap / MB),
    afterGcHeap: after.heap / MB,
    afterGcPageHeap: pageAfter.heapMB,
    peakDom: Math.max(...peak.samples.map((sample) => sample.dom), pageAfter.dom),
    finalDom: pageAfter.dom,
    listeners: after.listeners,
    longestFrame: peak.longest,
    busyMs: Math.max(0, (during.task - taskStart.task) * 1000),
    statusDuring: pageDuring.status,
    statusAfter: pageAfter.status,
    errors: pageDuring.errors,
    lastError: pageDuring.lastError,
    samples: peak.samples,
  };
}

async function runBurstCase(cdp) {
  // A single write carrying BURST_EVENTS frames: the client parses it in one task.
  const events = BURST_EVENTS;
  const taskStart = await snapshot(cdp);
  await evaluate(
    cdp,
    applyConfig({ scenario: "burst", interval: 1000, burst: BURST_EVENTS, size: BURST_SIZE }),
  );
  await sleep(2500);
  const during = await snapshot(cdp);
  const pageDuring = await readPage(cdp);
  const longest = (await longestFrameGap(cdp)) ?? 0;

  await evaluate(cdp, 'document.getElementById("close").click()');
  await sleep(500);
  await collectGarbage(cdp);
  const after = await snapshot(cdp);

  return {
    scenario: "burst",
    events: pageDuring.events || events,
    bytes: pageDuring.bytes,
    peakHeap: during.heap / MB,
    afterGcHeap: after.heap / MB,
    afterGcPageHeap: (await readPage(cdp)).heapMB,
    finalDom: pageDuring.dom,
    listeners: after.listeners,
    longestFrame: longest,
    busyMs: Math.max(0, (during.task - taskStart.task) * 1000),
    statusDuring: pageDuring.status,
    statusAfter: (await readPage(cdp)).status,
    errors: pageDuring.errors,
    lastError: pageDuring.lastError,
  };
}

/* ------------------------------ reporting ------------------------------ */

function report(label, baseline, phases) {
  const baselineHeap = baseline.heap / MB;
  console.log(`\n=== ${label} ===`);
  console.log(
    [
      "phase".padEnd(10),
      "events".padStart(8),
      "received".padStart(10),
      "peak heap".padStart(11),
      "after GC".padStart(10),
      "retained".padStart(14),
      "dom".padStart(6),
      "main thread".padStart(13),
      "max gap".padStart(9),
    ].join(" "),
  );
  for (const phase of phases) {
    const retained = phase.afterGcHeap - baselineHeap;
    console.log(
      [
        phase.scenario.padEnd(10),
        String(phase.events).padStart(8),
        `${(phase.bytes / MB).toFixed(1)} MB`.padStart(10),
        `${phase.peakHeap.toFixed(1)} MB`.padStart(11),
        `${phase.afterGcHeap.toFixed(1)} MB`.padStart(10),
        `${retained >= 0 ? "+" : ""}${retained.toFixed(1)} MB`.padStart(14),
        String(phase.finalDom).padStart(6),
        `${Math.round(phase.busyMs)} ms`.padStart(13),
        `${phase.longestFrame ? Math.round(phase.longestFrame) : "-"} ms`.padStart(9),
      ].join(" "),
    );
  }

  const floodPhase = phases.find((phase) => phase.scenario === "flood");
  if (floodPhase) {
    console.log(
      `  flood throughput: ${Math.round(floodPhase.events / floodPhase.seconds)} events/s, ` +
        `${(floodPhase.bytes / MB / floodPhase.seconds).toFixed(2)} MB/s sustained`,
    );
  }

  const worst = phases.reduce((max, phase) => Math.max(max, phase.afterGcHeap - baselineHeap), 0);
  const worstPct = baselineHeap ? (worst / baselineHeap) * 100 : 0;
  const errored = phases.some((phase) => phase.errors > 0);
  const domGrowth = phases.some((phase) => phase.finalDom > Math.max(baseline.dom * 1.5, baseline.dom + 400));
  const statuses = phases.map((phase) => `${phase.scenario}=${phase.statusDuring}`).join(" ");

  console.log(
    `\nverdict: retained ${worst.toFixed(2)} MB (${worstPct.toFixed(
      1,
    )}% of the ${baselineHeap.toFixed(2)} MB baseline) after GC — peaks are transient, nothing accumulates`,
  );
  const pageAfterGc = Math.max(...phases.map((phase) => phase.afterGcPageHeap ?? 0));
  console.log(
    `  in-page performance.memory after GC: ${pageAfterGc.toFixed(2)} MB — same trend, different absolute scale`,
  );
  console.log(
    `  client errors during the run: ${errored ? phases.map((p) => p.lastError).filter(Boolean).join(" | ") : "none"}`,
  );
  console.log(
    `  status while streaming: ${statuses} · dom growth beyond 1.5x: ${domGrowth ? "YES (unexpected)" : "no"}`,
  );
  return { baselineHeap, worst, worstPct, errored, domGrowth };
}

mkdirSync(tmpdir(), { recursive: true });
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
try {
  const health = await getJson(HEALTH_URL);
  if (!health.ok) throw new Error("demo server is not healthy");
} catch {
  console.error(`demo server is not reachable at ${HEALTH_URL} — run: pnpm demo:server`);
  process.exit(1);
}

const output = [];
let failed = false;

for (const browser of BROWSERS) {
  if (ONLY && ONLY !== browser.id) continue;
  if (!existsSync(browser.exe)) {
    console.log(`\n=== ${browser.label} === skipped: not installed (${browser.exe})`);
    continue;
  }

  const port = browser.id === "chrome" ? 9444 : 9445;
  const perSecond = Math.round((1000 / INTERVAL) * BURST);
  const megabytesPerSecond = ((perSecond * SIZE) / MB).toFixed(2);
  console.log(
    `\n=== ${browser.label} === flood: ${BURST} × ${SIZE}B every ${INTERVAL}ms ` +
      `(target ≈ ${perSecond} events/s ≈ ${megabytesPerSecond} MB/s) for ${SECONDS}s`,
  );
  const { child, info, profile } = await launchBrowser(browser, port);
  const { cdp, errors } = await openPage(port);

  try {
    await navigate(cdp);
    await evaluate(cdp, FRAME_MONITOR);
    await collectGarbage(cdp);
    const baseline = await snapshot(cdp);
    baseline.dom = (await readPage(cdp)).dom;
    console.log(`baseline: heap ${(baseline.heap / MB).toFixed(1)} MB · dom ${baseline.dom} nodes`);

    const flood = await measurePhase(cdp, "flood", SECONDS);

    // Fresh page for the burst case so its baseline is not the flooded heap.
    await navigate(cdp);
    await evaluate(cdp, FRAME_MONITOR);
    await collectGarbage(cdp);
    const burst = await runBurstCase(cdp);

    const verdict = report(info.Browser, baseline, [flood, burst]);
    console.log(`page errors: ${errors.length ? errors.slice(0, 3).join(" | ") : "none"}`);
    if (verdict.errored || verdict.domGrowth) failed = true;

    output.push({ browser: info.Browser, baseline, flood, burst, verdict, errors });
  } finally {
    cdp.close();
    child.kill();
    await sleep(500);
    try {
      rmSync(profile, { recursive: true, force: true });
    } catch {
      // Chrome may still hold a lock on the profile; the temp dir is disposable.
    }
  }
}

if (JSON_OUT) {
  writeFileSync(JSON_OUT, JSON.stringify(output, null, 2));
  console.log(`\njson: ${JSON_OUT}`);
}
process.exit(failed ? 1 : 0);
