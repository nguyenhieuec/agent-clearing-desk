// Agent Clearing Desk browser UI. Plain DOM, no framework.
// Every value from the API goes into the page through textContent (see el()), never innerHTML,
// because receipts and audit rows carry agent-supplied arguments.

const $ = id => document.getElementById(id);
const ORIGIN = location.origin;

// ---------- DOM and formatting helpers ----------

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = String(v);
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

/** Cents (may be fractional, e.g. 0.025) as USD with up to 5 decimals and at least 2. */
function usd(cents) {
  if (cents === null || cents === undefined || Number.isNaN(Number(cents))) return '-';
  const n = Number(cents) / 100;
  const sign = n < 0 ? '-' : '';
  let s = Math.abs(n).toFixed(5).replace(/0+$/, '');
  const [whole, frac = ''] = s.split('.');
  s = `${whole}.${frac.padEnd(2, '0')}`;
  return `${sign}$${s}`;
}

const mcUsd = mc => usd(Number(mc) / 1000);

function when(ms) {
  if (!ms) return '-';
  const d = new Date(ms);
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function expiry(ms) {
  if (!ms) return 'never';
  const mins = Math.round((ms - Date.now()) / 60000);
  if (mins <= 0) return 'expired';
  if (mins < 120) return `in ${mins} min`;
  if (mins < 2880) return `in ${Math.round(mins / 60)} h`;
  return `in ${Math.round(mins / 1440)} d`;
}

function duration(ms) {
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
}

function dot(word, tone) {
  return el('span', { class: `st ${tone || ''}`, text: word });
}

const STATUS_TONE = { success: 'ok', active: 'ok', refused_allowlist: 'bad', refused_budget: 'bad', upstream_error: 'bad', revoked: 'bad' };
const statusDot = s => dot(s, STATUS_TONE[s] || '');

function httpCode(status) {
  return el('span', { class: `http ${status >= 200 && status < 300 ? 'code-ok' : 'code-bad'}`, text: status || 'ERR' });
}

function short(text, n = 22) {
  const s = String(text ?? '');
  return s.length > n ? `${s.slice(0, n)}...` : s;
}

function pretty(value, max = 8000) {
  const s = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return s && s.length > max ? `${s.slice(0, max)}\n... (${s.length - max} more characters)` : s;
}

async function copyText(text, btn) {
  try {
    await navigator.clipboard.writeText(text);
    if (btn) flashButton(btn, 'Copied');
  } catch {
    if (btn) flashButton(btn, 'Copy failed');
  }
}

function flashButton(btn, label) {
  const old = btn.textContent;
  btn.textContent = label;
  setTimeout(() => { btn.textContent = old; }, 1200);
}

function copyButton(getText, label = 'Copy') {
  const b = el('button', { class: 'btn tiny ghost', type: 'button', text: label });
  b.addEventListener('click', () => copyText(getText(), b));
  return b;
}

// ---------- HTTP ----------

const CLEARING_HEADERS = ['x-clearing-receipt', 'x-clearing-signature', 'x-clearing-price-cents', 'x-clearing-remaining-budget-cents'];

/** One real request; returns everything the step log shows. Never throws. */
async function call(method, path, { body, key, admin } = {}) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (key) headers['x-api-key'] = key;
  if (admin) headers.authorization = `Bearer ${admin}`;
  const started = performance.now();
  const out = { method, path, sent: body, status: 0, body: null, headers: {}, ms: 0, error: null };
  try {
    const res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    out.status = res.status;
    for (const h of CLEARING_HEADERS) {
      const v = res.headers.get(h);
      if (v !== null) out.headers[h] = v;
    }
    const text = await res.text();
    try { out.body = text ? JSON.parse(text) : null; } catch { out.body = { raw: text.slice(0, 2000) }; }
  } catch (err) {
    out.error = String(err && err.message ? err.message : err);
  }
  out.ms = Math.round(performance.now() - started);
  return out;
}

const errCode = r => r.body && r.body.error && r.body.error.code;
const errMsg = r => (r.body && r.body.error && r.body.error.message) || r.error || `HTTP ${r.status}`;

// ---------- Offline receipt verification (runs in this browser only) ----------

let publicKeyPromise = null;

function loadPublicKey() {
  if (!publicKeyPromise) {
    publicKeyPromise = fetch('/.well-known/receipt-signing-key.json')
      .then(r => r.json())
      .then(async doc => {
        const jwk = doc.keys[0];
        const key = await crypto.subtle.importKey('jwk', { kty: 'OKP', crv: 'Ed25519', x: jwk.x }, { name: 'Ed25519' }, false, ['verify']);
        return { key, kid: jwk.kid, x: jwk.x };
      });
    publicKeyPromise.catch(() => { publicKeyPromise = null; });
  }
  return publicKeyPromise;
}

function fromBase64Url(text) {
  const b64 = text.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  return Uint8Array.from(bin, c => c.charCodeAt(0));
}

async function verifyPayload(payload, signature) {
  const pk = await loadPublicKey();
  const ok = await crypto.subtle.verify({ name: 'Ed25519' }, pk.key, fromBase64Url(signature), new TextEncoder().encode(payload));
  return { ok, kid: pk.kid };
}

/** Same payload with amount_mc changed; key order is kept, so only that one value differs. */
function tamper(payload) {
  const obj = JSON.parse(payload);
  const before = obj.amount_mc;
  obj.amount_mc = before === 0 ? 1000 : 0;
  return { text: JSON.stringify(obj), before, after: obj.amount_mc };
}

async function verifyReceipt(receipt) {
  const original = await verifyPayload(receipt.payload, receipt.signature);
  const t = tamper(receipt.payload);
  const tampered = await verifyPayload(t.text, receipt.signature);
  return { original: original.ok, tampered: tampered.ok, kid: original.kid, before: t.before, after: t.after };
}

