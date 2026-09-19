/* Jev Playground (OpenRouter) – vanilla JS front-end. No build step. */
(() => {
'use strict';

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isEntry = (v) => v === null || typeof v === 'string' || typeof v === 'object';
// Question ids and option keys are user-chosen ("constructor", "__proto__" …): never use `in` or bare indexing on maps keyed by them.
const own = (o, k) => isPlainObject(o) && Object.prototype.hasOwnProperty.call(o, k);
const get = (o, k) => (own(o, k) ? o[k] : undefined);
const QTYPES = ['noul', 'choice', 'score'];
let uidCounter = 0;
const newUid = () => 'q' + (++uidCounter);
const fmtUsd = (c) => (typeof c === 'number' ? '$' + c.toFixed(6) : '–');
const pct = (p) => (typeof p === 'number' ? (p * 100).toFixed(0) + '%' : '–');
const num = (v, d = 2) => (typeof v === 'number' ? v.toFixed(d) : '–');

function el(tag, attrs = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(n.dataset, v);
    else if (k === 'style') n.style.cssText = v;
    else if (v === true) n.setAttribute(k, '');
    else n.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    n.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return n;
}

/** Label for a possibly-structured value. Never yields "[object Object]". */
function displayLabel(v, max = 40) {
  if (typeof v === 'string') return { text: v, full: null, structured: false };
  if (v === null || v === undefined) return { text: 'null', full: null, structured: false };
  if (typeof v === 'number' || typeof v === 'boolean') return { text: String(v), full: null, structured: false };
  const full = JSON.stringify(v);
  if (isPlainObject(v)) {
    for (const k of ['label', 'level', 'name', 'title']) {
      if (typeof v[k] === 'string' && v[k]) return { text: v[k], full, structured: true };
    }
  }
  const t = full.length > max ? full.slice(0, max - 1) + '…' : full;
  return { text: t, full, structured: true };
}
function labelNode(v, max = 40) {
  const d = displayLabel(v, max);
  return el('span', { class: d.structured ? 'lbl-obj' : '', title: d.full || undefined, text: d.text });
}
function summaryText(v, max = 160) {
  if (typeof v === 'string') return v.length > max ? v.slice(0, max - 1) + '…' : v;
  if (v === null || v === undefined) return '(null instructions)';
  const s = JSON.stringify(v);
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

function download(name, text) {
  const a = el('a', { href: URL.createObjectURL(new Blob([text], { type: 'application/json' })), download: name });
  document.body.append(a); a.click(); a.remove();
}
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; }
  catch (e) {
    const ta = el('textarea', { style: 'position:fixed;opacity:0' }); ta.value = text;
    document.body.append(ta); ta.select();
    let ok = false; try { ok = document.execCommand('copy'); } catch (e2) { ok = false; }
    ta.remove(); return ok;
  }
}
function toast(msg, isError = false, sticky = false) {
  const b = $('#banner');
  b.textContent = msg; b.hidden = false; b.className = 'banner ' + (isError ? 'err' : 'ok');
  clearTimeout(toast._t); if (!sticky) toast._t = setTimeout(() => { b.hidden = true; }, isError ? 6000 : 2500);
}
$('#banner').addEventListener('click', () => { $('#banner').hidden = true; });
/** Progress bar under the header. setProgress(null) hides; {label} alone = indeterminate; {done,total} = determinate. */
function setProgress(p) {
  const box = $('#progress');
  if (!p) { box.hidden = true; return; }
  box.hidden = false;
  const det = typeof p.total === 'number' && p.total > 0;
  box.classList.toggle('indeterminate', !det);
  if (det) $('.ptrack i', box).style.width = Math.round(100 * Math.min(p.done, p.total) / p.total) + '%';
  $('.plabel', box).textContent = p.label || '';
}

// ---------------------------------------------------------------------------
// Workspace state
// ---------------------------------------------------------------------------
const ws = {
  stateMode: 'text',           // 'text' | 'json'
  stateText: '',
  entries: [],                 // [{uid, id, q, disabled}] – canonical questions map, ordered; disabled = omitted from the request
  model: 'typesafe/jev-1.13',
  thresholds: { low: 0.5, high: 0.8 },
  presetName: '',
  pair: null,                  // boundary pair from the loaded preset
};
const ui = {};                 // uid -> {structured:{}, draft:{}, parseErr:{}}
const uiFor = (uid) => (ui[uid] ||= { structured: {}, draft: {}, parseErr: {} });
let config = { endpoint: 'https://openrouter.ai/api/alpha/decisions', has_key: true };
let lastRun = null;            // {request, result, ts, ...}
let rubricA = null;            // {questions, disabled, stateMode, stateText}
let running = false;

function questionsObject(entries = ws.entries) {
  return Object.fromEntries(entries.map((e) => [e.id, e.q]));   // fromEntries defines own props (safe for "__proto__")
}
const disabledIds = () => ws.entries.filter((e) => e.disabled).map((e) => e.id);
let wsGen = 0;                 // bumped whenever the workspace is replaced; in-flight runs check it before painting
let presetLoadToken = 0;       // only the latest preset selection may install itself; bumped on every workspace replacement
function setQuestionsFromObject(obj, { keepUi = true } = {}) {
  const byId = new Map(ws.entries.map((e) => [e.id, e]));
  const next = [];
  for (const [id, q] of Object.entries(obj)) {
    const prev = keepUi ? byId.get(id) : null;
    next.push({ uid: prev ? prev.uid : newUid(), id, q, disabled: !!(prev && prev.disabled) });
  }
  const keep = new Set(next.map((e) => e.uid));
  for (const k of Object.keys(ui)) if (!keep.has(k)) delete ui[k];
  ws.entries = next;
}
function stateValue() {
  if (ws.stateMode === 'text') return ws.stateText;
  try { return JSON.parse(ws.stateText); } catch (e) { return undefined; }
}
function stateError() {
  if (ws.stateMode === 'text') return ws.stateText.trim() ? '' : 'State is empty.';
  if (!ws.stateText.trim()) return 'State is empty.';
  try {
    const v = JSON.parse(ws.stateText);
    if (v === null || typeof v !== 'object') return 'JSON state must be an object or array (use Text mode for a plain string).';
    return '';
  } catch (e) { return 'Invalid JSON: ' + e.message; }
}
function snapshotWorkspace() {
  return {
    stateMode: ws.stateMode, stateText: ws.stateText,
    questions: clone(questionsObject()), disabled: disabledIds(),
    model: ws.model, thresholds: { ...ws.thresholds }, presetName: ws.presetName,
  };
}
function applyWorkspace(w) {
  ws.stateMode = w.stateMode === 'json' ? 'json' : 'text';
  ws.stateText = typeof w.stateText === 'string' ? w.stateText : '';
  setQuestionsFromObject(isPlainObject(w.questions) ? clone(w.questions) : {}, { keepUi: false });
  const dis = new Set(Array.isArray(w.disabled) ? w.disabled.filter((d) => typeof d === 'string') : []);
  for (const e of ws.entries) e.disabled = dis.has(e.id);
  wsGen++; presetLoadToken++;
  if (typeof w.model === 'string' && w.model.trim()) ws.model = w.model;
  if (w.thresholds && typeof w.thresholds.low === 'number' && typeof w.thresholds.high === 'number'
      && w.thresholds.low >= 0 && w.thresholds.low < w.thresholds.high && w.thresholds.high <= 1) {
    ws.thresholds = { low: w.thresholds.low, high: w.thresholds.high };
  }
  ws.presetName = typeof w.presetName === 'string' ? w.presetName : '';
  ws.pair = null;
  presetSel.value = '';   // the dropdown is a loader, not a label; a restored/imported workspace is not "the preset"
  syncAllFromWorkspace();
}

// ---------------------------------------------------------------------------
// Validation (mirrors server.py)
// ---------------------------------------------------------------------------
function validateAll() {
  const errors = [];  // {uid, msg}
  const warnings = [];
  const seen = new Map();
  const fieldErrs = {};   // uid -> {fkey: msg}
  const fe = (uid, key, msg) => { (fieldErrs[uid] ||= {})[key] = msg; errors.push({ uid, msg }); };

  for (const e of ws.entries) {
    const { uid, id, q } = e;
    const u = uiFor(uid);
    if (!id.trim()) errors.push({ uid, msg: 'Question id is empty.' });
    else if (seen.has(id)) { errors.push({ uid, msg: `Duplicate id "${id}".` }); errors.push({ uid: seen.get(id), msg: `Duplicate id "${id}".` }); }
    else seen.set(id, uid);
    if (!isPlainObject(q)) { errors.push({ uid, msg: 'Question must be a JSON object (fix in Raw JSON).' }); continue; }
    if (!QTYPES.includes(q.type)) { errors.push({ uid, msg: `Unknown type "${q.type}".` }); continue; }
    for (const [key, msg] of Object.entries(u.parseErr)) if (msg) fe(uid, key, 'Invalid JSON: ' + msg);

    // instructions
    if (!('instructions' in q)) fe(uid, 'instructions', 'instructions is required.');
    else if (!isEntry(q.instructions)) fe(uid, 'instructions', 'Not an allowed value type (use string, object or array).');
    else if (q.instructions === null) fe(uid, 'instructions', 'null instructions are rejected by OpenRouter (live check); use a string, object or array.');
    else if (typeof q.instructions === 'string' && !q.instructions.trim()) fe(uid, 'instructions', 'Instructions are required.');

    const c = q.criteria;
    if (q.type === 'choice') {
      if (!isPlainObject(c) || Object.keys(c).length < 2) errors.push({ uid, msg: 'Choice needs at least 2 options.' });
      else for (const [k, v] of Object.entries(c)) {
        if (!k.trim()) errors.push({ uid, msg: 'Option key is empty.' });
        if (!isEntry(v)) fe(uid, 'opt.' + k, 'Not an allowed value type.');
      }
    } else if (q.type === 'score') {
      if (!Array.isArray(c) || c.length < 2) errors.push({ uid, msg: 'Score needs at least 2 levels.' });
      else c.forEach((v, i) => {
        if (!isEntry(v)) fe(uid, 'lvl.' + i, 'Not an allowed value type.');
        else if (v === null) fe(uid, 'lvl.' + i, `null level ${i} is rejected by OpenRouter (live check).`);
        else if (typeof v === 'string' && !v.trim()) fe(uid, 'lvl.' + i, `Level ${i} is empty.`);
      });
    } else if (q.type === 'noul') {
      if ('criteria' in q && c !== undefined) {
        if (!isPlainObject(c)) errors.push({ uid, msg: 'Noul criteria must be an object with true/false keys.' });
        else {
          const extra = Object.keys(c).filter((k) => k !== 'true' && k !== 'false');
          if (extra.length) errors.push({ uid, msg: `Noul criteria only allows "true"/"false" keys (found ${extra.join(', ')}).` });
          for (const k of ['true', 'false']) {
            if (k in c && (!isEntry(c[k]) || c[k] === null)) fe(uid, 'crit.' + k, c[k] === null ? 'null is rejected by OpenRouter (live check); leave the field empty to omit it.' : 'Not an allowed value type.');
            else if (!(k in c)) fe(uid, 'crit.' + k, `OpenRouter requires both true and false when criteria is present; fill "${k}" or clear the other.`);
          }
        }
      }
    }
  }

  // paint
  for (const e of ws.entries) {
    const card = $(`#q-cards .qcard[data-uid="${e.uid}"]`);
    if (!card) continue;
    const errs = errors.filter((x) => x.uid === e.uid).map((x) => x.msg);
    const warns = warnings.filter((x) => x.uid === e.uid).map((x) => x.msg);
    const errBox = $('.q-err', card), warnBox = $('.q-warn', card);
    errBox.hidden = !errs.length; errBox.textContent = Array.from(new Set(errs)).join(' ');
    warnBox.hidden = !warns.length; warnBox.textContent = warns.join(' · ');
    card.classList.toggle('has-error', errs.length > 0);
    $$('.field[data-fkey]', card).forEach((f) => {
      const m = (fieldErrs[e.uid] || {})[f.dataset.fkey] || '';
      const box = $('.ferr', f); if (box) box.textContent = m;
    });
  }
  const g = $('#q-errors');
  const enabledCount = ws.entries.filter((e) => !e.disabled).length;
  const summary = [];
  if (!ws.entries.length) summary.push('No questions.');
  else if (!enabledCount) summary.push('All questions are disabled.');
  if (errors.length) summary.push(`${errors.length} validation ${errors.length === 1 ? 'error' : 'errors'} block Run.`);
  g.hidden = !summary.length; g.textContent = summary.join(' ');
  $('#q-count').textContent = ws.entries.length ? `${enabledCount}/${ws.entries.length}` : '';
  return { errors, warnings, enabledCount };
}

// ---------------------------------------------------------------------------
// Question cards
// ---------------------------------------------------------------------------
const cardsBox = $('#q-cards');

function afterChange({ structural = false } = {}) {
  validateAll();
  if (!rawDirty()) syncRawFromCanonical();
  if (structural) renderPairBox();
}

/** Generic EntryType field with a text/structured toggle. */
function entryField(uid, fkey, opts) {
  // opts: {label, get, set, emptyValue, placeholder}
  const u = uiFor(uid);
  const val = opts.get();
  const isEmptyVal = (v) => v === opts.emptyValue;
  let structured = !!u.structured[fkey];
  if (!structured && typeof val !== 'string' && !isEmptyVal(val)) structured = true;

  const wrap = el('div', { class: 'field', dataset: { fkey } });
  const head = el('div', { class: 'field-head' }, el('span', { class: 'lbl', text: opts.label }));
  const ferr = el('span', { class: 'ferr' });
  const tog = el('button', { class: 'small tog' + (structured ? ' on' : ''), type: 'button', text: 'structured', title: 'Toggle JSON sub-editor for this field' });
  head.append(ferr, tog);
  wrap.append(head);

  const rerender = () => wrap.replaceWith(entryField(uid, fkey, opts));

  if (!structured) {
    const ta = el('textarea', { placeholder: opts.placeholder || '', spellcheck: 'false' });
    ta.value = typeof val === 'string' ? val : '';
    ta.addEventListener('input', () => { opts.set(ta.value === '' ? opts.emptyValue : ta.value); afterChange(); });
    wrap.append(ta);
    tog.addEventListener('click', () => { u.structured[fkey] = true; delete u.draft[fkey]; delete u.parseErr[fkey]; rerender(); });
  } else {
    const ta = el('textarea', { class: 'struct', placeholder: 'JSON: "string", {"covers": ...}, [...], or null', spellcheck: 'false' });
    ta.value = u.draft[fkey] !== undefined ? u.draft[fkey] : (val === undefined ? '' : JSON.stringify(val, null, 2));
    const grow = () => { ta.rows = Math.min(14, Math.max(3, ta.value.split('\n').length + 1)); };
    grow(); ta.addEventListener('input', grow);
    const frag = el('div', { class: 'frag' });
    const paint = () => { const v = opts.get(); frag.textContent = v === undefined ? '(omitted)' : 'fragment: ' + JSON.stringify(v); };
    paint();
    ta.addEventListener('input', () => {
      u.draft[fkey] = ta.value;
      const t = ta.value.trim();
      if (!t) { delete u.parseErr[fkey]; opts.set(opts.emptyValue); }
      else {
        try { const p = JSON.parse(t); delete u.parseErr[fkey]; opts.set(p); }
        catch (e) { u.parseErr[fkey] = e.message; }
      }
      paint(); afterChange();
    });
    wrap.append(ta, frag);
    tog.addEventListener('click', () => {
      const v = opts.get();
      if (typeof v !== 'string' && !isEmptyVal(v)) {
        if (u.parseErr[fkey]) { if (!confirm('The JSON draft does not parse and will be discarded; the last valid value will be stringified compactly. Switch to text anyway?')) return; }
        else if (!confirm('This value is not a string. Switching to text will stringify it compactly. Continue?')) return;
        opts.set(JSON.stringify(v));
      }
      u.structured[fkey] = false; delete u.draft[fkey]; delete u.parseErr[fkey];
      rerender(); afterChange();
    });
  }
  return wrap;
}

function normalizeCriteriaForType(q, type) {
  if (type === 'choice') {
    if (!isPlainObject(q.criteria) || Object.keys(q.criteria).some((k) => k === 'true' || k === 'false') && Object.keys(q.criteria).length <= 2) {
      q.criteria = { option_1: null, option_2: null };
    }
  } else if (type === 'score') {
    if (!Array.isArray(q.criteria)) q.criteria = ['', ''];
  } else if (type === 'noul') {
    if (!isPlainObject(q.criteria) || Object.keys(q.criteria).some((k) => k !== 'true' && k !== 'false')) delete q.criteria;
  }
}

function renderCard(entry) {
  const { uid } = entry;
  const u = uiFor(uid);
  const node = $('#tpl-question').content.firstElementChild.cloneNode(true);
  node.dataset.uid = uid;
  const q = entry.q;
  const idIn = $('.q-id', node), typeSel = $('.q-type', node), enabled = $('.q-enabled', node);
  idIn.value = entry.id;
  enabled.checked = !entry.disabled;
  node.classList.toggle('disabled', !enabled.checked);

  idIn.addEventListener('input', () => {
    entry.id = idIn.value; afterChange();
  });
  enabled.addEventListener('change', () => {
    entry.disabled = !enabled.checked;
    node.classList.toggle('disabled', !enabled.checked); afterChange();
  });
  $('.q-del', node).addEventListener('click', () => {
    ws.entries = ws.entries.filter((e) => e !== entry); delete ui[uid]; node.remove(); afterChange({ structural: true }); renderEmpty();
  });
  $('.q-dup', node).addEventListener('click', () => {
    const base = entry.id.replace(/_copy\d*$/, '') + '_copy';
    let id = base, n = 1; while (ws.entries.some((e) => e.id === id)) id = base + (++n);
    const ne = { uid: newUid(), id, q: clone(q), disabled: false };
    const i = ws.entries.indexOf(entry); ws.entries.splice(i + 1, 0, ne);
    node.after(renderCard(ne)); afterChange({ structural: true });
  });

  if (!isPlainObject(q)) {
    typeSel.disabled = true; $('.q-instructions', node).remove(); $('.q-criteria', node).remove();
    return node;
  }
  if (!QTYPES.includes(q.type)) typeSel.append(el('option', { value: q.type === undefined ? '' : String(q.type), text: `${q.type} (unknown)` }));
  typeSel.value = QTYPES.includes(q.type) ? q.type : (q.type === undefined ? '' : String(q.type));
  typeSel.addEventListener('change', () => {
    q.type = typeSel.value; normalizeCriteriaForType(q, q.type);
    u.structured = { instructions: u.structured.instructions }; u.draft = { instructions: u.draft.instructions }; u.parseErr = { instructions: u.parseErr.instructions };
    for (const m of ['draft', 'parseErr']) if (u[m].instructions === undefined) delete u[m].instructions;
    node.replaceWith(renderCard(entry)); afterChange({ structural: true });
  });

  $('.q-instructions', node).replaceWith(entryField(uid, 'instructions', {
    label: 'instructions', emptyValue: '', placeholder: 'What should Jev decide? Be specific about boundaries.',
    get: () => ('instructions' in q ? q.instructions : ''), set: (v) => { q.instructions = v; },
  }));
  const badShape = (what) => crit.append(el('div', { class: 'error', text: `criteria is ${'criteria' in q ? 'not ' + what + ' (' + String(JSON.stringify(q.criteria)).slice(0, 60) + ')' : 'missing; it must be ' + what}. Fix it in Raw JSON or change the type to reset it.` }));

  const crit = $('.q-criteria', node);
  if (q.type === 'noul') {
    crit.append(el('div', { class: 'hint', text: 'criteria (optional): what counts as true / false' }));
    for (const k of ['true', 'false']) {
      crit.append(entryField(uid, 'crit.' + k, {
        label: k, emptyValue: undefined, placeholder: `(optional) description of "${k}"`,
        get: () => (isPlainObject(q.criteria) ? q.criteria[k] : undefined),
        set: (v) => {
          if (v === undefined) { if (isPlainObject(q.criteria)) { delete q.criteria[k]; if (!Object.keys(q.criteria).length) delete q.criteria; } }
          else { if (!isPlainObject(q.criteria)) q.criteria = {}; q.criteria[k] = v; }
        },
      }));
    }
  } else if (q.type === 'choice' && !isPlainObject(q.criteria)) { badShape('an object of options');
  } else if (q.type === 'score' && !Array.isArray(q.criteria)) { badShape('an array of levels');
  } else if (q.type === 'choice') {
    crit.append(el('div', { class: 'hint', text: 'criteria: options (key + optional description; empty text = null)' }));
    const rows = el('div', { class: 'crit-rows' });
    const renderRows = () => {
      rows.replaceChildren();
      for (const key of Object.keys(q.criteria)) {
        const keyIn = el('input', { type: 'text', class: 'key', value: key, spellcheck: 'false', placeholder: 'option_key', dataset: { key } });
        keyIn.addEventListener('change', () => {
          const nk = keyIn.value;
          if (nk === key) return;
          if (!nk.trim() || Object.prototype.hasOwnProperty.call(q.criteria, nk)) { toast(nk.trim() ? `Option "${nk}" already exists.` : 'Option key cannot be empty.', true); keyIn.value = key; return; }
          q.criteria = Object.fromEntries(Object.keys(q.criteria).map((k) => [k === key ? nk : k, q.criteria[k]]));
          for (const m of ['structured', 'draft', 'parseErr']) if ('opt.' + key in u[m]) { u[m]['opt.' + nk] = u[m]['opt.' + key]; delete u[m]['opt.' + key]; }
          renderRows(); afterChange();
        });
        const f = entryField(uid, 'opt.' + key, {
          label: 'description', emptyValue: null, placeholder: '(optional) what this option covers',
          get: () => q.criteria[key], set: (v) => { q.criteria[key] = v; },
        });
        const del = el('button', { class: 'icon', type: 'button', title: 'Remove option', text: '✕', onclick: () => {
          delete q.criteria[key]; for (const m of ['structured', 'draft', 'parseErr']) delete u[m]['opt.' + key]; renderRows(); afterChange();
        } });
        rows.append(el('div', { class: 'crit-row' }, keyIn, f, el('div', { class: 'ops' }, del)));
      }
    };
    renderRows();
    crit.append(rows, el('button', { class: 'small crit-add', type: 'button', text: '+ Add option', onclick: () => {
      let n = Object.keys(q.criteria).length + 1, k = 'option_' + n; while (k in q.criteria) k = 'option_' + (++n);
      q.criteria[k] = null; renderRows(); afterChange();
    } }));
  } else if (q.type === 'score') {
    crit.append(el('div', { class: 'hint', text: 'criteria: ordered levels, lowest first (at least 2)' }));
    const rows = el('div', { class: 'crit-rows' });
    const remap = (fn) => { // fn: oldIndex -> newIndex | -1
      for (const m of ['structured', 'draft', 'parseErr']) {
        const nm = {};
        for (const [k, v] of Object.entries(u[m])) {
          if (!k.startsWith('lvl.')) { nm[k] = v; continue; }
          const ni = fn(Number(k.slice(4))); if (ni >= 0) nm['lvl.' + ni] = v;
        }
        u[m] = nm;
      }
    };
    const renderRows = () => {
      rows.replaceChildren();
      q.criteria.forEach((_, i) => {
        const f = entryField(uid, 'lvl.' + i, {
          label: `level ${i}`, emptyValue: '', placeholder: 'description of this level',
          get: () => q.criteria[i], set: (v) => { q.criteria[i] = v; },
        });
        const move = (d) => {
          const j = i + d; if (j < 0 || j >= q.criteria.length) return;
          [q.criteria[i], q.criteria[j]] = [q.criteria[j], q.criteria[i]];
          remap((x) => (x === i ? j : x === j ? i : x)); renderRows(); afterChange();
        };
        const ops = el('div', { class: 'ops' },
          el('button', { class: 'icon', type: 'button', title: 'Move up', text: '↑', disabled: i === 0, onclick: () => move(-1) }),
          el('button', { class: 'icon', type: 'button', title: 'Move down', text: '↓', disabled: i === q.criteria.length - 1, onclick: () => move(1) }),
          el('button', { class: 'icon', type: 'button', title: 'Remove level', text: '✕', onclick: () => {
            q.criteria.splice(i, 1); remap((x) => (x === i ? -1 : x > i ? x - 1 : x)); renderRows(); afterChange();
          } }));
        rows.append(el('div', { class: 'crit-row level' }, el('div', { class: 'idx', text: String(i) }), f, ops));
      });
    };
    renderRows();
    crit.append(rows, el('button', { class: 'small crit-add', type: 'button', text: '+ Add level', onclick: () => { q.criteria.push(''); renderRows(); afterChange(); } }));
  }
  const extra = Object.keys(q).filter((k) => !['type', 'instructions', 'criteria'].includes(k));
  const ex = $('.q-extra', node);
  if (extra.length) { ex.hidden = false; ex.textContent = 'Also carries (preserved, edit in Raw JSON): ' + extra.join(', '); }
  return node;
}

function renderEmpty() {
  let e = $('.empty', cardsBox);
  if (!ws.entries.length) { if (!e) cardsBox.append(el('p', { class: 'empty hint', text: 'No questions yet. Add one or load a preset.' })); }
  else if (e) e.remove();
}
function renderAllCards() {
  cardsBox.replaceChildren(...ws.entries.map(renderCard));
  renderEmpty(); validateAll();
}
function addQuestion(focus = true) {
  let n = ws.entries.length + 1, id = 'question_' + n; while (ws.entries.some((e) => e.id === id)) id = 'question_' + (++n);
  const e = { uid: newUid(), id, q: { type: 'noul', instructions: '' } };
  ws.entries.push(e); const node = renderCard(e); cardsBox.append(node); renderEmpty(); afterChange({ structural: true });
  if (focus) $('.q-id', node).focus();
  return node;
}
function resetWorkspace() {
  ws.stateMode = 'text'; ws.stateText = ''; ws.presetName = ''; ws.pair = null; wsGen++; presetLoadToken++;
  setQuestionsFromObject({}, { keepUi: false });
  rubricA = null; presetSel.value = '';
  rawText.value = ''; rawSerialized = '';
  $$('#questions-pane .seg button')[0].click();
  syncAllFromWorkspace();
  clearResults();
  $$('#state-pane .seg button')[0].click();
  addQuestion(false);
  stateTa.focus();
}
$('#new-btn').addEventListener('click', () => {
  const dirty = ws.stateText.trim() || ws.entries.length;
  if (dirty && !confirm('Start fresh? State, questions and results are cleared. History is kept.')) return;
  resetWorkspace(); toast('Fresh playground. Write a state and define your question.');
});
$('#add-q').addEventListener('click', () => addQuestion());

// ---------------------------------------------------------------------------
// Raw JSON tab
// ---------------------------------------------------------------------------
const rawText = $('#raw-text'), rawStatus = $('#raw-status'), rawBanner = $('#raw-banner');
let rawSerialized = '';
function serializeQuestions() { return JSON.stringify(questionsObject(), null, 2); }
function rawDirty() { return rawText.value !== rawSerialized; }
function syncRawFromCanonical() { rawSerialized = serializeQuestions(); rawText.value = rawSerialized; paintRaw(); }
function paintRaw() {
  const dirty = rawDirty();
  rawBanner.hidden = !dirty; cardsBox.classList.toggle('readonly', dirty); cardsBox.inert = dirty;
  $('#add-q').disabled = dirty;
  if (!dirty) { rawStatus.textContent = 'In sync with cards.'; rawStatus.style.color = ''; }
}
/** Try to commit the raw draft. Returns '' on success or the error message. */
function tryCommitRaw() {
  if (!rawDirty()) return '';
  let parsed;
  try { parsed = JSON.parse(rawText.value); } catch (e) { rawStatus.textContent = 'Parse error: ' + e.message; rawStatus.style.color = 'var(--red)'; return rawStatus.textContent; }
  if (!isPlainObject(parsed)) { rawStatus.textContent = 'The questions map must be a JSON object.'; rawStatus.style.color = 'var(--red)'; return rawStatus.textContent; }
  setQuestionsFromObject(parsed);
  for (const e of ws.entries) { const u = uiFor(e.uid); u.draft = {}; u.parseErr = {}; }   // canonical replaced: drafts are stale
  renderAllCards();
  syncRawFromCanonical();
  renderPairBox();
  return '';
}
rawText.addEventListener('input', () => { paintRaw(); if (rawDirty()) { rawStatus.textContent = 'Draft pending – applies on blur or Apply.'; rawStatus.style.color = 'var(--amber)'; } });
rawText.addEventListener('blur', () => { tryCommitRaw(); });
$('#raw-apply').addEventListener('click', () => { if (!tryCommitRaw()) toast('Raw JSON applied.'); });

$$('#questions-pane .seg button').forEach((b) => b.addEventListener('click', () => {
  $$('#questions-pane .seg button').forEach((x) => x.classList.toggle('active', x === b));
  const raw = b.dataset.tab === 'raw';
  $('#q-raw').hidden = !raw; cardsBox.hidden = raw;
  if (raw && !rawDirty()) syncRawFromCanonical();
}));

// ---------------------------------------------------------------------------
// State pane
// ---------------------------------------------------------------------------
const stateTa = $('#state-text'), stateErr = $('#state-error');
function paintState() {
  const err = ws.stateMode === 'json' ? stateError() : '';
  stateErr.hidden = !err; stateErr.textContent = err;
  paintBatchBox();
  $$('#state-pane .seg button').forEach((b) => b.classList.toggle('active', b.dataset.mode === ws.stateMode));
}
stateTa.addEventListener('input', () => { ws.stateText = stateTa.value; paintState(); });
$$('#state-pane .seg button').forEach((b) => b.addEventListener('click', () => {
  ws.stateMode = b.dataset.mode; paintState();
}));
function setState(value) {
  if (typeof value === 'string') { ws.stateMode = 'text'; ws.stateText = value; }
  else { ws.stateMode = 'json'; ws.stateText = JSON.stringify(value, null, 2); }
  stateTa.value = ws.stateText; paintState();
}

// ---------------------------------------------------------------------------
// Presets
// ---------------------------------------------------------------------------
const presetSel = $('#preset-select');
const presetCache = {};
async function loadPresetList() {
  try {
    const r = await fetch('/presets'); const j = await r.json();
    for (const name of j.presets || []) presetSel.append(el('option', { value: name, text: name.replace(/^\d+-/, '').replace(/-/g, ' ') }));
  } catch (e) { toast('Could not load presets: ' + e.message, true); }
}
async function loadPreset(name) {
  if (!name) return;
  const token = ++presetLoadToken;
  try {
    if (!presetCache[name]) { const r = await fetch('/presets/' + encodeURIComponent(name)); if (!r.ok) throw new Error('HTTP ' + r.status); presetCache[name] = await r.json(); }
    if (token !== presetLoadToken) return;   // superseded by a newer selection or New
    const p = presetCache[name];
    ws.presetName = p.name || name;
    setState(p.state);
    setQuestionsFromObject(clone(p.questions || {}), { keepUi: false });
    wsGen++;
    ws.pair = isPlainObject(p.pair) ? clone(p.pair) : null;
    rubricA = null; paintRubricButtons();
    renderAllCards(); syncRawFromCanonical(); renderPairBox();
    clearResults();
    toast(`Loaded preset "${ws.presetName}".`);
  } catch (e) { toast('Could not load preset: ' + e.message, true); }
}
presetSel.addEventListener('change', () => loadPreset(presetSel.value));

// ---------------------------------------------------------------------------
// Thresholds / banding
// ---------------------------------------------------------------------------
const thrLow = $('#thr-low'), thrHigh = $('#thr-high'), thrErr = $('#thr-error');
function paintThresholds() { thrLow.value = ws.thresholds.low; thrHigh.value = ws.thresholds.high; thrErr.hidden = true; }
function readThresholds() {
  const low = parseFloat(thrLow.value), high = parseFloat(thrHigh.value);
  if (!(low >= 0 && low < high && high <= 1)) { thrErr.hidden = false; thrErr.textContent = 'Require 0 ≤ low < high ≤ 1.'; return false; }
  thrErr.hidden = true; ws.thresholds = { low, high };
  if (lastRun) renderResults(lastRun);
  return true;
}
thrLow.addEventListener('input', readThresholds); thrHigh.addEventListener('input', readThresholds);
const settingsBtn = $('#settings-btn'), settingsPop = $('#settings-pop');
settingsBtn.addEventListener('click', (e) => { e.stopPropagation(); settingsPop.hidden = !settingsPop.hidden; settingsBtn.setAttribute('aria-expanded', String(!settingsPop.hidden)); });
settingsPop.addEventListener('click', (e) => e.stopPropagation());
document.addEventListener('click', () => { settingsPop.hidden = true; settingsBtn.setAttribute('aria-expanded', 'false'); });

const BANDS = {
  conf: [['red', 'escalate'], ['amber', 'confirm'], ['green', 'act']],
  cert: [['red', 'low certainty'], ['amber', 'medium certainty'], ['green', 'high certainty']],
};
function bandIndex(v, thr = ws.thresholds) { return v < thr.low ? 0 : v < thr.high ? 1 : 2; }
function bandChip(kind, v, thr = ws.thresholds) {
  if (typeof v !== 'number') return el('span', { class: 'band', text: 'n/a' });
  const [cls, label] = BANDS[kind][bandIndex(v, thr)];
  return el('span', { class: 'band ' + cls, text: label, title: `${kind === 'conf' ? 'confidence' : 'certainty'} ${v.toFixed(2)} · low ${thr.low} / high ${thr.high}` });
}
const certainty = (noul) => 2 * Math.abs(noul - 0.5);

// ---------------------------------------------------------------------------
// Request building / running
// ---------------------------------------------------------------------------
function buildRequest({ questions = null, state = undefined } = {}) {
  const qs = questions || questionsObject(ws.entries.filter((e) => !e.disabled));
  return { model: ws.model, state: state === undefined ? stateValue() : state, questions: clone(qs) };
}
/** Validates everything and returns a request, or null after surfacing the problem. */
function prepareRequest() {
  const ae = document.activeElement; if (ae && ae !== document.body && typeof ae.blur === 'function') ae.blur();   // commit pending change events (raw draft)
  for (const inp of $$('#q-cards .crit-row .key')) if (inp.value !== inp.dataset.key) inp.dispatchEvent(new Event('change'));   // option keys commit on change; force it
  const rawErr = tryCommitRaw();
  if (rawErr) { $$('#questions-pane .seg button')[1].click(); rawText.focus(); toast('Raw JSON draft does not parse: ' + rawErr, true); return null; }
  const sErr = stateError(); paintState();
  if (sErr) { stateErr.hidden = false; stateErr.textContent = sErr; stateTa.focus(); toast(sErr, true); return null; }
  const v = validateAll();
  if (v.errors.length) { const first = $(`#q-cards .qcard[data-uid="${v.errors[0].uid}"]`); if (first) first.scrollIntoView({ block: 'center' }); toast('Fix the question validation errors first.', true); return null; }
  if (!v.enabledCount) { toast('No enabled questions to run.', true); return null; }
  if (!readThresholds()) { settingsPop.hidden = false; toast('Fix the thresholds first.', true); return null; }
  ws.model = $('#model-id').value.trim() || 'typesafe/jev-1.13';
  return buildRequest();
}
async function decide(request) {
  const t0 = performance.now();
  let result;
  try {
    const r = await fetch('/api/decide', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request) });
    result = await r.json();
  } catch (e) {
    result = { ok: false, status: 0, attempts: 0, error: { message: 'Network error talking to the local server: ' + e.message } };
  }
  if (result.latency_ms === undefined) result.latency_ms = Math.round(performance.now() - t0);
  return result;
}
function setRunning(on, label = 'Running…') {
  running = on; const b = $('#run-btn'); b.disabled = on; b.textContent = on ? 'Running…' : 'Run';
  for (const id of ['#pair-run', '#rubric-run', '#batch-run', '#consist-run']) $(id).disabled = on;
  setProgress(on ? { label } : null);
}
/** Step progress for multi-request runs: stepProgress('batch', i, n) before each request. */
function stepProgress(what, i, n) { setProgress({ label: `${what} ${i}/${n}`, done: i - 0.5, total: n }); }
async function run() {
  if (running) return;
  const request = prepareRequest(); if (!request) return;
  const ctx = dispatchContext();
  setRunning(true);
  try {
    const result = await decide(request);
    const entry = makeHistoryEntry(request, result, ctx);
    pushHistory(entry);
    if (ctx.gen !== wsGen) { toast('Run finished after the workspace was replaced; result saved to History only.'); return; }
    lastRun = entry; renderResults(entry); $('#compare').hidden = true;
  } finally { setRunning(false); }
}
$('#run-btn').addEventListener('click', run);
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); run(); }
  if (e.key === 'Escape') { settingsPop.hidden = true; $('#history-drawer').hidden = true; }
});

