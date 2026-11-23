#!/usr/bin/env node
// Milestone 1 spike: answers the risky questions in docs/design.md before
// anything else is built. Run it on the Mac, against a small one-off Takeout.
// It never prints the download link, cookies, or file names: the report at
// the end is safe to paste.

import { chromium } from "playwright-core";
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { readZipInfo } from "./zipinfo.mjs";

const opts = parseArgs(process.argv.slice(2));
const CHROME = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const OUT = join(process.cwd(), "spike-output");
mkdirSync(OUT, { recursive: true });

const started = Date.now();
const report = {
  spikeVersion: 2,
  startedAt: new Date(started).toISOString(),
  node: process.version,
  platform: `${process.platform} ${process.arch}`,
};

process.on("SIGINT", () => {
  report.interrupted = true;
  finish(130);
});

try {
  await main();
  finish(0);
} catch (err) {
  report.error = String(err?.message || err).split("\n")[0];
  log(`Stopped: ${report.error}`);
  finish(1);
}

async function main() {
  // 1. Start the user's own Chrome with a separate profile, then attach.
  if (!existsSync(CHROME)) throw new Error(`Chrome not found at ${CHROME}. Set CHROME_PATH to its executable.`);
  const profileDir = join(homedir(), ".takeout-backup-spike", `profile-${opts.profile}`);
  mkdirSync(profileDir, { recursive: true });
  spawn(CHROME, [
    `--remote-debugging-port=${opts.port}`,
    `--user-data-dir=${profileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "about:blank",
  ], { stdio: "ignore", detached: true }).unref();

  let version = null;
  for (let i = 0; i < 60 && !version; i++) {
    version = await fetch(`http://127.0.0.1:${opts.port}/json/version`).then((r) => r.json()).catch(() => null);
    if (!version) await sleep(500);
  }
  if (!version) throw new Error("Chrome didn't open its debugging port. Quit any Chrome window from an earlier spike run and try again.");
  report.chrome = version.Browser;

  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${opts.port}`);
  const context = browser.contexts()[0];
  const page = context.pages()[0] ?? (await context.newPage());

  // 2. Sign in if needed.
  log("Opening Takeout in a separate Chrome window…");
  await page.goto("https://takeout.google.com/manage", { waitUntil: "domcontentloaded" });
  await page.bringToFront();
  report.signIn = { neededSignIn: false, blockedMessageSeen: false };
  const signInStart = Date.now();
  let toldUser = false;
  while (!page.url().startsWith("https://takeout.google.com/")) {
    const host = safeHost(page.url());
    if (host === "accounts.google.com") {
      report.signIn.neededSignIn = true;
      if (!toldUser) {
        log("Sign in to Google in that Chrome window, as the account that made the test export. I'll wait.");
        toldUser = true;
      }
      const text = await page.locator("body").innerText({ timeout: 2000 }).catch(() => "");
      if (!report.signIn.blockedMessageSeen && /browser or app may not be secure|couldn.t sign you in/i.test(text)) {
        report.signIn.blockedMessageSeen = true;
        log("Google is refusing to sign in to this browser. That's the main thing this spike checks. Press Ctrl-C and paste me the report.");
      }
    } else if (host && host !== "takeout.google.com") {
      await page.goto("https://takeout.google.com/manage", { waitUntil: "domcontentloaded" }).catch(() => {});
    }
    if (Date.now() - signInStart > 15 * 60_000) throw new Error("Timed out waiting for sign-in.");
    await sleep(2000);
  }
  report.signIn.waitedSeconds = Math.round((Date.now() - signInStart) / 1000);
  log("Signed in. Looking at your exports…");

  // 3. Inspect the Manage exports page.
  let { anchors, anchorCount, summary } = await inspectPage(page, "manage-page");
  const archiveLinks = page.locator('a[href*="/manage/archive/"]');
  report.managePage = { ...summary, archiveLinkCount: await archiveLinks.count() };

  // The Download buttons may live on each export's own page instead.
  if (anchorCount === 0 && (opts.archiveUrl || report.managePage.archiveLinkCount > 0)) {
    const target = opts.archiveUrl ?? new URL(await archiveLinks.first().getAttribute("href"), page.url()).toString();
    log("Opening the export's own page…");
    await page.goto(target, { waitUntil: "domcontentloaded" });
    ({ anchors, anchorCount, summary } = await inspectPage(page, "archive-page"));
    report.archivePage = { openedFrom: opts.archiveUrl ? "--archive-url" : "first archive link", ...summary };
  }

  // 4. Press Download and capture the link, cancelling the local download.
  // The browser's download event is the source of truth. Google's own
  // background requests (/_/…) are also labelled as attachments, so the
  // response sniff below ignores them and only serves as a fallback.
  const captured = { downloadUrl: null, sniffUrl: null, suggestedFilename: null, cancelled: false, reauthSeen: false, contentLength: null };
  const navRequests = []; // document/other requests after the click, for the report
  const requestByUrl = new Map();
  let clicked = false;
  const attach = (p) =>
    p.on("download", async (d) => {
      captured.downloadUrl ??= d.url();
      captured.suggestedFilename ??= d.suggestedFilename();
      await d.cancel().then(() => (captured.cancelled = true)).catch(() => {});
    });
  context.pages().forEach(attach);
  context.on("page", attach);
  context.on("request", (req) => {
    const type = req.resourceType();
    if (!clicked || (type !== "document" && type !== "other")) return;
    requestByUrl.set(req.url(), req);
    if (navRequests.length < 15) navRequests.push(`${type}: ${redactUrl(req.url())}`);
  });
  context.on("response", (resp) => {
    const url = resp.url();
    if (safeHost(url) === "accounts.google.com" && /challenge|signin|reauth/i.test(url)) captured.reauthSeen = true;
    const type = resp.request().resourceType();
    if (type !== "document" && type !== "other") return;
    if (safePath(url).startsWith("/_/")) return;
    const h = resp.headers();
    const zipish = /zip|octet-stream/i.test(h["content-type"] || "") || /\.zip/i.test(h["content-disposition"] || "") || /\.zip$/i.test(safePath(url));
    if (zipish && resp.status() < 300) {
      captured.sniffUrl ??= url;
      captured.contentLength ??= Number(h["content-length"]) || null;
    }
  });

  const clickStart = Date.now();
  clicked = true;
  if (anchorCount > 0) {
    log("Pressing Download on the first part of your newest export…");
    await anchors.first().click();
    report.clickedBy = "script";
  } else {
    log("I couldn't find the Download buttons. In the Chrome window, press Download on part 1 of your newest export.");
    report.clickedBy = "you";
  }
  log("If Google asks for your password, enter it in the Chrome window.");
  while (!captured.downloadUrl && !captured.sniffUrl && Date.now() - clickStart < 5 * 60_000) await sleep(500);
  const seconds = Math.round((Date.now() - clickStart) / 1000);
  // Give the download event a moment to arrive if only the sniff fired.
  for (let i = 0; i < 10 && !captured.downloadUrl; i++) await sleep(500);
  await sleep(1500); // let the cancel settle
  const url = captured.downloadUrl ?? captured.sniffUrl;
  report.capture = {
    method: captured.downloadUrl ? "download-event" : captured.sniffUrl ? "response-sniff" : "none",
    secondsToCapture: seconds,
    reauthSeen: captured.reauthSeen,
    localDownloadCancelled: captured.cancelled,
    sniffAgreesWithDownloadEvent: captured.downloadUrl && captured.sniffUrl ? captured.downloadUrl === captured.sniffUrl : null,
    sizeFromBrowserHeaders: captured.contentLength,
    urlShape: url ? redactUrl(url) : null,
    filenameShape: captured.suggestedFilename ? captured.suggestedFilename.replace(/\d/g, "9") : null,
    navigationAfterClick: navRequests,
  };
  if (!url) throw new Error("No download started within 5 minutes.");
  const req = requestByUrl.get(url);
  if (req) {
    report.capture.cookieHeaderSent = await req.allHeaders().then((h) => "cookie" in h).catch(() => null);
    const chain = [];
    for (let r = req.redirectedFrom(); r && chain.length < 10; r = r.redirectedFrom()) chain.unshift(redactUrl(r.url()));
    report.capture.redirectChain = chain;
  }
  log(`Captured the download link (${report.capture.method}).`);

  // 5. AWS CloudShell test command (contains the private link: never share it).
  const curl = `curl -sS -r 0-1023 -o /dev/null -w 'cloudshell: status=%{http_code} bytes=%{size_download} type=%{content_type}\\n' '${url}'`;
  writeFileSync(join(OUT, "cloudshell-command.LOCAL-ONLY.txt"), curl + "\n");
  console.log(`
---------------------------------------------------------------------------
Do this now, while the link is fresh:
  1. In the AWS console, switch the region to London (eu-west-2) and open CloudShell.
  2. Paste the command below into CloudShell and press Enter. (It's also saved in
     spike-output/cloudshell-command.LOCAL-ONLY.txt.)
  3. Send Claude ONLY the one line it prints, starting "cloudshell:".
     Don't send the command itself: it contains a private link to your data.

${curl}
---------------------------------------------------------------------------
`);

  // 6. Can the link be fetched without the browser's cookies, with ranges?
  const { total, headers } = await testRanges(url, context);
  await browser.close().catch(() => {}); // disconnects; leaves the Chrome window open
  log("You can close the Chrome window now. The rest runs from this terminal.");

  // 7. Read the zip's table of contents with ranged reads only.
  if (total && headers) {
    try {
      report.zip = await readZipInfo(async (start, end) => {
        const r = await rangeGet(url, start, end, headers);
        if (r.status !== 206) throw new Error(`ranged read returned HTTP ${r.status}`);
        return r.buf;
      }, total);
      log(`Read the zip's table of contents: ${report.zip.files} files.`);
    } catch (err) {
      report.zip = { error: String(err.message) };
    }
  }

  // 8. Link lifetime, and whether a slow download outlives it, in parallel.
  log(`Now checking every minute how long the link keeps working (up to ${opts.lifetimeMinutes} minutes).`);
  log("Leave this running, or press Ctrl-C at any point: the report prints either way.");
  if (!headers) return;
  await Promise.all([lifetimeTest(url, headers), slowDownloadTest(url, headers, total)]);
}