function verifyResultNode(v) {
  return el('span', { class: 'vres row gap' },
    dot(v.original ? 'Ed25519 signature valid' : 'signature INVALID', v.original ? 'ok' : 'bad'),
    el('span', { class: 'faint', text: `amount_mc ${v.before} to ${v.after}: ${v.tampered ? 'still valid (unexpected)' : 'fails'}` }));
}

function verifyButton(receipt, target) {
  const b = el('button', { class: 'btn tiny', type: 'button', text: 'Verify offline' });
  b.addEventListener('click', async () => {
    b.disabled = true;
    target.replaceChildren(el('span', { class: 'st run', text: 'checking in this browser' }));
    try {
      target.replaceChildren(verifyResultNode(await verifyReceipt(receipt)));
    } catch (err) {
      target.replaceChildren(dot(`could not verify here: ${err.message || err}`, 'bad'));
    }
    b.disabled = false;
  });
  return b;
}

// ---------- Tabs ----------

function selectTab(name) {
  for (const t of ['sandbox', 'console']) {
    const on = t === name;
    $(`tab-${t}`).setAttribute('aria-selected', String(on));
    $(`panel-${t}`).hidden = !on;
  }
  if (name === 'console') consoleOpened();
}

function initTabs() {
  $('tab-sandbox').addEventListener('click', () => selectTab('sandbox'));
  $('tab-console').addEventListener('click', () => selectTab('console'));
  $('link-mcp').addEventListener('click', () => selectTab('sandbox'));
  if (location.hash === '#console') selectTab('console');
}

// ---------- Sandbox key state ----------

const sandbox = { key: null, info: null, balance: null };

function setBalance(b) {
  if (!b || b.budget_cents === undefined) return;
  sandbox.balance = { budget_cents: b.budget_cents, spent_cents: b.spent_cents, remaining_cents: b.remaining_cents, key_id: b.key_id };
  renderBalance();
}

function balanceFrom(r) {
  const b = r.body || {};
  if (b.balance) return b.balance;
  if (b.budget_cents !== undefined) return b;
  if (b.error && b.error.budget_cents !== undefined) return b.error;
  return null;
}

function renderBalance() {
  const box = $('balance');
  if (!sandbox.key || !sandbox.balance) {
    box.replaceChildren(el('p', { class: 'empty', text: 'No sandbox key yet.' }));
    return;
  }
  const { budget_cents: budget, spent_cents: spent, remaining_cents: left } = sandbox.balance;
  const pct = budget > 0 ? Math.min(100, (spent / budget) * 100) : 100;
  const meter = el('div', { class: `meter${left <= 0 ? ' full' : ''}`, role: 'meter', 'aria-valuemin': 0, 'aria-valuemax': budget, 'aria-valuenow': spent, 'aria-label': 'Budget used' },
    el('span', { style: `width:${pct}%` }));
  const info = sandbox.info || {};
  box.replaceChildren(
    meter,
    el('div', { class: 'bal-nums' },
      el('div', {}, el('b', { text: usd(budget) }), el('span', { text: 'budget' })),
      el('div', {}, el('b', { text: usd(spent) }), el('span', { text: 'spent' })),
      el('div', {}, el('b', { class: left <= 0 ? 'code-bad' : 'code-ok', text: usd(left) }), el('span', { text: 'remaining' }))),
    el('div', { class: 'bal-meta' },
      el('span', {}, 'key ', el('code', { text: sandbox.key }), ' ', copyButton(() => sandbox.key)),
      el('span', {}, 'key_id ', el('code', { text: sandbox.balance.key_id || info.key_id || '-' })),
      el('span', { text: `allowlist ${(info.allowlist || []).join(', ') || '-'}` }),
      el('span', { text: `expires ${expiry(info.expires_at)}` })));
  renderMcp();
}

function adoptKey(created) {
  sandbox.key = created.key;
  sandbox.info = created;
  setBalance(created);
  refreshSandboxReceipts();
  refreshSimTools();
}

async function mintSandboxKey() {
  const r = await call('POST', '/api/demo/keys');
  if (r.status === 201) adoptKey(r.body);
  return r;
}

async function refreshSandboxReceipts() {
  const box = $('sandbox-receipts');
  if (!sandbox.key) return;
  const r = await call('GET', '/v1/receipts?limit=50', { key: sandbox.key });
  if (r.status !== 200) {
    box.replaceChildren(el('p', { class: 'empty', text: `GET /v1/receipts returned ${r.status || 'an error'}: ${errMsg(r)}` }));
    return;
  }
  const list = r.body.receipts || [];
  if (!list.length) {
    box.replaceChildren(el('p', { class: 'empty', text: 'No receipts for this key yet.' }));
    return;
  }
  box.replaceChildren(el('ul', { class: 'rlist' }, list.map(receiptListItem)));
}

function receiptListItem(rc) {
  const f = rc.fields || {};
  const result = el('div');
  return el('li', {},
    el('div', { class: 'rl-top' }, el('span', { class: 'rl-id', text: rc.receipt_id }), verifyButton(rc, result)),
    el('div', { class: 'rl-sub' }, statusDot(f.outcome), el('span', { class: 'mono', text: f.tool }),
      el('span', { class: 'num', text: mcUsd(f.amount_mc) }), el('span', { class: 'faint', text: when(f.issued_at) })),
    result);
}

// ---------- Demo steps ----------

const DUTY_ARGS = { lines: [{ description: 'cotton t-shirt', origin: 'CN', qty: 3, unit_value_eur: 25 }], channel: 'ioss' };
const REVIEWS_ARGS = { apps: ['id310633997'], maxReviewsPerApp: 3 };
const VAT_ARGS = { country: 'IE', vatNumber: '6388047V' };

const runTool = (name, args, key) => call('POST', `/v1/tools/${name}/run`, { body: args, key });