// ---------------------------------------------------------------------------
// Results rendering
// ---------------------------------------------------------------------------
function answerCard(qid, qdef, ans, { compact = false, thr = ws.thresholds } = {}) {
  const card = el('div', { class: 'rcard' + (compact ? ' compact' : '') });
  const head = el('div', { class: 'rhead' }, el('span', { class: 'rid', text: qid }));
  card.append(head);
  if (!isPlainObject(ans)) {
    head.append(el('span', { class: 'rtype', text: 'no answer' }));
    card.append(el('pre', { text: ans === undefined ? '(missing from response)' : JSON.stringify(ans, null, 2) }));
    return card;
  }
  const type = ans.type; head.append(el('span', { class: 'rtype', text: String(type ?? '?') }));
  if (!compact && isPlainObject(qdef)) card.append(el('div', { class: 'rinstr', text: summaryText(qdef.instructions) }));
  let structuredSeen = false;
  const noteStructured = (v) => { if (displayLabel(v).structured) structuredSeen = true; };

  if (type === 'noul' && typeof ans.noul === 'number') {
    const v = ans.noul, cert = certainty(v);
    head.append(bandChip('cert', cert, thr));
    const [cls] = BANDS.cert[bandIndex(cert, thr)];
    const gauge = el('div', { class: 'gauge' },
      el('div', { class: 'fill', style: `width:${(v * 100).toFixed(1)}%;background:var(--${cls})` }),
      el('div', { class: 'marker', style: `left:${(v * 100).toFixed(1)}%` }));
    card.append(el('div', { class: 'row' }, el('span', { class: 'bigval', text: v.toFixed(2) }), el('div', { style: 'flex:1' }, gauge, el('div', { class: 'gauge-labels' }, el('span', { text: '0 · no' }), el('span', { text: '0.5' }), el('span', { text: 'yes · 1' })))));
    card.append(el('div', { class: 'rmeta' }, el('span', {}, 'P(yes) ', el('b', { text: v.toFixed(3) })), el('span', {}, 'certainty ', el('b', { text: cert.toFixed(2) }))));
    if (isPlainObject(qdef?.criteria)) { noteStructured(qdef.criteria.true); noteStructured(qdef.criteria.false); }
  } else if (type === 'choice' && isPlainObject(ans.probabilities)) {
    head.append(bandChip('conf', ans.confidence, thr));
    const probs = Object.entries(ans.probabilities).sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0));
    const bars = el('div', { class: 'bars' });
    for (const [k, p] of probs) {
      const desc = get(qdef?.criteria, k);
      noteStructured(desc);
      const dl = desc === undefined ? null : displayLabel(desc, 120);
      bars.append(el('div', { class: 'bar' + (k === ans.choice ? ' winner' : '') },
        el('span', { class: 'k', text: k, title: dl ? (dl.full || dl.text) : k }),
        el('div', { class: 'track' }, el('i', { style: `width:${((p ?? 0) * 100).toFixed(1)}%` })),
        el('span', { class: 'p', text: pct(p) })));
    }
    card.append(bars, el('div', { class: 'rmeta' }, el('span', {}, 'winner ', el('b', { text: String(ans.choice) })), el('span', {}, 'confidence ', el('b', { text: num(ans.confidence) }))));
  } else if (type === 'score' && typeof ans.score === 'number') {
    head.append(bandChip('conf', ans.confidence, thr));
    const legend = isPlainObject(ans.legend) ? ans.legend : (Array.isArray(qdef?.criteria) ? Object.fromEntries(qdef.criteria.map((v, i) => [String(i), v])) : {});
    const keys = Object.keys(legend).sort((a, b) => Number(a) - Number(b));
    const n = Math.max(keys.length, 2);
    const line = el('div', { class: 'numline' });
    keys.forEach((k, i) => {
      noteStructured(legend[k]);
      const x = (i / (n - 1)) * 100;
      line.append(el('div', { class: 'tick', style: `left:${x}%` }));
      const lab = labelNode(legend[k], 24); lab.classList.add('tlabel'); if (i === 0) lab.classList.add('first'); if (i === keys.length - 1) lab.classList.add('last'); lab.style.left = x + '%'; lab.title = lab.title || `${k}: ${displayLabel(legend[k], 200).text}`;
      line.append(lab);
    });
    const x = Math.min(1, Math.max(0, ans.score / (n - 1))) * 100;
    line.append(el('div', { class: 'dot', style: `left:${x}%` }, el('span', { text: ans.score.toFixed(2) })));
    card.append(line);
    const probs = isPlainObject(ans.probabilities) ? ans.probabilities : {};
    let best = null;
    for (const k of keys) if (best === null || (probs[k] ?? 0) > (probs[best] ?? 0)) best = k;
    const bars = el('div', { class: 'bars' });
    for (const k of keys) {
      const p = probs[k];
      bars.append(el('div', { class: 'bar' + (k === best ? ' winner' : '') },
        el('span', { class: 'k' }, k + ' · ', labelNode(legend[k], 30)),
        el('div', { class: 'track' }, el('i', { style: `width:${((p ?? 0) * 100).toFixed(1)}%` })),
        el('span', { class: 'p', text: pct(p) })));
    }
    card.append(bars, el('div', { class: 'rmeta' }, el('span', {}, 'score ', el('b', { text: ans.score.toFixed(3) })), el('span', {}, 'top level ', el('b', { text: String(best) })), el('span', {}, 'confidence ', el('b', { text: num(ans.confidence) }))));
  } else {
    head.append(el('span', { class: 'band', text: 'unknown type – raw' }));
    card.append(el('pre', { text: JSON.stringify(ans, null, 2) }));
    return card;
  }
  if (structuredSeen || !compact) {
    const full = { answer: ans };
    if (isPlainObject(qdef) && 'criteria' in qdef) full.criteria = qdef.criteria;
    card.append(el('details', { class: 'full' }, el('summary', { text: structuredSeen ? 'Full legend / criteria JSON (structured labels present)' : 'Raw answer JSON' }), el('pre', { text: JSON.stringify(full, null, 2) })));
  }
  return card;
}

