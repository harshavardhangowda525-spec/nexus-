#!/usr/bin/env node
// DEVELOPMENT / TEST ONLY. A scripted, OpenAI-compatible model server.
// It lets the full NEXUS pipeline (planning, real Docker sandboxes, real browser,
// approvals, events, UI) run end to end without an API key. Its "decisions" are a
// fixed script per agent; it is not an AI model. Configure it in NEXUS as an
// "OpenAI-compatible" credential with base URL http://127.0.0.1:4010/v1.
import http from 'node:http';

const PORT = Number(process.env.MOCK_LLM_PORT || 4010);
const DELAY = Number(process.env.MOCK_LLM_DELAY_MS || 600);

const call = (id, name, args) => ({ id, name, args });
const lastToolText = (msgs) => [...msgs].reverse().find((m) => m.role === 'tool')?.content ?? '';
const toolText = (msgs, id) => msgs.find((m) => m.role === 'tool' && m.tool_call_id === id)?.content ?? '';

const SITE_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Kinetic Physio — Back to moving, sooner</title>
  <link rel="stylesheet" href="styles.css">
</head>
<body>
  <header class="hero">
    <nav><strong>Kinetic Physio</strong><a href="#book" class="cta">Book online</a></nav>
    <h1>Back to moving, sooner.</h1>
    <p>Sports injuries, back pain and post-surgery rehab with registered physiotherapists.</p>
    <a href="#book" class="cta big">Book an assessment</a>
  </header>
  <section class="services">
    <article><h2>Sports injuries</h2><p>Assessment, hands-on treatment and a return-to-sport plan.</p></article>
    <article><h2>Back &amp; neck pain</h2><p>Evidence-based care for desk workers and long-term pain.</p></article>
    <article><h2>Post-surgery rehab</h2><p>ACL, hip and shoulder programs with clear milestones.</p></article>
  </section>
  <section id="book" class="book">
    <h2>Book an assessment</h2>
    <form id="booking">
      <label>Name <input name="name" required></label>
      <label>Phone <input name="phone" required placeholder="+61 400 123 456"></label>
      <button>Request booking</button>
      <p id="msg" role="status"></p>
    </form>
  </section>
  <script type="module">
    import { validPhone } from './booking.js';
    document.getElementById('booking').addEventListener('submit', (e) => {
      e.preventDefault();
      const phone = new FormData(e.target).get('phone');
      document.getElementById('msg').textContent = validPhone(String(phone)) ? 'Thanks! We will call you to confirm.' : 'Please enter a valid phone number.';
    });
  </script>