/** Facts every tool call shows: what was charged, what is left and which receipt was signed. */
function toolFacts(r) {
  const facts = [];
  const code = errCode(r);
  if (code) facts.push(['error.code', code, 'bad']);
  if (r.headers['x-clearing-price-cents'] !== undefined) facts.push(['charged', `${usd(Number(r.headers['x-clearing-price-cents']))} (x-clearing-price-cents ${r.headers['x-clearing-price-cents']})`]);
  if (r.headers['x-clearing-remaining-budget-cents'] !== undefined) facts.push(['remaining', usd(Number(r.headers['x-clearing-remaining-budget-cents']))]);
  const rid = r.headers['x-clearing-receipt'] || (r.body && r.body.receipt && r.body.receipt.receipt_id);
  if (rid) facts.push(['receipt', rid]);
  return facts;
}

function chargedCents(r) {
  return Number(r.headers['x-clearing-price-cents'] ?? NaN);
}

const DEMO_STEPS = [
  {
    title: 'Mint a sandbox key',
    expect: 'POST /api/demo/keys returns 201 with a 2 cent budget and a 2-tool allowlist.',
    async run(ctx) {
      const r = await call('POST', '/api/demo/keys');
      ctx.addCall(r, r.status === 201 ? [
        ['key', r.body.key], ['key_id', r.body.key_id], ['budget', usd(r.body.budget_cents)],
        ['allowlist', r.body.allowlist.join(', ')], ['expires', expiry(r.body.expires_at)],
        ['sandbox keys left today', r.body.sandbox_keys_left_today],
      ] : [['error.code', errCode(r) || '-', 'bad'], ['message', errMsg(r), 'text']]);
      if (r.status === 201) {
        adoptKey(r.body);
        return { verdict: 'pass' };
      }
      if (r.status === 429) {
        return { verdict: 'stop', note: 'The public sandbox reached its daily key limit (UTC day). The demo stops here; try again after 00:00 UTC.' };
      }
      return { verdict: 'stop', note: `Could not mint a key: ${errMsg(r)}. The demo stops here.` };
    },
  },
  {
    title: 'Allowed tool, within budget',
    expect: 'eu_duty_estimate runs on the real upstream. Expect 200 and 1 cent charged.',
    async run(ctx) {
      const r = await runTool('eu_duty_estimate', DUTY_ARGS, ctx.key);
      ctx.trackBalance(r);
      const facts = toolFacts(r);
      const result = r.body && r.body.result;
      if (r.status === 200 && result) {
        facts.push(['total_duty_eur', `EUR ${result.total_duty_eur}`]);
        const c = result.consignments && result.consignments[0];
        if (c && c.note) facts.push(['upstream says', c.note, 'text']);
      }
      if (r.body && r.body.receipt) ctx.saved.dutyReceipt = r.body.receipt;
      ctx.addCall(r, facts);
      if (r.status === 200 && chargedCents(r) === 1) return { verdict: 'pass' };
      if (r.status === 502 || r.status === 504) {
        return { verdict: 'differs', note: `The upstream failed (${errMsg(r)}). The desk refunded the reservation and charged 0, with a signed receipt. This is the real result, not a demo fallback.` };
      }
      return { verdict: 'differs', note: `Expected 200, got ${r.status || 'a network error'}: ${errMsg(r)}` };
    },
  },
  {
    title: 'Tool not on the allowlist',
    expect: 'get_app_reviews is refused before any upstream call. Expect 403 tool_not_allowed, 0 charged, a signed receipt.',
    async run(ctx) {
      const r = await runTool('get_app_reviews', REVIEWS_ARGS, ctx.key);
      ctx.trackBalance(r);
      ctx.addCall(r, toolFacts(r));
      if (r.status === 403 && errCode(r) === 'tool_not_allowed') return { verdict: 'pass' };
      return { verdict: 'differs', note: `Expected 403 tool_not_allowed, got ${r.status}: ${errMsg(r)}` };
    },
  },
  {
    title: 'Second allowed tool uses the rest of the budget',
    expect: 'check_vat_number queries the EU VIES registry. Expect 200 and 2 of 2 cents used.',
    async run(ctx) {
      const r = await runTool('check_vat_number', VAT_ARGS, ctx.key);
      ctx.trackBalance(r);
      const facts = toolFacts(r);
      const result = r.body && r.body.result;
      if (r.status === 200 && result) {
        facts.push(['valid', String(result.valid)]);
        if (result.name) facts.push(['name', result.name, 'text']);
      }
      ctx.addCall(r, facts);
      const spent = sandbox.balance && sandbox.balance.spent_cents;
      if (r.status === 200 && spent === 2) return { verdict: 'pass' };
      if (r.status === 200) return { verdict: 'differs', note: `The call succeeded, but the key has spent ${usd(spent)} of ${usd(sandbox.balance && sandbox.balance.budget_cents)} because an earlier call was not charged.` };
      return { verdict: 'differs', note: `Expected 200, got ${r.status}: ${errMsg(r)}. Any reserved cent was refunded.` };
    },
  },
  {
    title: 'Budget exhausted',
    expect: 'eu_duty_estimate again. Expect 402 budget_exceeded with a signed receipt and no upstream call.',
    async run(ctx) {
      const r = await runTool('eu_duty_estimate', DUTY_ARGS, ctx.key);
      ctx.trackBalance(r);
      ctx.addCall(r, toolFacts(r));
      if (r.status === 402 && errCode(r) === 'budget_exceeded') return { verdict: 'pass' };
      if (r.status === 200) return { verdict: 'differs', note: 'The call succeeded because budget was still left: an earlier call failed upstream and was refunded.' };
      return { verdict: 'differs', note: `Expected 402 budget_exceeded, got ${r.status}: ${errMsg(r)}` };
    },
  },
  {
    title: 'Verify a receipt offline, in this browser',
    expect: 'Fetch the public key, check the step 2 Ed25519 signature with WebCrypto, then change one field and watch it fail.',
    async run(ctx) {
      const receipt = ctx.saved.dutyReceipt;
      const keyRes = await call('GET', '/.well-known/receipt-signing-key.json');
      const jwk = keyRes.body && keyRes.body.keys && keyRes.body.keys[0];
      ctx.addCall(keyRes, jwk ? [['kty / crv', `${jwk.kty} / ${jwk.crv}`], ['x', jwk.x], ['kid', jwk.kid]] : [['error', errMsg(keyRes), 'bad']]);
      if (!receipt) return { verdict: 'differs', note: 'Step 2 returned no receipt, so there is nothing to verify.' };
      let v;
      try {
        v = await verifyReceipt(receipt);
      } catch (err) {
        return { verdict: 'differs', note: `This browser could not run Ed25519 in WebCrypto: ${err.message || err}. Use a current Chrome, Firefox or Safari.` };
      }
      ctx.addNode(verifyPanel(receipt, v));
      return v.original && !v.tampered ? { verdict: 'pass' } : { verdict: 'differs', note: 'The signature check did not give the expected result.' };
    },
  },
  {
    title: 'Rotate the key; the old secret dies at once',
    expect: 'POST /v1/key/rotate gives a new secret. GET /v1/usage with the old one is 401; with the new one it is 200 and the spend is kept.',
    async run(ctx) {
      const oldKey = ctx.key;
      const rot = await call('POST', '/v1/key/rotate', { key: oldKey });
      ctx.addCall(rot, rot.status === 200 ? [['new key', rot.body.key], ['key_id (unchanged)', rot.body.key_id]] : [['error', errMsg(rot), 'bad']]);
      if (rot.status !== 200) return { verdict: 'differs', note: `Rotation failed: ${errMsg(rot)}` };
      ctx.key = rot.body.key;
      sandbox.key = rot.body.key;
      const oldUse = await call('GET', '/v1/usage', { key: oldKey });
      ctx.addCall(oldUse, [['with', 'old key'], ['error.code', errCode(oldUse) || '-', oldUse.status === 401 ? 'bad' : '']]);
      const newUse = await call('GET', '/v1/usage', { key: ctx.key });
      ctx.trackBalance(newUse);
      const b = newUse.body || {};
      ctx.addCall(newUse, newUse.status === 200 ? [
        ['with', 'new key'], ['spent (kept)', usd(b.spent_cents)], ['remaining', usd(b.remaining_cents)],
        ['calls this period', `${b.total_calls} (${(b.items || []).map(i => `${i.tool} x${i.calls}`).join(', ') || 'none'})`],
      ] : [['error', errMsg(newUse), 'bad']]);
      renderBalance();
      refreshSimTools();
      if (oldUse.status === 401 && newUse.status === 200) return { verdict: 'pass' };
      return { verdict: 'differs', note: `Old key gave ${oldUse.status}, new key gave ${newUse.status}.` };
    },
  },
];