function setStats(result) {
  const usage = result?.ok && isPlainObject(result.response) ? result.response.usage || {} : {};
  $('#stat-latency').textContent = result && typeof result.latency_ms === 'number' ? result.latency_ms + ' ms' + (result.attempts > 1 ? ` (${result.attempts} attempts)` : '') : '–';
  $('#stat-tokens').textContent = typeof usage.input_tokens === 'number' ? String(usage.input_tokens) : '–';
  $('#stat-cost').textContent = fmtUsd(usage.cost);
}
function clearResults() {
  lastRun = null;
  $('#results').replaceChildren(el('p', { class: 'empty', text: 'Load a preset or write questions, then press Run.' }));
  $('#result-title').textContent = '';
  $('#run-error').hidden = true;
  $('#diff').hidden = true;
  $('#explorer').hidden = true; $('#explorer-toggle').hidden = true;
  $('#raw-request-box').hidden = true; $('#raw-response-box').hidden = true;
  $('#compare').hidden = true;
  setStats(null);
  renderHistoryList();
}
function renderResults(entry) {
  const { request, result } = entry;
  const box = $('#results'), err = $('#run-error');
  $('#raw-request').textContent = JSON.stringify(request, null, 2); $('#raw-request-box').hidden = false;
  $('#raw-response').textContent = JSON.stringify(result.ok ? result.response : result, null, 2); $('#raw-response-box').hidden = false;
  $('#result-title').textContent = `${new Date(entry.ts).toLocaleTimeString()}${entry.preset ? ' · ' + entry.preset : ''}`;
  setStats(result);
  box.replaceChildren();
  if (!result.ok) {
    err.hidden = false;
    const e = unwrapError(result.error), msg = errorText(result);
    err.replaceChildren(el('div', {}, el('b', { text: `Request failed (upstream status ${result.status}, ${result.attempts} attempt${result.attempts === 1 ? '' : 's'}).` })),
      el('div', { text: msg }), e?.path ? el('div', { class: 'hint', text: 'field: ' + e.path }) : null);
    box.append(el('p', { class: 'empty', text: 'No results.' }));
    $('#diff').hidden = true; $('#explorer-toggle').hidden = true; $('#explorer').hidden = true;
    return;
  }
  err.hidden = true;
  const answers = isPlainObject(result.response?.answers) ? result.response.answers : {};
  for (const qid of Object.keys(request.questions)) box.append(answerCard(qid, request.questions[qid], get(answers, qid)));
  for (const qid of Object.keys(answers)) if (!own(request.questions, qid)) box.append(answerCard(qid + ' (not in request)', null, answers[qid]));
  if (!Object.keys(request.questions).length) box.append(el('p', { class: 'empty', text: 'Empty answers.' }));
  renderDiff(entry);
  $('#explorer-toggle').hidden = false; renderExplorer(entry);
}