async function inspectPage(page, name) {
  await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => {});
  await sleep(2000);
  const all = page.locator('a[href*="takeout/download"]');
  const anchors = page.locator('a[href*="takeout/download"]:visible');
  const anchorCount = await anchors.count();
  // a.href is the address the browser will actually use (it respects <base>).
  const firstHref = anchorCount ? await anchors.first().evaluate((a) => a.href).catch(() => null) : null;
  const summary = {
    pathShape: safePath(page.url()).replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, "<id>"),
    downloadLinkCount: await all.count(),
    visibleDownloadLinkCount: anchorCount,
    downloadButtonTextCount: await page.getByText(/^\s*Download\s*$/i).count().catch(() => null),
    hrefShape: firstHref ? redactUrl(firstHref) : null,
  };
  // Kept on the Mac only: these show your account and export list.
  writeFileSync(join(OUT, `${name}.LOCAL-ONLY.html`), await page.content());
  await page.screenshot({ path: join(OUT, `${name}.LOCAL-ONLY.png`), fullPage: true }).catch(() => {});
  const aria = await page.locator("body").ariaSnapshot().catch(() => null);
  if (aria) writeFileSync(join(OUT, `${name}.LOCAL-ONLY.aria.yml`), aria);
  return { anchors, anchorCount, summary };
}