function verifyPanel(receipt, v) {
  return el('div', { class: 'verify' },
    el('div', { class: 'callout', text: `This check ran in your browser with crypto.subtle.verify and the public key only (kid ${v.kid}). No request went to the desk to verify it.` }),
    el('div', { class: 'verify-row' }, el('span', { class: 'muted', text: 'Signed payload, exact bytes' })),
    el('pre', { class: 'code wrap-text', text: receipt.payload }),
    el('div', { class: 'verify-row' }, el('span', { class: 'muted', text: 'signature' }), el('code', { text: short(receipt.signature, 48) })),
    el('div', { class: 'verify-row' }, el('span', { class: 'muted', text: 'Original payload' }),
      dot(v.original ? 'valid Ed25519 signature' : 'INVALID', v.original ? 'ok' : 'bad')),
    el('div', { class: 'verify-row' }, el('span', { class: 'muted', text: `Copy with amount_mc ${v.before} changed to ${v.after}` }),
      dot(v.tampered ? 'still valid (unexpected)' : 'signature fails', 'bad')));
}

// ---------- Step log rendering ----------

function stepNode(step, i) {
  const status = el('span', { class: 'step-status' }, dot('waiting', ''));
  const body = el('div', { class: 'step-body' });
  const li = el('li', { class: 'step' },
    el('div', { class: 'step-head' },
      el('span', { class: 'step-n', text: i + 1 }),
      el('div', {}, el('div', { class: 'step-title', text: step.title }), el('div', { class: 'step-expect', text: step.expect })),
      status),
    body);
  return { li, status, body };
}

function callNode(r, facts) {
  const lines = el('div', { class: 'call' },
    el('div', { class: 'call-line' },
      el('span', { class: 'method', text: r.method }), el('span', { class: 'path', text: r.path }),
      httpCode(r.status), el('span', { class: 'lat', text: `${r.ms} ms` })));
  if (r.error) facts = [['network error', r.error, 'bad'], ...facts];
  if (facts.length) {
    lines.append(el('dl', { class: 'facts' }, facts.flatMap(([k, v, tone]) => [
      el('dt', { text: k }), el('dd', { class: tone === 'text' ? 'text' : tone === 'bad' ? 'code-bad' : '', text: v ?? '-' })])));
  }
  const hdrs = Object.entries(r.headers);
  if (hdrs.length) {
    lines.append(el('details', {}, el('summary', { text: `x-clearing-* headers (${hdrs.length})` }),
      el('pre', { class: 'code', text: hdrs.map(([k, v]) => `${k}: ${v}`).join('\n') })));
  }
  if (r.sent !== undefined) lines.append(el('details', {}, el('summary', { text: 'Request body' }), el('pre', { class: 'code', text: pretty(r.sent) })));
  if (r.body !== null) lines.append(el('details', {}, el('summary', { text: 'Response body' }), el('pre', { class: 'code', text: pretty(r.body) })));
  return lines;
}

