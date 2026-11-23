// Runs INSIDE the browser sandbox container. Speaks newline-delimited JSON:
//   stdin:  {"id":1,"cmd":"goto","args":{"url":"https://..."}}
//   stdout: {"id":1,"ok":true,"result":{...}}  |  {"type":"frame","data":"<jpeg b64>","url":"..."}
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { chromium } from 'playwright-core';

const send = (m) => process.stdout.write(JSON.stringify(m) + '\n');
const TIMEOUT = Number(process.env.NAV_TIMEOUT_MS || 30000);

// Trust an extra CA (e.g. a TLS-inspecting egress proxy) by installing the NSS db the host prepared.
if (fs.existsSync('/nssdb/cert9.db')) {
  const dst = path.join(process.env.HOME || '/tmp/home', '.pki', 'nssdb');
  fs.mkdirSync(dst, { recursive: true });
  for (const f of fs.readdirSync('/nssdb')) fs.copyFileSync(path.join('/nssdb', f), path.join(dst, f));
}

const proxy = process.env.PROXY_SERVER
  ? { server: process.env.PROXY_SERVER, username: process.env.PROXY_USER, password: process.env.PROXY_PASS }
  : undefined;

const browser = await chromium.launch({ proxy, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const context = await browser.newContext({
  viewport: { width: 1280, height: 800 },
  acceptDownloads: false,
  userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) NexusScout/0.1 Chrome/131 Safari/537.36',
});
const page = await context.newPage();
let busy = false;

function checkUrl(u) {
  const url = new URL(u);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('only http(s) URLs are allowed');
  return url.toString();
}

async function snapshot() {
  return page.evaluate(() => {
    const text = (document.body?.innerText || '').replace(/\n{3,}/g, '\n\n').replace(/[ \t]{2,}/g, ' ').trim();
    const links = Array.from(document.querySelectorAll('a[href]')).slice(0, 60)
      .map((a) => ({ text: (a.textContent || '').trim().slice(0, 100), href: a.href }))
      .filter((l) => l.text && l.href.startsWith('http'));
    return { title: document.title, text: text.slice(0, 15000), textLength: text.length, links: links.slice(0, 40) };
  });
}

const handlers = {
  async goto({ url }) {
    const resp = await page.goto(checkUrl(url), { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
    await page.waitForTimeout(700);
    return { url: page.url(), status: resp?.status() ?? null, ...(await snapshot()) };
  },
  async search({ query }) {
    // DuckDuckGo's HTML endpoint first, Bing as a fallback. Both can refuse automated traffic.
    const engines = [
      { url: 'https://html.duckduckgo.com/html/?q=', item: '.result', link: 'a.result__a', snippet: '.result__snippet', param: 'uddg' },
      { url: 'https://www.bing.com/search?q=', item: 'li.b_algo', link: 'h2 a', snippet: '.b_caption p, p', param: null },
    ];
    for (const e of engines) {
      try {
        await page.goto(e.url + encodeURIComponent(query), { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
        await page.waitForTimeout(600);
        const results = await page.evaluate((e) => Array.from(document.querySelectorAll(e.item)).slice(0, 10).map((r) => {
          const a = r.querySelector(e.link);
          let href = a?.getAttribute('href') || '';
          try {
            const u = new URL(href, location.href);
            href = (e.param && u.searchParams.get(e.param)) || u.toString();
            // Bing wraps results as /ck/a?...&u=a1<base64url(url)>
            const bu = u.hostname.endsWith('bing.com') && u.searchParams.get('u');
            if (bu && bu.startsWith('a1')) href = atob(bu.slice(2).replace(/-/g, '+').replace(/_/g, '/'));
          } catch {}
          return { title: (a?.textContent || '').trim(), url: href, snippet: (r.querySelector(e.snippet)?.textContent || '').trim().slice(0, 300) };
        }).filter((x) => x.title && x.url.startsWith('http')), e);
        if (results.length) return { url: page.url(), engine: new URL(e.url).hostname, results };
      } catch { /* try the next engine */ }
    }
    return { url: page.url(), results: [], note: 'No results could be read; search engines may be blocking automated access. Browse a known URL instead.' };
  },
  async screenshot() {
    const png = await page.screenshot({ type: 'png' });
    return { url: page.url(), png: png.toString('base64') };
  },
};

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', async (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  const h = handlers[msg.cmd];
  if (!h) return send({ id: msg.id, ok: false, error: `unknown command ${msg.cmd}` });
  busy = true;
  try { send({ id: msg.id, ok: true, result: await h(msg.args || {}) }); }
  catch (e) { send({ id: msg.id, ok: false, error: String(e?.message || e).split('\n')[0] }); }
  finally { busy = false; }
});
rl.on('close', async () => { await browser.close().catch(() => {}); process.exit(0); });

// Live view: a small JPEG of the viewport about once a second.
setInterval(async () => {
  if (busy || page.url() === 'about:blank') return;
  try {
    const jpg = await page.screenshot({ type: 'jpeg', quality: 45, scale: 'css', clip: { x: 0, y: 0, width: 1280, height: 800 } });
    send({ type: 'frame', data: jpg.toString('base64'), url: page.url() });
  } catch { /* page navigating */ }
}, 1000);

send({ type: 'ready' });