// ---------------------------------------------------------------------------
// History + diff
// ---------------------------------------------------------------------------
const HKEY = 'jevlab.history.v1';
let history = [];
try { history = JSON.parse(localStorage.getItem(HKEY) || '[]'); if (!Array.isArray(history)) history = []; } catch (e) { history = []; }
function saveHistory() { try { localStorage.setItem(HKEY, JSON.stringify(history)); } catch (e) { toast('Could not persist history: ' + e.message, true); } }
/** Capture what a run is about before dispatch, so a response is filed against the workspace that produced it. */
function dispatchContext(label = '') { return { workspace: snapshotWorkspace(), preset: ws.presetName, label, gen: wsGen }; }
function makeHistoryEntry(request, result, ctx) {
  const usage = result.ok && isPlainObject(result.response) ? result.response.usage || {} : {};
  return {
    id: 'h' + Date.now() + Math.random().toString(36).slice(2, 6),
    ts: Date.now(), preset: ctx.preset || '', label: ctx.label || '',
    workspace: ctx.workspace,
    request: clone(request), result: clone(result),
    failed: !result.ok, latency_ms: result.latency_ms, cost: usage.cost, input_tokens: usage.input_tokens,
  };
}
function pushHistory(entry) { history.push(entry); if (history.length > 100) history = history.slice(-100); saveHistory(); renderHistoryList(); }
function prevSuccessfulBefore(entry) {
  const i = history.findIndex((h) => h.id === entry.id);
  for (let j = (i === -1 ? history.length : i) - 1; j >= 0; j--) if (!history[j].failed) return history[j];
  return null;
}
function renderHistoryList() {
  const ul = $('#history-list'); ul.replaceChildren();
  $('#history-count').textContent = String(history.length);
  for (const h of history.slice().reverse()) {
    const li = el('li', { class: (h.failed ? 'failed' : '') + (lastRun && lastRun.id === h.id ? ' current' : ''), onclick: () => { restoreEntry(h); } },
      el('div', { class: 't', text: new Date(h.ts).toLocaleString() }),
      el('div', { class: 'n', text: (h.label ? h.label + ' · ' : '') + (h.preset || '(no preset)') + (h.failed ? ' · failed' : '') }),
      el('div', { class: 'm', text: `${Object.keys(h.request?.questions || {}).length} q · ${h.latency_ms ?? '–'} ms · ${fmtUsd(h.cost)}` }));
    ul.append(li);
  }
  if (!history.length) ul.append(el('li', { class: 'hint', text: 'No runs yet.' }));
}
function restoreEntry(h) {
  applyWorkspace(h.workspace || {});
  lastRun = h; renderResults(h); $('#compare').hidden = true; renderHistoryList();
  $('#history-drawer').hidden = true;
  toast('Restored run from ' + new Date(h.ts).toLocaleString());
}
$('#history-btn').addEventListener('click', () => { $('#history-drawer').hidden = false; renderHistoryList(); });
$('#history-close').addEventListener('click', () => { $('#history-drawer').hidden = true; });
$('#history-clear').addEventListener('click', () => { if (confirm('Clear all history?')) { history = []; saveHistory(); renderHistoryList(); } });