function setStepState(view, state, text) {
  view.li.classList.remove('is-running', 'is-pass', 'is-bad');
  if (state === 'running') view.li.classList.add('is-running');
  if (state === 'pass') view.li.classList.add('is-pass');
  if (state === 'bad') view.li.classList.add('is-bad');
  const tone = { running: 'run', pass: 'ok', bad: 'bad' }[state] || '';
  view.status.replaceChildren(dot(text, tone));
}

function renderSteps() {
  const views = DEMO_STEPS.map((s, i) => stepNode(s, i));
  $('steps').replaceChildren(...views.map(v => v.li));
  return views;
}

let demoRunning = false;

async function runOneStep(step, view, ctx) {
  view.body.replaceChildren();
  const t0 = performance.now();
  const elapsed = el('span', { class: 'elapsed', text: '0.0 s' });
  setStepState(view, 'running', 'running');
  view.status.append(' ', elapsed);
  const timer = setInterval(() => { elapsed.textContent = `${((performance.now() - t0) / 1000).toFixed(1)} s`; }, 100);
  ctx.addCall = (r, facts) => view.body.append(callNode(r, facts));
  ctx.addNode = node => view.body.append(node);
  let out;
  try {
    out = await step.run(ctx);
  } catch (err) {
    out = { verdict: 'stop', note: `The page hit an error: ${err.message || err}` };
  }
  clearInterval(timer);
  const secs = duration(performance.now() - t0);
  if (out.verdict === 'pass') setStepState(view, 'pass', `as expected, ${secs}`);
  else setStepState(view, 'bad', out.verdict === 'stop' ? 'stopped' : `differs, ${secs}`);
  if (out.note) view.body.append(el('p', { class: 'step-note bad', text: out.note }));
  return out;
}

async function runDemo() {
  if (demoRunning) return;
  demoRunning = true;
  const btn = $('run-demo');
  btn.disabled = true;
  $('demo-status').textContent = 'Running real calls...';
  const views = renderSteps();
  const ctx = {
    saved: {},
    get key() { return sandbox.key; },
    set key(v) { sandbox.key = v; },
    trackBalance: r => setBalance(balanceFrom(r)),
  };
  let passed = 0;
  let stoppedAt = -1;
  for (let i = 0; i < DEMO_STEPS.length; i++) {
    const out = await runOneStep(DEMO_STEPS[i], views[i], ctx);
    if (out.verdict === 'pass') passed++;
    if (out.verdict === 'stop') { stoppedAt = i; break; }
  }
  if (stoppedAt >= 0) views.slice(stoppedAt + 1).forEach(v => setStepState(v, '', 'skipped'));
  await refreshSandboxReceipts();
  $('demo-status').textContent = `${passed} of ${DEMO_STEPS.length} steps matched the expectation. Every result above is a real response.`;
  btn.textContent = 'Run it again with a new key';
  btn.disabled = false;
  demoRunning = false;
}

// ---------- Agent call simulator ----------

const EXAMPLES = {
  eu_duty_estimate: DUTY_ARGS,
  find_tariff_codes: { description: 'knitted cotton t-shirt for men', country: 'GB', limit: 3 },
  check_vat_number: VAT_ARGS,
  list_jobs: { companies: ['greenhouse:cloudflare'], titleKeywords: ['engineer'], maxItems: 5 },
  get_app_reviews: REVIEWS_ARGS,
  get_transcript: { video: 'https://www.youtube.com/watch?v=jNQXAC9IVRw', format: 'text' },
  ask_repo_question: { repoName: 'cloudflare/workers-sdk', question: 'How does wrangler dev serve static assets?' },
};

/** Fallback for a tool without a hand-picked example: one placeholder per required field. */
function exampleFromSchema(schema) {
  const out = {};
  for (const name of (schema && schema.required) || []) {
    const p = (schema.properties || {})[name] || {};
    if (p.enum) out[name] = p.enum[0];
    else if (p.type === 'array') out[name] = [];
    else if (p.type === 'number' || p.type === 'integer') out[name] = 1;
    else if (p.type === 'boolean') out[name] = true;
    else out[name] = '';
  }
  return out;
}

const sim = { tools: [] };

async function refreshSimTools() {
  const r = await call('GET', '/v1/tools', { key: sandbox.key || undefined });
  if (r.status !== 200) {
    $('sim-tool-info').replaceChildren(dot(`GET /v1/tools returned ${r.status}: ${errMsg(r)}`, 'bad'));
    return;
  }
  const current = $('sim-tool').value;
  sim.tools = r.body.tools || [];
  $('sim-tool').replaceChildren(...sim.tools.map(t =>
    el('option', { value: t.name, text: `${t.name}  ${usd(t.price_cents)}${t.allowed === false ? '  (not allowed)' : ''}` })));
  if (current && sim.tools.some(t => t.name === current)) $('sim-tool').value = current;
  else selectSimTool();
  renderSimInfo();
}

function selectSimTool() {
  const tool = sim.tools.find(t => t.name === $('sim-tool').value);
  if (!tool) return;
  $('sim-args').value = JSON.stringify(EXAMPLES[tool.name] || exampleFromSchema(tool.inputSchema), null, 2);
  renderSimInfo();
}

function renderSimInfo() {
  const tool = sim.tools.find(t => t.name === $('sim-tool').value);
  if (!tool) return;
  const allowed = tool.allowed === undefined
    ? dot('no key yet', '')
    : dot(tool.allowed ? 'allowed for this key' : 'not on this key\'s allowlist', tool.allowed ? 'ok' : 'bad');
  $('sim-tool-info').replaceChildren(
    el('span', { class: 'num', text: `${usd(tool.price_cents)} per call` }),
    el('span', { text: `upstream ${tool.upstream}` }),
    allowed,
    el('span', { class: 'faint', text: tool.description }));
  $('sim-hint').textContent = sandbox.key ? '' : 'A sandbox key is minted on first run.';
}