</body>
</html>
`;
const SITE_CSS = `:root{--ink:#0d1b2a;--teal:#1b998b;--sand:#f6f3ee}
*{box-sizing:border-box}body{margin:0;font-family:system-ui,sans-serif;color:var(--ink);background:var(--sand)}
.hero{padding:32px 24px 64px;background:linear-gradient(135deg,#0d1b2a,#1b998b);color:#fff}
nav{display:flex;justify-content:space-between;align-items:center;max-width:960px;margin:0 auto 48px}
h1{font-size:clamp(32px,6vw,56px);max-width:960px;margin:0 auto 12px}.hero p{max-width:960px;margin:0 auto 24px;font-size:18px}
.cta{background:#fff;color:var(--ink);padding:10px 16px;border-radius:999px;text-decoration:none;font-weight:600}.cta.big{display:inline-block;margin-left:max(0px,calc(50% - 480px))}
.services{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:16px;max-width:960px;margin:-32px auto 32px;padding:0 24px}
article{background:#fff;border-radius:16px;padding:20px;box-shadow:0 10px 30px -15px rgba(0,0,0,.3)}
.book{max-width:960px;margin:0 auto 64px;padding:0 24px}form{display:grid;gap:12px;max-width:420px}
input{width:100%;padding:10px;border:1px solid #ccc;border-radius:8px}button{padding:12px;border:0;border-radius:8px;background:var(--teal);color:#fff;font-weight:600}
`;
const BUGGY_JS = `// Phone validation for the booking form.
export function validPhone(s) {
  const digits = s.replace(/[\\s()-]/g, '');
  return /^\\d{8,15}$/.test(digits);
}
`;
const FIXED_JS = `// Phone validation for the booking form. Accepts an optional leading + country code.
export function validPhone(s) {
  const digits = s.replace(/[\\s()-]/g, '');
  return /^\\+?\\d{8,15}$/.test(digits);
}
`;
const TEST_JS = `import test from 'node:test';
import assert from 'node:assert/strict';
import { validPhone } from './booking.js';

test('accepts local numbers', () => assert.equal(validPhone('0400 123 456'), true));
test('accepts international numbers', () => assert.equal(validPhone('+61 400 123 456'), true));
test('rejects letters', () => assert.equal(validPhone('call me'), false));
test('rejects short numbers', () => assert.equal(validPhone('123'), false));
`;

// Each script is a list of [id, when(history), action(history)] steps; the first not yet done runs.
const scripts = {
  scout: [
    ['s1', () => true, () => call('s1', 'search_web', { query: 'physiotherapy clinic website online booking best practices' })],
    ['s2', () => true, () => call('s2', 'browse', { url: 'https://en.wikipedia.org/wiki/Physical_therapy' })],
    ['s3', () => true, () => call('s3', 'screenshot', { path: 'research/shots/physical-therapy.png' })],
    ['s4', () => true, (m) => {
      const page = toolText(m, 's2');
      const title = (page.match(/Title: (.*)/) || [])[1] || 'unknown';
      const search = toolText(m, 's1');
      const hits = (search.match(/^\d+\. /gm) || []).length;
      return call('s4', 'write_file', { path: 'research/findings.md', content: `# Physiotherapy website research\n\n## Findings\n- Patients look for online booking, clear services and practitioner credentials.\n- Reference page read: "${title}".\n- Search returned ${hits} results for clinic website practices.\n\n## Sources\n- https://en.wikipedia.org/wiki/Physical_therapy\n` });
    }],
    ['s5', () => true, () => call('s5', 'send_message', { to: 'forge', message: 'research/findings.md is ready: put booking first and show credentials.' })],
    ['s6', () => true, () => call('s6', 'complete_task', { summary: 'Researched clinic website practices; wrote research/findings.md and a screenshot in research/shots/.' })],
  ],
  forge: [
    ['f1', () => true, () => call('f1', 'run_command', { command: 'node --version && git --version && whoami' })],
    ['f2', () => true, () => call('f2', 'read_file', { path: 'research/findings.md' })],
    ['f3', () => true, () => call('f3', 'write_file', { path: 'site/index.html', content: SITE_HTML })],
    ['f4', () => true, () => call('f4', 'write_file', { path: 'site/styles.css', content: SITE_CSS })],
    ['f5', () => true, () => call('f5', 'write_file', { path: 'site/booking.js', content: BUGGY_JS })],
    ['f6', () => true, () => call('f6', 'write_file', { path: 'site/booking.test.js', content: TEST_JS })],
    ['f7', () => true, () => call('f7', 'run_command', { command: 'cd site && node --test 2>&1' })],
    ['f8', (m) => /exit code [1-9]/.test(toolText(m, 'f7')), () => call('f8', 'write_file', { path: 'site/booking.js', content: FIXED_JS })],
    ['f9', (m) => /exit code [1-9]/.test(toolText(m, 'f7')), () => call('f9', 'run_command', { command: 'cd site && node --test 2>&1' })],
    ['f10', () => true, () => call('f10', 'run_command', { command: "git init -q 2>/dev/null; git add -A && git -c user.email=forge@nexus.local -c user.name=FORGE commit -qm 'Kinetic Physio website' && git log --oneline | head -3" })],
    ['f11', () => true, () => call('f11', 'complete_task', { summary: 'Built the clinic website in site/ (index.html, styles.css, booking.js); fixed a phone validation bug; 4 tests pass.' })],
  ],
  pulse: [
    ['p1', () => true, () => call('p1', 'read_file', { path: 'research/findings.md' })],
    ['p2', () => true, () => call('p2', 'write_file', { path: 'marketing/strategy.md', content: '# Marketing strategy\n\nPositioning: "Back to moving, sooner."\n\nChannels: Google Business Profile, Instagram reels, GP referrals.\n\nOutreach drafts are in this folder; nothing has been sent.\n' })],
    ['p3', () => true, () => call('p3', 'write_file', { path: 'marketing/calendar.csv', content: 'week,channel,post\n1,Instagram,Desk posture in 60 seconds\n1,Google,Online booking is live\n2,Instagram,ACL rehab milestones\n' })],
    ['p4', () => true, () => call('p4', 'complete_task', { summary: 'Wrote marketing/strategy.md and marketing/calendar.csv.' })],
  ],
  ledger: [
    ['l1', () => true, () => call('l1', 'write_file', { path: 'ops/milestones.md', content: '# Milestones\n\n- M1 Discovery: week 1\n- M2 Design and build: weeks 2-3\n- M3 Launch and campaign: week 4\n' })],
    ['l2', () => true, () => call('l2', 'request_approval', { action: 'send_email', summary: 'Send the kickoff email to Kinetic Physio', details: { to: 'client@kinetic-physio.example', subject: 'Kickoff: website and launch plan', body: 'Hi team, here are our three milestones...' } })],
    ['l3', () => true, (m) => call('l3', 'write_file', { path: 'ops/kickoff-log.md', content: `# Kickoff email\n\nDecision: ${/APPROVED/.test(toolText(m, 'l2')) ? 'approved by the CEO; stored in the outbox for sending' : 'declined by the CEO; not sent'}.\n` })],
    ['l4', () => true, () => call('l4', 'complete_task', { summary: 'Wrote ops/milestones.md and ops/kickoff-log.md; kickoff email went through CEO approval.' })],
  ],
  atlas: [
    ['a1', () => true, () => call('a1', 'list_files', {})],
    ['a2', () => true, () => call('a2', 'read_file', { path: 'research/findings.md' })],
    ['a3', () => true, (m) => call('a3', 'write_file', { path: 'report.md', content: `# Mission report\n\n## Delivered\n${toolText(m, 'a1').split('\n').filter((l) => !l.endsWith('/')).map((l) => `- ${l}`).join('\n')}\n\n## Next steps\n- Review the site preview and the approved kickoff email in the outbox.\n` })],
    ['a4', () => true, () => call('a4', 'complete_task', { summary: 'Reviewed all deliverables and wrote report.md.' })],
  ],
};

function plan(userText) {
  const avail = ((userText.match(/Available specialists: ([^\n]*)/) || [])[1] || '').toLowerCase();
  const has = (a) => avail.includes(a);
  const tasks = [
    has('scout') && { key: 'T1', title: 'Research clinic websites', agent: 'scout', deps: [], description: 'Research what patients expect from a physiotherapy clinic website. Write research/findings.md with sources.' },
    has('forge') && { key: 'T2', title: 'Build the clinic website', agent: 'forge', deps: has('scout') ? ['T1'] : [], description: 'Build a premium static website in site/ with online booking and tests for any logic.' },
    has('pulse') && { key: 'T3', title: 'Marketing strategy', agent: 'pulse', deps: has('scout') ? ['T1'] : [], description: 'Write marketing/strategy.md and a 4-week marketing/calendar.csv.' },
    has('ledger') && { key: 'T4', title: 'Milestones and kickoff', agent: 'ledger', deps: [], description: 'Write ops/milestones.md and ask the CEO to approve the kickoff email.' },
  ].filter(Boolean);
  return call('plan', 'submit_plan', { summary: 'Research first, then build and market in parallel while operations sets milestones.', tasks });
}

function respond(body) {
  const msgs = body.messages || [];
  const system = msgs.find((m) => m.role === 'system')?.content || '';
  if (/Status check/.test(msgs[msgs.length - 1]?.content || '')) return { text: 'ready' };
  if (/submit_plan/.test(system) || (body.tools || []).some((t) => t.function?.name === 'submit_plan')) {
    const user = msgs.find((m) => m.role === 'user')?.content || '';
    return { calls: [plan(user)] };
  }
  const agent = (system.match(/You are (ATLAS|FORGE|SCOUT|PULSE|LEDGER)/) || [])[1]?.toLowerCase();
  const script = scripts[agent];
  if (!script) return { text: 'I have no script for this request.' };
  const done = new Set(msgs.filter((m) => m.role === 'assistant').flatMap((m) => (m.tool_calls || []).map((c) => c.id)));
  for (const [id, when, act] of script) {
    if (done.has(id)) continue;
    if (!when(msgs)) continue;
    return { calls: [act(msgs)] };
  }
  return { text: 'Done.' };
}

http.createServer((req, res) => {
  if (req.method === 'GET' && req.url?.endsWith('/models')) {
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: [{ id: 'nexus-mock' }] }));
    return;
  }
  if (req.method !== 'POST' || !req.url?.endsWith('/chat/completions')) { res.writeHead(404).end(); return; }
  let raw = '';
  req.on('data', (d) => (raw += d));
  req.on('end', () => {
    let body;
    try { body = JSON.parse(raw); } catch { res.writeHead(400).end('{"error":"bad json"}'); return; }
    const out = respond(body);
    const promptTokens = Math.ceil(raw.length / 4);
    const message = out.calls
      ? { role: 'assistant', content: null, tool_calls: out.calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } })) }
      : { role: 'assistant', content: out.text };
    const completionTokens = Math.ceil(JSON.stringify(message).length / 4);
    setTimeout(() => {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
        id: 'mock-' + Date.now(), object: 'chat.completion', model: body.model || 'nexus-mock',
        choices: [{ index: 0, message, finish_reason: out.calls ? 'tool_calls' : 'stop' }],
        usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens },
      }));
    }, DELAY);
  });
}).listen(PORT, '127.0.0.1', () => console.log(`[mock-llm] scripted OpenAI-compatible server on http://127.0.0.1:${PORT}/v1 (dev/test only)`));