function computeDiff(cur, prev) {
  const out = { changed: [], same: [], rubricChanged: [], noAnswer: [], prevTs: prev.ts };
  const ca = cur.result.response?.answers || {}, pa = prev.result.response?.answers || {};
  for (const id of Object.keys(cur.request.questions)) {
    if (!own(prev.request.questions, id)) continue;
    if (JSON.stringify(cur.request.questions[id]) !== JSON.stringify(prev.request.questions[id])) { out.rubricChanged.push(id); continue; }
    const a = get(pa, id), b = get(ca, id);
    if (!isPlainObject(a) || !isPlainObject(b) || a.type !== b.type) { out.noAnswer.push(id); continue; }
    let note = null;
    if (b.type === 'noul') { if ((a.noul >= 0.5) !== (b.noul >= 0.5)) note = `crossed 0.5: ${num(a.noul)} → ${num(b.noul)}`; }
    else if (b.type === 'choice') { if (a.choice !== b.choice) note = `winner ${a.choice} → ${b.choice}`; }
    else if (b.type === 'score') {
      const top = (x) => { const p = x.probabilities || {}; return Object.keys(p).sort((i, j) => (p[j] ?? 0) - (p[i] ?? 0))[0]; };
      const ta = top(a), tb = top(b);
      if (ta !== tb) note = `top level ${ta} → ${tb}`;
      else if (Math.abs((b.score ?? 0) - (a.score ?? 0)) >= 0.5) note = `score ${num(a.score)} → ${num(b.score)}`;
    }
    if (note) out.changed.push({ id, note }); else out.same.push(id);
  }
  return out;
}
function renderDiff(entry) {
  const box = $('#diff'); const prev = prevSuccessfulBefore(entry);
  if (!prev || entry.failed) { box.hidden = true; return; }
  const d = computeDiff(entry, prev);
  box.hidden = false; box.replaceChildren(el('h4', { text: `Diff with previous successful run (${new Date(prev.ts).toLocaleTimeString()}${prev.preset ? ' · ' + prev.preset : ''})` }));
  if (d.changed.length) box.append(el('div', {}, el('span', { class: 'chg', text: `${d.changed.length} changed:` }), el('ul', {}, d.changed.map((c) => el('li', {}, el('code', { text: c.id }), ' ', c.note)))));
  else box.append(el('div', { text: d.same.length ? 'No changes among comparable questions.' : 'Nothing comparable.' }));
  if (d.same.length) box.append(el('div', { class: 'hint', text: 'unchanged: ' + d.same.join(', ') }));
  if (d.rubricChanged.length) box.append(el('div', { class: 'hint', text: 'rubric changed, not compared: ' + d.rubricChanged.join(', ') }));
  if (d.noAnswer.length) box.append(el('div', { class: 'hint', text: 'answer missing or of a different type in one run, not compared: ' + d.noAnswer.join(', ') }));
}