async function testRanges(url, context) {
  // Returns the headers that worked (never written to the report), or null.
  const a = await rangeGet(url, 0, 1023).catch((e) => ({ error: String(e.message) }));
  report.rangeNoCookies = summarise(a);
  if (isGood(a)) {
    report.headersNeeded = "none";
    report.totalBytes = parseTotal(a);
    return { total: report.totalBytes, headers: {} };
  }
  const cookies = await context.cookies([url]).catch(() => []);
  const cookie = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
  const b = await rangeGet(url, 0, 1023, { Cookie: cookie }).catch((e) => ({ error: String(e.message) }));
  report.rangeWithCookies = summarise(b);
  if (isGood(b)) {
    report.headersNeeded = "cookies";
    report.totalBytes = parseTotal(b);
    return { total: report.totalBytes, headers: { Cookie: cookie } };
  }
  report.headersNeeded = "none-worked";
  return { total: null, headers: null };
}

async function lifetimeTest(url, headers) {
  const t = { checksEveryMinutes: 1, transitions: [], lastOkMinute: 0, firstFailureMinute: null };
  report.lifetime = t;
  let last = null;
  let failuresInARow = 0;
  for (let m = 1; m <= opts.lifetimeMinutes; m++) {
    await sleep(60_000);
    const r = await rangeGet(url, 0, 0, headers).catch((e) => ({ error: String(e.message) }));
    const ok = isGood(r);
    const status = r.error ? `error: ${r.error}` : `HTTP ${r.status}`;
    if (status !== last) t.transitions.push({ minute: m, status });
    last = status;
    if (ok) {
      t.lastOkMinute = m;
      failuresInARow = 0;
    } else {
      failuresInARow++;
      t.firstFailureMinute ??= m;
    }
    log(`Link check at ${m} min: ${ok ? "still works" : "failed"} (${status}).`);
    saveReport();
    if (failuresInARow >= 3) break;
  }
}