async function runSim() {
  let args;
  try {
    args = JSON.parse($('sim-args').value);
  } catch (err) {
    $('sim-out').replaceChildren(dot(`Arguments are not valid JSON: ${err.message}`, 'bad'));
    return;
  }
  const btn = $('sim-run');
  btn.disabled = true;
  const t0 = performance.now();
  const running = el('span', { class: 'st run', text: 'calling...' });
  $('sim-out').replaceChildren(running);
  const timer = setInterval(() => { running.textContent = `calling... ${((performance.now() - t0) / 1000).toFixed(1)} s`; }, 100);
  if (!sandbox.key) {
    const minted = await mintSandboxKey();
    if (minted.status !== 201) {
      clearInterval(timer);
      btn.disabled = false;
      $('sim-out').replaceChildren(callNode(minted, [['error', errMsg(minted), 'bad']]));
      return;
    }
  }
  const r = await runTool($('sim-tool').value, args, sandbox.key);
  clearInterval(timer);
  setBalance(balanceFrom(r));
  const facts = toolFacts(r);
  if (r.status >= 400 && errMsg(r)) facts.push(['message', errMsg(r), 'text']);
  $('sim-out').replaceChildren(callNode(r, facts));
  btn.disabled = false;
  refreshSandboxReceipts();
}

function initSim() {
  $('sim-tool').addEventListener('change', selectSimTool);
  $('sim-run').addEventListener('click', runSim);
  refreshSimTools();
}

// ---------- MCP info ----------

function renderMcp() {
  const url = `${ORIGIN}/mcp`;
  $('mcp-url').textContent = url;
  const key = sandbox.key || 'cd_live_...';
  $('mcp-key-hint').textContent = key;
  $('mcp-config').textContent = JSON.stringify({
    mcpServers: { 'agent-clearing-desk': { type: 'http', url, headers: { 'x-api-key': key } } },
  }, null, 2);
}

// ---------- Operator console ----------

const TOKEN_KEY = 'cd_admin_token';
const adm = { token: null, tools: [], orgs: [], receipts: [], audit: [], filter: 'all', loaded: false };

function storeGet() { try { return sessionStorage.getItem(TOKEN_KEY); } catch { return null; } }
function storeSet(v) { try { sessionStorage.setItem(TOKEN_KEY, v); } catch { /* storage blocked: token lives in memory only */ } }
function storeDel() { try { sessionStorage.removeItem(TOKEN_KEY); } catch { /* storage blocked */ } }

function consoleFlash(text, tone) {
  const f = $('console-flash');
  f.hidden = !text;
  f.className = `flash ${tone || ''}`;
  f.textContent = text || '';
}

const admin = (method, path, body) => call(method, path, { admin: adm.token, body });

function adminFailure(r) {
  if (r.status === 401) return '401 unauthorized: the admin bearer token was rejected.';
  if (r.status === 503) return `503 ${errCode(r) || ''}: ${errMsg(r)}`;
  return `${r.method} ${r.path} returned ${r.status || 'a network error'}: ${errMsg(r)}`;
}

function consoleOpened() {
  if (adm.loaded) return;
  const saved = storeGet();
  if (saved) {
    adm.token = saved;
    $('admin-token').value = saved;
    loadConsole();
  }
}

async function loadConsole() {
  consoleFlash('Loading...', '');
  const [ov, keys, orgs, tools, audit, receipts] = await Promise.all([
    admin('GET', '/api/admin/overview'), admin('GET', '/api/admin/keys'), admin('GET', '/api/admin/orgs'),
    admin('GET', '/api/admin/tools'), admin('GET', '/api/admin/audit?limit=100'), admin('GET', '/api/admin/receipts?limit=100'),
  ]);
  const failed = [ov, keys, orgs, tools, audit, receipts].find(r => r.status !== 200);
  if (failed) {
    $('console-body').hidden = true;
    adm.loaded = false;
    consoleFlash(adminFailure(failed), 'bad');
    return;
  }
  adm.loaded = true;
  adm.tools = tools.body.tools;
  adm.orgs = orgs.body.organizations;
  adm.audit = audit.body.audit_logs;
  adm.receipts = receipts.body.receipts;
  consoleFlash('', '');
  $('console-body').hidden = false;
  renderKpis(ov.body);
  renderKeys(keys.body.keys);
  renderCreateForm();
  renderAudit();
  renderPrices();
  renderAdminReceipts();
}

function renderKpis(o) {
  const items = [
    ['Active keys', o.active_keys, '', `${o.organizations} organization${o.organizations === 1 ? '' : 's'}`],
    ['Allocated budget', usd(o.allocated_budget_cents), '', 'active keys'],
    ['Metered spend', usd(o.metered_spend_cents), 'accent', 'charged to agents'],
    ['Upstream cost', usd(o.upstream_cost_cents), '', 'paid to tools'],
    ['Clearing margin', usd(o.clearing_margin_cents), 'accent', 'spend minus cost'],
    ['Signed receipts', o.signed_receipts, '', 'Ed25519 signature each'],
    ['Refusals', o.refusals, o.refusals ? 'bad' : '', 'allowlist + budget'],
    ['Upstream errors', o.upstream_errors, o.upstream_errors ? 'bad' : '', 'refunded, charged 0'],
  ];
  $('kpis').replaceChildren(...items.map(([label, value, tone, sub]) =>
    el('div', { class: 'kpi' }, el('span', { class: 'label', text: label }), el('b', { class: tone, text: value }), el('small', { text: sub }))));
}