// ---------------------------------------------------------------------------
// Tier A.1 – Export / import
// ---------------------------------------------------------------------------
$('#export-btn').addEventListener('click', () => {
  ws.model = $('#model-id').value.trim() || ws.model;
  download(`jev-playground-${new Date().toISOString().replace(/[:.]/g, '-')}.json`, JSON.stringify({ app: 'jev-playground', version: 1, ...snapshotWorkspace(), pair: ws.pair }, null, 2));
});
$('#import-btn').addEventListener('click', () => $('#import-file').click());
$('#import-file').addEventListener('change', async (e) => {
  const f = e.target.files[0]; e.target.value = ''; if (!f) return;
  try {
    const j = JSON.parse(await f.text());
    if (!isPlainObject(j) || !isPlainObject(j.questions)) throw new Error('expected an object with a "questions" map');
    applyWorkspace(j); ws.pair = isPlainObject(j.pair) ? j.pair : null; renderPairBox();
    toast(`Imported ${f.name}.`);
  } catch (err) { toast('Import failed: ' + err.message, true); }
});

// ---------------------------------------------------------------------------
// Tier A.2 – Threshold explorer
// ---------------------------------------------------------------------------
const explorer = $('#explorer'), slider = $('#explorer-slider');
$('#explorer-toggle').addEventListener('click', () => { explorer.hidden = !explorer.hidden; if (lastRun) renderExplorer(lastRun); });
slider.addEventListener('input', () => { if (lastRun) renderExplorer(lastRun, parseFloat(slider.value)); });
function renderExplorer(entry, high = null) {
  if (explorer.hidden || entry.failed) return;
  const thr = ws.thresholds;
  slider.min = thr.low; slider.max = 1; slider.step = 0.01;
  if (high === null) { high = thr.high; slider.value = high; }
  $('#explorer-val').textContent = high.toFixed(2) + (high === thr.high ? ' (current)' : ` (current ${thr.high})`);
  const answers = entry.result.response?.answers || {};
  const rows = [];
  for (const [id, a] of Object.entries(answers)) {
    if (!isPlainObject(a) || typeof a.confidence !== 'number' || !['choice', 'score'].includes(a.type)) continue;
    const now = BANDS.conf[bandIndex(a.confidence, thr)][1], then = BANDS.conf[bandIndex(a.confidence, { low: thr.low, high })][1];
    rows.push({ id, c: a.confidence, now, then, flip: now !== then });
  }
  const out = $('#explorer-out'); out.replaceChildren();
  if (!rows.length) { out.append(el('div', { class: 'hint', text: 'No Choice/Score answers to explore.' })); return; }
  const flips = rows.filter((r) => r.flip).length;
  out.append(el('div', { text: `${flips} of ${rows.length} would change band at high = ${high.toFixed(2)}.` }),
    el('table', {}, el('tr', {}, el('th', { text: 'id' }), el('th', { text: 'confidence' }), el('th', { text: 'now' }), el('th', { text: 'at slider' })),
      rows.map((r) => el('tr', { class: r.flip ? 'flip' : '' }, el('td', {}, el('code', { text: r.id })), el('td', { text: r.c.toFixed(2) }), el('td', { text: r.now }), el('td', { text: r.then + (r.flip ? ' ⟵ flips' : '') })))));
}