async function slowDownloadTest(url, headers, total) {
  if (!total || total < 50e6) {
    report.slowDownload = { skipped: `part is ${total ? (total / 1e6).toFixed(1) + " MB" : "of unknown size"}; this test needs at least 50 MB` };
    return;
  }
  const seconds = Math.min(25 * 60, opts.lifetimeMinutes * 60);
  const rate = total / seconds; // bytes per second, so the download spans ~25 minutes
  const s = { targetMinutes: Math.round(seconds / 60), startedAtMinute: minutesSinceStart() };
  report.slowDownload = s;
  try {
    const res = await fetch(url, { headers });
    s.status = res.status;
    const reader = res.body.getReader();
    const t0 = Date.now();
    let received = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.length;
      const ahead = (received / rate) * 1000 - (Date.now() - t0);
      if (ahead > 0) await sleep(ahead);
    }
    s.bytes = received;
    s.completed = received === total;
  } catch (err) {
    s.error = String(err.message);
  }
  s.finishedAtMinute = minutesSinceStart();
  log(`Slow download ${s.completed ? "finished complete" : "did not finish"} at ${s.finishedAtMinute} min.`);
}

async function rangeGet(url, start, end, headers = {}) {
  const controller = new AbortController();
  const res = await fetch(url, { headers: { Range: `bytes=${start}-${end}`, ...headers }, signal: controller.signal });
  const limit = end - start + 1;
  const chunks = [];
  let got = 0;
  const reader = res.body?.getReader();
  while (reader && got < limit) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.length;
  }
  if (reader && got >= limit) await reader.cancel().catch(() => controller.abort());
  return {
    status: res.status,
    contentType: res.headers.get("content-type"),
    contentRange: res.headers.get("content-range"),
    acceptRanges: res.headers.get("accept-ranges"),
    contentLength: res.headers.get("content-length"),
    redirected: res.redirected,
    finalHost: safeHost(res.url),
    buf: Buffer.concat(chunks).subarray(0, limit),
  };
}

function isGood(r) {
  return !r.error && (r.status === 206 || r.status === 200) && !/text\/html/i.test(r.contentType || "");
}

function summarise(r) {
  if (r.error) return { error: r.error };
  const { buf, ...rest } = r;
  return { ...rest, bytesReceived: buf.length, startsWithZipHeader: buf.length >= 4 && buf.readUInt32LE(0) === 0x04034b50 };
}

function parseTotal(r) {
  const m = /\/(\d+)\s*$/.exec(r?.contentRange || "");
  if (m) return Number(m[1]);
  if (r?.status === 200 && r.contentLength) return Number(r.contentLength);
  return null;
}

function redactUrl(u) {
  try {
    const url = new URL(u);
    const params = [...url.searchParams.keys()].map((k) => `${k}=<${url.searchParams.get(k).length} chars>`);
    return `${url.protocol}//${url.host}${url.pathname}${params.length ? "?" + params.join("&") : ""}`;
  } catch {
    return "<unparseable>";
  }
}

function safeHost(u) {
  try { return new URL(u).host; } catch { return null; }
}

function safePath(u) {
  try { return new URL(u).pathname; } catch { return ""; }
}

function minutesSinceStart() {
  return Math.round((Date.now() - started) / 6000) / 10;
}

function log(msg) {
  console.log(`[${minutesSinceStart().toFixed(1)} min] ${msg}`);
}

function saveReport() {
  writeFileSync(join(OUT, "report.json"), JSON.stringify(report, null, 2));
}

function finish(code) {
  saveReport();
  console.log("\n===== Send Claude everything between these lines =====");
  console.log(JSON.stringify(report, null, 2));
  console.log("===== End =====");
  console.log("Also send the one 'cloudshell:' line, if you ran it.");
  process.exit(code);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function parseArgs(argv) {
  const o = { profile: "me", port: 9333, lifetimeMinutes: 90, archiveUrl: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--profile") o.profile = argv[++i];
    else if (argv[i] === "--archive-url") o.archiveUrl = argv[++i];
    else if (argv[i] === "--port") o.port = Number(argv[++i]);
    else if (argv[i] === "--minutes") o.lifetimeMinutes = Number(argv[++i]);
  }
  return o;
}