function table(id, headers, rows, emptyText) {
  const thead = el('thead', {}, el('tr', {}, headers.map(h => el('th', { class: h.endsWith(' ') ? 'r' : '', text: h.trim() }))));
  const body = rows.length ? rows : [el('tr', { class: 'empty-row' }, el('td', { colspan: headers.length, text: emptyText }))];
  $(id).replaceChildren(thead, el('tbody', {}, body));
}

function td(content, cls) {
  const cell = el('td', { class: cls });
  if (content instanceof Node) cell.append(content);
  else cell.textContent = content ?? '-';
  return cell;
}

function meterCell(spent, budget) {
  const pct = budget > 0 ? Math.min(100, (spent / budget) * 100) : 100;
  return el('div', { class: 'cell-meter' },
    el('span', { class: 'num', text: `${usd(spent)} / ${usd(budget)}` }),
    el('div', { class: `meter${spent >= budget ? ' full' : ''}` }, el('span', { style: `width:${pct}%` })));
}

function allowCell(list) {
  return el('span', {}, (list || []).map(t => el('span', { class: 'pill', text: t === '*' ? '* all tools' : t })));
}

function renderKeys(keys) {
  const rows = keys.map(k => el('tr', {},
    td(el('div', {}, el('div', { text: k.name }), el('div', { class: 'faint mono', text: k.key_id }))),
    td(k.key_prefix, 'mono'),
    td(orgName(k.org_id)),
    td(allowCell(k.allowlist), 'wrapcell'),
    td(meterCell(k.spent_cents, k.budget_cents)),
    td(statusDot(k.expires_at && k.expires_at <= Date.now() && k.status === 'active' ? 'expired' : k.status)),
    td(expiry(k.expires_at), 'faint'),
    td(keyActions(k))));
  table('keys-table', ['Name', 'Prefix', 'Org', 'Allowlist', 'Budget', 'Status', 'Expires', 'Actions'], rows, 'No agent keys yet.');
}

function orgName(id) {
  const o = adm.orgs.find(x => x.id === id);
  return o ? o.name : id;
}

function keyActions(k) {
  const box = el('div', { class: 'actions' });
  if (k.status !== 'active') {
    box.append(el('span', { class: 'faint', text: '-' }));
    return box;
  }
  box.append(
    el('button', { class: 'btn tiny', type: 'button', text: 'Rotate', onclick: () => rotateKey(k) }),
    el('button', { class: 'btn tiny', type: 'button', text: 'Budget', onclick: () => editBudget(k, box) }),
    el('button', { class: 'btn tiny danger', type: 'button', text: 'Revoke', onclick: () => revokeKey(k) }));
  return box;
}

function showSecret(label, key) {
  $('secret-reveal').replaceChildren(el('div', { class: 'secret', role: 'status' },
    el('span', { text: label }), el('code', { text: key }), copyButton(() => key),
    el('span', { class: 'faint', text: 'Shown once. Store it now.' }),
    el('button', { class: 'btn tiny ghost x', type: 'button', text: 'Dismiss', onclick: () => $('secret-reveal').replaceChildren() })));
}

async function rotateKey(k) {
  if (!confirm(`Rotate ${k.name}? The current secret stops working at once.`)) return;
  const r = await admin('POST', `/api/admin/keys/${k.key_id}/rotate`);
  if (r.status !== 200) return consoleFlash(adminFailure(r), 'bad');
  showSecret(`New secret for ${k.name}:`, r.body.key);
  await loadConsole();
}

async function revokeKey(k) {
  if (!confirm(`Revoke ${k.name} (${k.key_prefix})? This cannot be undone.`)) return;
  const r = await admin('POST', `/api/admin/keys/${k.key_id}/revoke`);
  if (r.status !== 200) return consoleFlash(adminFailure(r), 'bad');
  await loadConsole();
}

function editBudget(k, box) {
  const input = el('input', { type: 'number', min: 0, step: '0.001', value: k.budget_cents, 'aria-label': 'Budget in cents' });
  const save = el('button', { class: 'btn tiny', type: 'button', text: 'Save' });
  const cancel = el('button', { class: 'btn tiny ghost', type: 'button', text: 'Cancel', onclick: () => box.replaceWith(keyActions(k)) });
  const editor = el('div', { class: 'budget-edit' }, input, el('span', { class: 'faint', text: 'cents' }), save, cancel);
  save.addEventListener('click', async () => {
    const r = await admin('POST', `/api/admin/keys/${k.key_id}/budget`, { budgetCents: Number(input.value) });
    if (r.status !== 200) return consoleFlash(adminFailure(r), 'bad');
    await loadConsole();
    consoleFlash(`Budget for ${k.name} is now ${usd(r.body.budget_cents)}.`, 'ok');
  });
  box.replaceChildren(editor);
  input.focus();
}

const NEW_ORG = '__new__';

function renderCreateForm() {
  const sel = $('ck-org');
  const prev = sel.value;
  sel.replaceChildren(
    ...adm.orgs.map(o => el('option', { value: o.id, text: `${o.name} (${o.id})` })),
    el('option', { value: NEW_ORG, text: '+ New organization' }));
  sel.value = adm.orgs.some(o => o.id === prev) ? prev : (adm.orgs[0] ? adm.orgs[0].id : NEW_ORG);
  $('new-org').hidden = sel.value !== NEW_ORG;
  const names = ['*', ...adm.tools.map(t => t.name)];
  $('ck-allow').replaceChildren(...names.map(n => el('label', {},
    el('input', { type: 'checkbox', value: n }), n === '*' ? '* (every tool)' : n)));
}

async function ensureOrg() {
  if ($('ck-org').value !== NEW_ORG) return { id: $('ck-org').value };
  const r = await admin('POST', '/api/admin/orgs', { name: $('org-name').value.trim(), email: $('org-email').value.trim() });
  if (r.status !== 201) return { error: adminFailure(r) };
  return { id: r.body.id };
}