// ---------------------------------------------------------------------------
// Shared side-by-side compare view (Tier A.3 / A.4)
// ---------------------------------------------------------------------------
function renderCompare({ title, colA, colB, rows, verdict, extras = [] }) {
  const box = $('#compare'); box.hidden = false; box.replaceChildren(el('h3', { text: title }));
  if (verdict) box.append(el('div', { class: 'verdict ' + (verdict.ok ? 'ok' : 'bad'), text: verdict.text }));
  box.append(el('div', { class: 'pairgrid' }, el('div', { class: 'colhead', text: colA }), el('div', { class: 'colhead', text: colB })));
  for (const r of rows) {
    const g = el('div', { class: 'pairgrid' + (r.highlight ? ' expected' : '') }, answerCard(r.qid, r.defA, r.ansA, { compact: true }), answerCard(r.qid, r.defB, r.ansB, { compact: true }));
    box.append(g);
  }
  for (const [label, obj] of extras) box.append(el('details', {}, el('summary', { text: label }), el('pre', { text: JSON.stringify(obj, null, 2) })));
  box.scrollIntoView({ block: 'nearest' });
}
/** The envelope's error is the upstream body verbatim ({"error": {...}}) or our own {"message", "path"}. */
function unwrapError(err) { return isPlainObject(err) && isPlainObject(err.error) ? err.error : err; }
function errorText(result) { const e = unwrapError(result.error); return isPlainObject(e) ? (e.message || JSON.stringify(e)) : String(e); }

// ---------------------------------------------------------------------------
// Tier A.3 – Boundary pairs
// ---------------------------------------------------------------------------
function renderPairBox() {
  const p = ws.pair, box = $('#pair-box');
  const ok = isPlainObject(p) && 'state_a' in p && 'state_b' in p && typeof p.question_id === 'string' && ws.entries.some((e) => e.id === p.question_id);
  box.hidden = !ok; if (!ok) return;
  $('#pair-label').textContent = `Boundary pair: ${p.label || ''} (expect ${p.question_id} ${typeof p.expect === 'string' ? p.expect : JSON.stringify(p.expect)})`;
}
function pairVerdict(p, a, b) {
  if (!isPlainObject(a) || !isPlainObject(b)) return { ok: false, text: 'Expectation could not be evaluated: answer missing.' };
  const val = (x) => (x.type === 'noul' ? x.noul : x.type === 'score' ? x.score : undefined);
  const e = p.expect;
  if (e === 'up' || e === 'down') {
    const va = val(a), vb = val(b);
    if (typeof va !== 'number' || typeof vb !== 'number') return { ok: false, text: `Expectation "${e}" needs a noul or score answer on ${p.question_id}.` };
    const held = e === 'up' ? vb > va : vb < va;
    return { ok: held, text: `${held ? 'Expectation held' : 'Expectation FAILED'}: ${p.question_id} ${e} · A = ${va.toFixed(2)}, B = ${vb.toFixed(2)}` };
  }
  if (e === 'change' || e === 'same') { const held = e === 'change' ? a.choice !== b.choice : a.choice === b.choice; return { ok: held, text: `${held ? 'Expectation held' : 'Expectation FAILED'}: winner ${e} · A = ${a.choice}, B = ${b.choice}` }; }
  if (isPlainObject(e) && typeof e.winner_b === 'string') { const held = b.choice === e.winner_b; return { ok: held, text: `${held ? 'Expectation held' : 'Expectation FAILED'}: B winner should be ${e.winner_b} · A = ${a.choice}, B = ${b.choice}` }; }
  return { ok: false, text: 'Unknown expectation format: ' + JSON.stringify(e) };
}
$('#pair-run').addEventListener('click', async () => {
  if (running) return;
  const p = ws.pair; const base = prepareRequest(); if (!base) return;
  if (!own(base.questions, p.question_id)) { toast(`Enable question "${p.question_id}" to run the pair.`, true); return; }
  const ctxA = dispatchContext('pair A'), ctxB = dispatchContext('pair B');
  setRunning(true);
  try {
    const reqA = { ...base, state: p.state_a }, reqB = { ...base, state: p.state_b };
    stepProgress('Pair A/B', 1, 2);
    const resA = await decide(reqA); const entA = makeHistoryEntry(reqA, resA, ctxA); pushHistory(entA);
    if (ctxA.gen !== wsGen) return;
    if (!resA.ok) { lastRun = entA; renderResults(entA); toast('Pair run A failed: ' + errorText(resA), true); return; }
    stepProgress('Pair A/B', 2, 2);
    const resB = await decide(reqB); const entB = makeHistoryEntry(reqB, resB, ctxB); pushHistory(entB);
    if (ctxB.gen !== wsGen) return;
    lastRun = entB; renderResults(entB);
    if (!resB.ok) { toast('Pair run B failed: ' + errorText(resB), true); return; }
    const aA = resA.response.answers || {}, aB = resB.response.answers || {};
    renderCompare({
      title: `Boundary pair · ${p.label || ws.presetName}`,
      colA: 'State A', colB: 'State B',
      verdict: pairVerdict(p, get(aA, p.question_id), get(aB, p.question_id)),
      rows: Object.keys(base.questions).map((qid) => ({ qid, defA: base.questions[qid], defB: base.questions[qid], ansA: get(aA, qid), ansB: get(aB, qid), highlight: qid === p.question_id })),
      extras: [['Request A', reqA], ['Request B', reqB], ['Response A', resA.response], ['Response B', resB.response]],
    });
  } finally { setRunning(false); }
});

// ---------------------------------------------------------------------------
// Tier A.4 – Rubric comparison
// ---------------------------------------------------------------------------
function paintRubricButtons() {
  const has = !!rubricA;
  $('#rubric-run').hidden = !has;
  $('#rubric-snapshot').textContent = has ? 'Re-snapshot A' : 'Snapshot as A';
  $('#rubric-snapshot').title = has ? `Revision A frozen with ${Object.keys(rubricA.questions).length} questions. Edit the cards to make revision B.` : 'Freeze the current questions as revision A for rubric comparison';
}
$('#rubric-snapshot').addEventListener('click', () => {
  if (tryCommitRaw()) { toast('Apply the raw draft first.', true); return; }
  const v = validateAll(); if (v.errors.length) { toast('Fix validation errors before snapshotting.', true); return; }
  const sErr = stateError(); if (sErr) { toast(sErr, true); return; }
  rubricA = { questions: clone(questionsObject()), disabled: disabledIds(), stateMode: ws.stateMode, stateText: ws.stateText };
  paintRubricButtons(); toast('Revision A frozen (questions + state). Now edit the questions to create revision B, then Run A vs B.');
});
$('#rubric-run').addEventListener('click', async () => {
  if (running || !rubricA) return;
  const base = prepareRequest(); if (!base) return;
  const frozenState = rubricA.stateMode === 'text' ? rubricA.stateText : JSON.parse(rubricA.stateText);
  const qA = Object.fromEntries(Object.entries(rubricA.questions).filter(([id]) => !rubricA.disabled.includes(id)));
  if (!Object.keys(qA).length) { toast('Revision A has no enabled questions.', true); return; }
  const reqA = { model: base.model, state: frozenState, questions: clone(qA) }, reqB = { ...base, state: frozenState };
  const ctxA = dispatchContext('rubric A'), ctxB = dispatchContext('rubric B');
  setRunning(true);
  try {
    stepProgress('Rubric A/B', 1, 2);
    const resA = await decide(reqA); const entA = makeHistoryEntry(reqA, resA, ctxA); pushHistory(entA);
    if (ctxA.gen !== wsGen) return;
    if (!resA.ok) { lastRun = entA; renderResults(entA); toast('Revision A failed: ' + errorText(resA), true); return; }
    stepProgress('Rubric A/B', 2, 2);
    const resB = await decide(reqB); const entB = makeHistoryEntry(reqB, resB, ctxB); pushHistory(entB);
    if (ctxB.gen !== wsGen) return;
    lastRun = entB; renderResults(entB);
    if (!resB.ok) { toast('Revision B failed: ' + errorText(resB), true); return; }
    const aA = resA.response.answers || {}, aB = resB.response.answers || {};
    const ids = Array.from(new Set([...Object.keys(qA), ...Object.keys(base.questions)]));
    renderCompare({
      title: 'Rubric comparison · same state, two question revisions',
      colA: 'Revision A (frozen)', colB: 'Revision B (current)',
      rows: ids.map((qid) => ({ qid, defA: get(qA, qid), defB: get(base.questions, qid), ansA: get(aA, qid), ansB: get(aB, qid), highlight: JSON.stringify(get(qA, qid)) !== JSON.stringify(get(base.questions, qid)) })),
      extras: [['Request A', reqA], ['Request B', reqB], ['Response A', resA.response], ['Response B', resB.response]],
    });
  } finally { setRunning(false); }
});