async function createKey(e) {
  e.preventDefault();
  const allowlist = [...$('ck-allow').querySelectorAll('input:checked')].map(i => i.value);
  const hint = $('create-hint');
  if (!allowlist.length) { hint.textContent = 'Pick at least one tool, or * for all.'; return; }
  const org = await ensureOrg();
  if (org.error) { hint.textContent = org.error; return; }
  const body = { orgId: org.id, name: $('ck-name').value.trim(), budgetCents: Number($('ck-budget').value), allowlist };
  const exp = Number($('ck-exp').value);
  if (exp > 0) body.expiresInMinutes = exp;
  const r = await admin('POST', '/api/admin/keys', body);
  if (r.status !== 201) { hint.textContent = adminFailure(r); return; }
  hint.textContent = '';
  e.target.reset();
  showSecret(`New key ${r.body.name}:`, r.body.key);
  await loadConsole();
  $('c-keys').scrollIntoView({ behavior: 'smooth' });
}

const AUDIT_FILTERS = ['all', 'success', 'refused_allowlist', 'refused_budget', 'upstream_error'];

function renderAudit() {
  const count = s => (s === 'all' ? adm.audit.length : adm.audit.filter(a => a.status === s).length);
  $('audit-chips').replaceChildren(...AUDIT_FILTERS.map(s => el('button', {
    class: 'chip', type: 'button', 'aria-pressed': String(adm.filter === s),
    onclick: () => { adm.filter = s; renderAudit(); },
  }, s === 'all' ? el('span', { text: 'all' }) : statusDot(s), el('span', { class: 'n', text: count(s) }))));
  const rows = adm.audit.filter(a => adm.filter === 'all' || a.status === adm.filter).map(auditRow);
  table('audit-table', ['Time', 'Key', 'Tool', 'Upstream', 'Protocol', 'Status', 'HTTP', 'Price ', 'Cost ', 'Margin ', 'Latency ', 'Receipt', 'Args or error'], rows, 'No calls match this filter.');
}

function auditRow(a) {
  return el('tr', {},
    td(when(a.created_at), 'faint'),
    td(a.key_id, 'mono'),
    td(a.tool_name, 'mono'),
    td(a.upstream),
    td(a.protocol, 'mono'),
    td(statusDot(a.status)),
    td(httpCode(a.status_code)),
    td(usd(a.price_cents), 'num r'),
    td(usd(a.cost_cents), 'num r'),
    td(usd(a.margin_cents), 'num r'),
    td(`${a.latency_ms} ms`, 'num r'),
    // An audit row aud_<suffix> and its receipt rcpt_<suffix> share the suffix by construction.
    td(`rcpt_${String(a.id).slice(4)}`, 'mono faint'),
    argsCell(a));
}

function argsCell(a) {
  const text = a.error_detail || a.params_summary || '';
  const cell = td(text, `clip mono ${a.error_detail ? 'code-bad' : 'faint'}`);
  cell.title = text;
  return cell;
}

function renderPrices() {
  const rows = adm.tools.map(t => el('tr', {},
    td(t.name, 'mono'), td(t.upstream),
    td(usd(t.cost_cents), 'num r'), td(usd(t.price_cents), 'num r'), td(usd(t.margin_cents), 'num r'),
    td(t.price_cents > 0 ? `${((t.margin_cents / t.price_cents) * 100).toFixed(1)} %` : '-', 'num r')));
  table('prices-table', ['Tool', 'Upstream', 'Cost ', 'Price ', 'Margin ', 'Margin % '], rows, 'No tools.');
}

function renderAdminReceipts() {
  const rows = adm.receipts.map(rc => {
    const f = rc.fields || {};
    const result = el('div');
    return el('tr', {},
      td(rc.receipt_id, 'mono'), td(when(f.issued_at), 'faint'), td(f.key_id, 'mono'), td(f.tool, 'mono'),
      td(statusDot(f.outcome)), td(mcUsd(f.amount_mc), 'num r'), td(rc.key_fingerprint, 'mono faint'),
      td(el('div', { class: 'row gap' }, verifyButton(rc, result), result)));
  });
  table('receipts-table', ['Receipt', 'Issued', 'Key', 'Tool', 'Outcome', 'Amount ', 'Key id', 'Offline check'], rows, 'No receipts yet.');
}

function initConsole() {
  $('token-form').addEventListener('submit', e => {
    e.preventDefault();
    adm.token = $('admin-token').value.trim();
    if (!adm.token) return consoleFlash('Enter the admin bearer token.', 'bad');
    storeSet(adm.token);
    loadConsole();
  });
  $('token-clear').addEventListener('click', () => {
    storeDel();
    adm.token = null;
    adm.loaded = false;
    $('admin-token').value = '';
    $('console-body').hidden = true;
    consoleFlash('Token removed from this tab.', '');
  });
  $('console-refresh').addEventListener('click', loadConsole);
  $('ck-org').addEventListener('change', () => { $('new-org').hidden = $('ck-org').value !== NEW_ORG; });
  $('create-form').addEventListener('submit', createKey);
}

// ---------- Boot ----------

function initCopyButtons() {
  for (const b of document.querySelectorAll('[data-copy-from]')) {
    b.addEventListener('click', () => copyText($(b.dataset.copyFrom).textContent, b));
  }
}

function boot() {
  renderSteps();
  renderBalance();
  renderMcp();
  initTabs();
  initCopyButtons();
  initSim();
  initConsole();
  $('run-demo').addEventListener('click', runDemo);
  $('new-key').addEventListener('click', async () => {
    const r = await mintSandboxKey();
    if (r.status !== 201) $('balance').replaceChildren(dot(`${r.status}: ${errMsg(r)}`, 'bad'));
  });
  $('refresh-receipts').addEventListener('click', refreshSandboxReceipts);
}

boot();