// ---------------------------------------------------------------------------
// Tier B.5 – Batch mode (state is a JSON array: one request per element)
// ---------------------------------------------------------------------------
function batchStates() {
  if (ws.stateMode !== 'json') return null;
  try { const v = JSON.parse(ws.stateText); return Array.isArray(v) && v.length > 1 ? v : null; } catch (e) { return null; }
}
function paintBatchBox() {
  const st = batchStates(); const box = $('#batch-box'); box.hidden = !st; if (!st) return;
  $('#batch-label').textContent = `State is an array of ${st.length}: run every question set against each element?`;
}
function cellSummary(a) {
  if (!isPlainObject(a)) return el('span', { class: 'err', text: '–' });
  if (a.type === 'noul' && typeof a.noul === 'number') return el('span', {}, el('span', { class: 'v', text: a.noul.toFixed(2) }));
  if (a.type === 'choice') return el('span', {}, el('span', { class: 'v', text: String(a.choice) }), ` ${num(a.confidence)}`);
  if (a.type === 'score' && typeof a.score === 'number') return el('span', {}, el('span', { class: 'v', text: a.score.toFixed(2) }), ` ${num(a.confidence)}`);
  return el('span', { text: JSON.stringify(a).slice(0, 30) });
}
$('#batch-run').addEventListener('click', async () => {
  if (running) return;
  const states = batchStates(); if (!states) return;
  const base = prepareRequest(); if (!base) return;
  const qids = Object.keys(base.questions);
  const ctx = dispatchContext();
  setRunning(true);
  const rows = [];
  try {
    for (let i = 0; i < states.length; i++) {
      if (ctx.gen !== wsGen) break;   // workspace replaced mid-batch: stop dispatching
      const st = states[i];
      if (st === null || typeof st === 'number' || typeof st === 'boolean' || (typeof st === 'string' && !st.trim())) { rows.push({ i, st, error: 'invalid state (must be non-empty string, object or array)' }); continue; }
      stepProgress('Batch', i + 1, states.length);
      const req = { ...base, state: st }; const res = await decide(req);
      pushHistory(makeHistoryEntry(req, res, { ...ctx, label: `batch ${i + 1}/${states.length}` }));
      rows.push({ i, st, res, answers: res.ok ? res.response.answers || {} : null, error: res.ok ? null : errorText(res) });
    }
  } finally { setRunning(false); }
  if (ctx.gen !== wsGen) { toast('Batch stopped: the workspace was replaced. Completed states are in History.'); return; }
  const box = $('#compare'); box.hidden = false; box.replaceChildren(el('h3', { text: `Batch · ${states.length} states × ${qids.length} questions` }));
  const table = el('table', {}, el('tr', {}, el('th', { text: '#' }), el('th', { text: 'state' }), qids.map((q) => el('th', { text: q }))));
  for (const r of rows) {
    const cells = r.error ? [el('td', { class: 'err', colspan: qids.length, text: r.error })] : qids.map((q) => el('td', {}, cellSummary(get(r.answers, q))));
    table.append(el('tr', {}, el('td', { text: String(r.i + 1) }), el('td', { class: 'state', title: summaryText(r.st, 400), text: summaryText(r.st, 60) }), cells));
  }
  box.append(el('div', { class: 'matrix' }, table), el('div', { class: 'hint', text: 'Cells: Noul = P(yes); Choice = winner + confidence; Score = weighted score + confidence. Each state is a separate history entry.' }));
  box.scrollIntoView({ block: 'nearest' });
});

// ---------------------------------------------------------------------------
// Tier B.7 – Self-consistency (same request N times)
// ---------------------------------------------------------------------------
$('#consist-run').addEventListener('click', async () => {
  if (running) return;
  const n = Math.min(5, Math.max(2, parseInt($('#consist-n').value, 10) || 5));
  const req = prepareRequest(); if (!req) return;
  const ctx = dispatchContext();
  setRunning(true);
  const runs = []; let last = null;
  try {
    for (let i = 0; i < n; i++) {
      stepProgress('Run ×N', i + 1, n);
      const res = await decide(req); const ent = makeHistoryEntry(req, res, { ...ctx, label: `consistency ${i + 1}/${n}` }); pushHistory(ent);
      if (ctx.gen !== wsGen) { toast('Run ×N stopped: the workspace was replaced. Completed runs are in History.'); return; }
      if (!res.ok) { lastRun = ent; renderResults(ent); toast(`Run ${i + 1} failed: ${errorText(res)}`, true); return; }
      runs.push(res.response.answers || {}); last = ent;
    }
  } finally { setRunning(false); }
  lastRun = last; renderResults(lastRun);
  const box = $('#compare'); box.hidden = false; box.replaceChildren(el('h3', { text: `Self-consistency · ${runs.length} identical requests` }));
  const table = el('table', {}, el('tr', {}, el('th', { text: 'id' }), el('th', { text: 'type' }), el('th', { text: 'summary' })));
  for (const qid of Object.keys(req.questions)) {
    const as = runs.map((r) => get(r, qid)).filter(isPlainObject);
    const type = as[0]?.type;
    let summary;
    if (type === 'noul' || type === 'score') {
      const vals = as.map((a) => (type === 'noul' ? a.noul : a.score)).filter((v) => typeof v === 'number');
      summary = vals.length ? `min ${Math.min(...vals).toFixed(2)} · max ${Math.max(...vals).toFixed(2)} · spread ${(Math.max(...vals) - Math.min(...vals)).toFixed(2)}` : 'no numeric values';
    } else if (type === 'choice') {
      const freq = new Map(); for (const a of as) freq.set(String(a.choice), (freq.get(String(a.choice)) || 0) + 1);   // Map: option names like "constructor" are ordinary keys
      summary = [...freq.entries()].sort((a, b) => b[1] - a[1]).map(([k, c]) => `${k} ${c}/${as.length}`).join(', ');
    } else summary = 'unknown type';
    table.append(el('tr', {}, el('td', {}, el('code', { text: qid })), el('td', { text: String(type ?? '?') }), el('td', { text: summary })));
  }
  box.append(el('div', { class: 'matrix' }, table), el('div', { class: 'hint', text: 'Results pane shows the last run; every run is in History.' }));
  box.scrollIntoView({ block: 'nearest' });
});

// ---------------------------------------------------------------------------
// cURL, model info, config
// ---------------------------------------------------------------------------
$('#curl-btn').addEventListener('click', async () => {
  const request = prepareRequest(); if (!request) return;
  const body = JSON.stringify(request).replace(/'/g, `'\\''`);
  const cmd = `curl -sS -X POST '${config.endpoint}' \\\n  -H "Authorization: Bearer $OPENROUTER_API_KEY" \\\n  -H 'Content-Type: application/json' \\\n  -d '${body}'`;
  toast((await copyText(cmd)) ? 'cURL command copied (key redacted as $OPENROUTER_API_KEY).' : 'Clipboard unavailable.', false);
});
let modelInfoTimer = null;
async function loadModelInfo() {
  const model = $('#model-id').value.trim() || 'typesafe/jev-1.13';
  ws.model = model;
  const meta = $('#model-meta');
  try {
    const r = await fetch('/api/model-info?model=' + encodeURIComponent(model)); const j = await r.json();
    const ep = j.ok && j.response?.data?.endpoints?.[0];
    if (!ep) { meta.textContent = j.ok ? 'no endpoint info' : 'model info: ' + (j.response?.error?.message || `HTTP ${j.status}`); return; }
    const price = parseFloat(ep.pricing?.prompt || '0') * 1e6;
    meta.textContent = `ctx ${Math.round((ep.context_length || 0) / 1000)}k · $${price.toFixed(3)}/M input · p50 ${ep.latency_last_30m?.p50 ?? '?'} ms`;
    meta.title = `${ep.name} · uptime 30m ${ep.uptime_last_30m}%${j.cached ? ' · cached' : ''}`;
  } catch (e) { meta.textContent = 'model info unavailable'; }
}
$('#model-id').addEventListener('input', () => { clearTimeout(modelInfoTimer); modelInfoTimer = setTimeout(loadModelInfo, 600); });
async function loadConfig() {
  try {
    const r = await fetch('/api/config'); const j = await r.json(); config = { ...config, ...j };
    if (!j.has_key) toast('OPENROUTER_API_KEY is not set in the server environment. Runs will fail until you export it and restart server.py.', true, true);
  } catch (e) { /* server missing; runs will report it */ }
}

// ---------------------------------------------------------------------------
// Themes (per-browser preference in localStorage)
// ---------------------------------------------------------------------------
const THEMES = ['system', 'light', 'dark', 'nord', 'solarized', 'dracula', 'gruvbox', 'rose', 'synthwave', 'cyberlime', 'lagoon', 'aurora'];
function applyTheme(name) {
  if (!THEMES.includes(name)) name = 'system';
  if (name === 'system') delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = name;
  $('#theme-select').value = name;
  try { localStorage.setItem('jevlab.theme', name); } catch (e) { /* private mode */ }
}
$('#theme-select').addEventListener('change', (e) => applyTheme(e.target.value));
(function initTheme() { let t = 'system'; try { t = localStorage.getItem('jevlab.theme') || 'system'; } catch (e) { /* ignore */ } applyTheme(t); })();

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
function syncAllFromWorkspace() {
  $('#model-id').value = ws.model; stateTa.value = ws.stateText; paintState(); paintThresholds();
  renderAllCards(); syncRawFromCanonical(); renderPairBox(); paintRubricButtons();
}
(function trackHeaderHeight() {
  const hdr = $('#topbar');
  const apply = () => document.documentElement.style.setProperty('--header-h', hdr.offsetHeight + 'px');
  apply(); if ('ResizeObserver' in window) new ResizeObserver(apply).observe(hdr); else window.addEventListener('resize', apply);
})();
(async function init() {
  syncAllFromWorkspace();
  renderHistoryList();
  await Promise.all([loadConfig(), loadPresetList()]);
  loadModelInfo();
})();

})();
