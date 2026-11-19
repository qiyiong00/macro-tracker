import { store, dayKey, parseDay, MODELS, ACTIVITY, GOALS, calcTargets } from './store.js';
import { getChat, resetChat, sendMessage, prepareImage } from './ai.js';

const $ = (sel, root = document) => root.querySelector(sel);
const view = $('#view');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const r0 = (n) => Math.round(n);
const pct = (v, t) => (t > 0 ? Math.min(100, (v / t) * 100) : 0);

let tab = 'today';
let viewDay = dayKey();

// ---------------- navigation ----------------
document.querySelectorAll('.tabbar button').forEach((b) =>
  b.addEventListener('click', () => go(b.dataset.tab)),
);
function go(t) {
  tab = t;
  document.querySelectorAll('.tabbar button').forEach((b) => b.classList.toggle('active', b.dataset.tab === t));
  render();
  window.scrollTo(0, 0);
}
function render() {
  ({ today: renderToday, chat: renderChat, history: renderHistory, settings: renderSettings })[tab]();
}

// ---------------- toast ----------------
let toastTimer;
function toast(text, actionLabel, action) {
  const el = $('#toast');
  el.innerHTML = `<span>${esc(text)}</span>${actionLabel ? `<button>${esc(actionLabel)}</button>` : ''}`;
  el.hidden = false;
  if (actionLabel) el.querySelector('button').onclick = () => { el.hidden = true; action(); };
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 4000);
}

// ---------------- Today ----------------
function dayTitle(key) {
  const today = dayKey();
  const y = new Date(); y.setDate(y.getDate() - 1);
  if (key === today) return 'Today';
  if (key === dayKey(y)) return 'Yesterday';
  return parseDay(key).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
}
function shiftDay(key, n) {
  const d = parseDay(key); d.setDate(d.getDate() + n); return dayKey(d);
}

function macroBlock(label, val, target, color) {
  return `<div class="macro">
    <div class="lbl">${label}</div>
    <div class="val">${r0(val)}<small> / ${r0(target)} g</small></div>
    <div class="bar"><div style="width:${pct(val, target)}%;background:${color}"></div></div>
  </div>`;
}

function renderToday() {
  const t = store.targets;
  const s = store.totals(viewDay);
  const left = t.calories - s.calories;
  const entries = [...store.entries(viewDay)].sort((a, b) => a.time - b.time);
  const isToday = viewDay === dayKey();

  view.innerHTML = `
    <div class="datebar">
      <button id="prev" aria-label="Previous day">‹</button>
      <h1>${dayTitle(viewDay)}</h1>
      <button id="next" aria-label="Next day" ${isToday ? 'disabled' : ''}>›</button>
    </div>

    <section class="card">
      <div class="kcal-big"><span class="n">${r0(s.calories)}</span><span class="of">/ ${r0(t.calories)} kcal</span></div>
      <div class="bar"><div style="width:${pct(s.calories, t.calories)}%;background:var(--kcal)"></div></div>
      <div class="left ${left < 0 ? 'over' : ''}">${left >= 0 ? `${r0(left)} kcal left` : `${r0(-left)} kcal over`}</div>
      <div class="macros">
        ${macroBlock('Protein', s.protein, t.protein, 'var(--protein)')}
        ${macroBlock('Carbs', s.carbs, t.carbs, 'var(--carbs)')}
        ${macroBlock('Fat', s.fat, t.fat, 'var(--fat)')}
      </div>
    </section>

    <div class="actions">
      <button class="primary" id="addBtn">+ Add food</button>
      ${isToday ? '<button class="secondary" id="askBtn">✦ Ask AI / photo</button>' : ''}
    </div>

    <section class="card">
      <h2>Food log</h2>
      ${entries.length ? entries.map(entryRow).join('') : '<p class="muted">Nothing logged yet.</p>'}
    </section>`;

  $('#prev').onclick = () => { viewDay = shiftDay(viewDay, -1); renderToday(); };
  $('#next').onclick = () => { if (!isToday) { viewDay = shiftDay(viewDay, 1); renderToday(); } };
  $('#addBtn').onclick = openAdd;
  $('#askBtn')?.addEventListener('click', () => go('chat'));
  view.querySelectorAll('.del').forEach((b) =>
    b.addEventListener('click', () => {
      const e = store.entries(viewDay).find((x) => x.id === b.dataset.id);
      store.removeEntry(viewDay, b.dataset.id);
      renderToday();
      if (e) toast(`Removed ${e.name}`, 'Undo', () => { store.addEntries(viewDay, [e], e.source); renderToday(); });
    }),
  );
}

function entryRow(e) {
  const time = new Date(e.time).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  return `<div class="entry">
    <div class="main">
      <div class="name">${esc(e.name)}${e.source === 'ai' ? '<span class="tag">AI</span>' : ''}</div>
      <div class="meta">${time} · P ${r0(e.protein)} · C ${r0(e.carbs)} · F ${r0(e.fat)}</div>
    </div>
    <div class="kc">${r0(e.calories)} kcal</div>
    <button class="del" data-id="${e.id}" aria-label="Delete">✕</button>
  </div>`;
}

// ---------------- Add food sheet ----------------
const dlg = $('#addDialog');
const form = $('#addForm');
dlg.querySelector('[data-close]').onclick = () => dlg.close();
dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });

function openAdd() {
  form.reset();
  renderSaved();
  dlg.showModal();
}
function renderSaved() {
  const list = store.saved;
  $('#savedList').innerHTML = list.length
    ? `<div class="hint">Favourites — tap + to add</div><div class="saved">${list
        .map((s) => `<span class="chip">${esc(s.name)} · ${r0(s.calories)}
          <button type="button" class="add" data-add="${s.id}" aria-label="Add">+</button>
          <button type="button" class="x" data-rm="${s.id}" aria-label="Remove favourite">✕</button></span>`)
        .join('')}</div>`
    : '';
  $('#savedList').querySelectorAll('[data-add]').forEach((b) =>
    b.addEventListener('click', () => {
      const s = store.saved.find((x) => x.id === b.dataset.add);
      const [added] = store.addEntries(viewDay, [s]);
      dlg.close();
      render();
      toast(`Added ${s.name}`, 'Undo', () => { store.removeEntry(viewDay, added.id); render(); });
    }),
  );
  $('#savedList').querySelectorAll('[data-rm]').forEach((b) =>
    b.addEventListener('click', () => { store.removeSaved(b.dataset.rm); renderSaved(); }),
  );
}
form.addEventListener('submit', (e) => {
  e.preventDefault();
  const f = new FormData(form);
  const n = (k) => parseFloat(String(f.get(k) || '').replace(',', '.')) || 0;
  const item = { name: String(f.get('name')).trim(), protein: n('protein'), carbs: n('carbs'), fat: n('fat') };
  item.calories = String(f.get('calories') || '').trim() ? n('calories') : r0(item.protein * 4 + item.carbs * 4 + item.fat * 9);
  if (!item.name) return;
  store.addEntries(viewDay, [item]);
  if (f.get('save')) store.addSaved(item);
  dlg.close();
  render();
});

// ---------------- Chat ----------------
let pendingImage = null;
let sending = false;

function md(text) {
  // tiny markdown: **bold**, bullet lists, paragraphs
  const lines = esc(text).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').split('\n');
  let html = '', inList = false;
  for (const raw of lines) {
    const line = raw.trim();
    const bullet = line.match(/^[-•*]\s+(.*)/);
    if (bullet) {
      if (!inList) { html += '<ul>'; inList = true; }
      html += `<li>${bullet[1]}</li>`;
    } else {
      if (inList) { html += '</ul>'; inList = false; }
      if (line) html += `<p>${line}</p>`;
    }
  }
  return html + (inList ? '</ul>' : '');
}

function loggedCard(ev) {
  const today = store.entries(dayKey());
  return `<div class="logged">
    <div class="t">✓ Logged to today</div>
    ${ev.items.map((it) => {
      const still = today.some((e) => e.id === it.id);
      return `<div class="row ${still ? '' : 'undone'}">
        <span>${esc(it.name)} — ${r0(it.calories)} kcal · P ${r0(it.protein)} · C ${r0(it.carbs)} · F ${r0(it.fat)}</span>
        ${still ? `<button data-undo="${it.id}">Undo</button>` : ''}
      </div>`;
    }).join('')}
  </div>`;
}

function chatItem(ev) {
  if (ev.role === 'user')
    return `<div class="msg user ${ev.failed ? 'failed' : ''}">${ev.thumb ? `<img src="${ev.thumb}" alt="">` : ''}${esc(ev.text)}</div>`;
  if (ev.role === 'assistant') return `<div class="msg assistant">${md(ev.text)}</div>`;
  if (ev.role === 'logged') return loggedCard(ev);
  if (ev.role === 'error') return `<div class="msg error">${esc(ev.text)}</div>`;
  return '';
}

const EXAMPLES = [
  'I had 2 eggs, 2 slices of toast with butter and a latte',
  'How much protein is in 150g of salmon?',
  'What can I eat for dinner to hit my protein target?',
];

function renderChat() {
  const chat = getChat();
  const hasKey = !!store.apiKey;
  view.innerHTML = `
    <div class="chat-wrap">
      <div class="chat-head">
        <h1>AI Chat</h1>
        ${chat.display.length ? '<button class="link" id="newChat">New chat</button>' : ''}
      </div>
      <div class="msgs" id="msgs">
        ${!hasKey ? `<div class="card">To use the AI chat, add your Anthropic API key in Settings.<br><br><button class="primary" id="toSettings">Open Settings</button></div>` : ''}
        ${hasKey && !chat.display.length ? `<div class="empty-chat">Tell me what you ate, send a photo of your meal, or ask a nutrition question. I'll log food automatically.
          ${EXAMPLES.map((x) => `<button class="ex" data-ex="${esc(x)}">${esc(x)}</button>`).join('')}</div>` : ''}
        ${chat.display.map(chatItem).join('')}
        ${sending ? '<div class="typing">Thinking…</div>' : ''}
      </div>
      <div class="composer">
        <div class="preview" id="preview" ${pendingImage ? '' : 'hidden'}>
          ${pendingImage ? `<img src="${pendingImage.preview}" alt=""><button class="link" id="rmPhoto">Remove photo</button>` : ''}
        </div>
        <div class="row">
          <label class="iconbtn" style="margin:0" aria-label="Add photo">📷<input type="file" accept="image/*" id="photo" hidden ${hasKey ? '' : 'disabled'}></label>
          <textarea id="msg" rows="1" placeholder="What did you eat?" ${hasKey ? '' : 'disabled'}></textarea>
          <button class="iconbtn send" id="send" aria-label="Send" ${hasKey && !sending ? '' : 'disabled'}>↑</button>
        </div>
      </div>
    </div>`;

  const ta = $('#msg');
  ta.addEventListener('input', () => { ta.style.height = 'auto'; ta.style.height = ta.scrollHeight + 'px'; });
  $('#toSettings')?.addEventListener('click', () => go('settings'));
  $('#newChat')?.addEventListener('click', () => { resetChat(); renderChat(); });
  $('#rmPhoto')?.addEventListener('click', () => { pendingImage = null; renderChat(); });
  view.querySelectorAll('[data-ex]').forEach((b) => b.addEventListener('click', () => { ta.value = b.dataset.ex; ta.focus(); }));
  view.querySelectorAll('[data-undo]').forEach((b) =>
    b.addEventListener('click', () => { store.removeEntry(dayKey(), b.dataset.undo); renderChat(); }),
  );
  $('#photo').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      pendingImage = await prepareImage(file);
    } catch (err) {
      toast(err.message);
    }
    const draft = ta.value;
    renderChat();
    $('#msg').value = draft;
  });
  $('#send').addEventListener('click', send);
  scrollChat();
}

function scrollChat() {
  requestAnimationFrame(() => window.scrollTo(0, document.body.scrollHeight));
}

async function send() {
  if (sending) return;
  const text = $('#msg').value.trim();
  if (!text && !pendingImage) return;
  const img = pendingImage;
  pendingImage = null;
  sending = true;
  const errors = [];
  // show the user's message immediately
  const chat = getChat();
  const before = chat.display.length;
  renderChat();
  const typing = $('.typing');
  typing?.insertAdjacentHTML('beforebegin', chatItem({ role: 'user', text, thumb: img?.thumb }));
  scrollChat();
  try {
    await sendMessage({ text, image: img?.image, thumb: img?.thumb }, (ev) => {
      if (ev.type === 'error') errors.push(ev.text);
      if (tab === 'chat') {
        // live-update while the loop continues
        const msgs = $('#msgs');
        if (ev.type === 'assistant') typing?.insertAdjacentHTML('beforebegin', chatItem({ role: 'assistant', text: ev.text }));
        if (ev.type === 'logged') typing?.insertAdjacentHTML('beforebegin', chatItem({ role: 'logged', items: ev.items }));
        if (msgs) scrollChat();
      }
    });
  } catch (e) {
    errors.push(e.message);
  }
  sending = false;
  if (tab === 'chat') {
    renderChat();
    if (errors.length) {
      // If nothing was kept from this turn, put the text/photo back so they can retry.
      if (chat.display.length === before) {
        pendingImage = img;
        renderChat();
        $('#msg').value = text;
      }
      $('#msgs').insertAdjacentHTML('beforeend', errors.map((t) => chatItem({ role: 'error', text: t })).join(''));
      scrollChat();
    }
  } else if (errors.length) {
    toast(errors[0]);
  }
}

// ---------------- History ----------------
function renderHistory() {
  const t = store.targets;
  const days = store.loggedDays().slice(0, 60);
  const last7 = days.filter((d) => parseDay(d) >= new Date(Date.now() - 7 * 864e5)).map((d) => store.totals(d));
  const avg = (k) => (last7.length ? r0(last7.reduce((a, x) => a + x[k], 0) / last7.length) : 0);

  view.innerHTML = `
    <h1>History</h1>
    <section class="card">
      <h2>Last 7 days — daily average</h2>
      ${last7.length ? `<div class="stats">
        <div><div class="v" style="color:var(--kcal)">${avg('calories')}</div><div class="l">kcal / ${r0(t.calories)}</div></div>
        <div><div class="v" style="color:var(--protein)">${avg('protein')}</div><div class="l">protein / ${r0(t.protein)}</div></div>
        <div><div class="v" style="color:var(--carbs)">${avg('carbs')}</div><div class="l">carbs / ${r0(t.carbs)}</div></div>
        <div><div class="v" style="color:var(--fat)">${avg('fat')}</div><div class="l">fat / ${r0(t.fat)}</div></div>
      </div><p class="hint">Averaged over the ${last7.length} day(s) you logged.</p>` : '<p class="muted">No days logged this week yet.</p>'}
    </section>
    <section class="card">
      <h2>Days</h2>
      ${days.length ? days.map((d) => {
        const s = store.totals(d);
        const dt = parseDay(d);
        const hit = s.protein >= t.protein * 0.95;
        return `<button class="day" data-day="${d}">
          <div class="d">${dt.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}<small>${dt.toLocaleDateString(undefined, { weekday: 'short' })}</small></div>
          <div class="b">
            <div><b>${r0(s.calories)}</b> <span class="muted">/ ${r0(t.calories)} kcal</span></div>
            <div class="bar"><div style="width:${pct(s.calories, t.calories)}%;background:${s.calories > t.calories * 1.05 ? 'var(--danger)' : 'var(--kcal)'}"></div></div>
            <div class="nums">P ${r0(s.protein)}${hit ? ' ✓' : ''} · C ${r0(s.carbs)} · F ${r0(s.fat)}</div>
          </div>
        </button>`;
      }).join('') : '<p class="muted">Nothing logged yet.</p>'}
    </section>`;
  view.querySelectorAll('[data-day]').forEach((b) =>
    b.addEventListener('click', () => { viewDay = b.dataset.day; go('today'); }),
  );
}

// ---------------- Settings ----------------
function renderSettings() {
  const t = store.targets;
  const p = store.profile || { sex: 'male', age: '', heightCm: '', weightKg: '', activity: 'moderate', goal: 'cut' };
  const opt = (obj, sel) => Object.entries(obj).map(([k, v]) => `<option value="${k}" ${k === sel ? 'selected' : ''}>${esc(v.label)}</option>`).join('');
  const key = store.apiKey;

  view.innerHTML = `
    <h1>Settings</h1>

    <section class="card">
      <h2>Work out my targets</h2>
      <form id="calc">
        <label>Sex<div class="seg">
          <label><input type="radio" name="sex" value="male" ${p.sex === 'male' ? 'checked' : ''}><span>Male</span></label>
          <label><input type="radio" name="sex" value="female" ${p.sex === 'female' ? 'checked' : ''}><span>Female</span></label>
        </div></label>
        <div class="grid2">
          <label>Age<input name="age" inputmode="numeric" value="${esc(p.age)}" required></label>
          <label>Height (cm)<input name="heightCm" inputmode="decimal" value="${esc(p.heightCm)}" required></label>
          <label>Weight (kg)<input name="weightKg" inputmode="decimal" value="${esc(p.weightKg)}" required></label>
        </div>
        <label>Activity<select name="activity">${opt(ACTIVITY, p.activity)}</select></label>
        <label>Goal<select name="goal">${opt(GOALS, p.goal)}</select></label>
        <button class="secondary" type="submit">Calculate</button>
        <div id="calcOut"></div>
      </form>
    </section>

    <section class="card">
      <h2>Daily targets</h2>
      <form id="targets">
        <div class="grid4">
          <label>kcal<input name="calories" inputmode="decimal" value="${t.calories}"></label>
          <label>Protein g<input name="protein" inputmode="decimal" value="${t.protein}"></label>
          <label>Carbs g<input name="carbs" inputmode="decimal" value="${t.carbs}"></label>
          <label>Fat g<input name="fat" inputmode="decimal" value="${t.fat}"></label>
        </div>
        <p class="hint">Edit by hand, or use the calculator above.</p>
        <button class="primary" type="submit">Save targets</button>
      </form>
    </section>

    <section class="card">
      <h2>AI chat</h2>
      <form id="ai">
        <label>Anthropic API key<input name="key" type="password" autocomplete="off" placeholder="sk-ant-…" value="${esc(key)}"></label>
        <label>Model<select name="model">${opt(MODELS, store.model)}</select></label>
        <p class="hint">The key is stored only on this phone and is not included in backups. Estimated AI cost this month: <b>$${store.monthSpend.toFixed(2)}</b></p>
        <button class="primary" type="submit">Save</button>
      </form>
    </section>

    <section class="card">
      <h2>Backup</h2>
      <p class="hint">Your food log lives only on this phone. Export a backup now and then (save it to Files or iCloud Drive).</p>
      <div class="actions">
        <button class="secondary" id="export">Export backup</button>
        <label class="secondary" style="margin:0;text-align:center;display:block;border-radius:12px;padding:13px 16px;font-weight:600;font-size:16px;color:var(--text);background:var(--card);box-shadow:inset 0 0 0 1px var(--line)">Import backup<input type="file" id="import" accept="application/json,.json" hidden></label>
      </div>
      <button class="danger" id="erase">Erase all data…</button>
    </section>
    <p class="hint" style="text-align:center">Macro Tracker · v1</p>`;

  $('#calc').addEventListener('submit', (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const prof = {
      sex: f.get('sex'),
      age: +f.get('age'),
      heightCm: +String(f.get('heightCm')).replace(',', '.'),
      weightKg: +String(f.get('weightKg')).replace(',', '.'),
      activity: f.get('activity'),
      goal: f.get('goal'),
    };
    if (!(prof.age > 0 && prof.heightCm > 0 && prof.weightKg > 0)) return toast('Fill in age, height and weight.');
    store.setProfile(prof);
    const r = calcTargets(prof);
    $('#calcOut').innerHTML = `<div class="result">
      Maintenance ≈ ${r.tdee} kcal/day (BMR ${r.bmr}).<br>
      Suggested: <b>${r.calories} kcal</b> · P <b>${r.protein}</b> g · C <b>${r.carbs}</b> g · F <b>${r.fat}</b> g
    </div><button class="primary" type="button" id="useCalc">Use these targets</button>`;
    $('#useCalc').onclick = () => { store.setTargets(r); renderSettings(); toast('Targets updated'); };
  });

  $('#targets').addEventListener('submit', (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    store.setTargets(Object.fromEntries([...f.entries()].map(([k, v]) => [k, parseFloat(String(v).replace(',', '.')) || 0])));
    toast('Targets saved');
  });

  $('#ai').addEventListener('submit', (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    store.apiKey = String(f.get('key') || '');
    store.model = String(f.get('model'));
    toast('AI settings saved');
  });

  $('#export').onclick = async () => {
    const name = `macros-backup-${dayKey()}.json`;
    const blob = new Blob([store.exportJSON()], { type: 'application/json' });
    const file = new File([blob], name, { type: 'application/json' });
    if (navigator.canShare?.({ files: [file] })) {
      try { await navigator.share({ files: [file], title: name }); } catch {}
    } else {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    }
  };
  $('#import').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      store.importJSON(await file.text());
      toast('Backup restored');
      renderSettings();
    } catch (err) {
      toast(err.message);
    }
  });
  $('#erase').onclick = () => {
    if (confirm('Erase all food logs, favourites, targets and chats on this phone? This cannot be undone.')) {
      store.eraseAll();
      renderSettings();
      toast('All data erased');
    }
  };
}

// ---------------- start ----------------
// When the app is reopened on a new day, jump to that day.
let lastToday = dayKey();
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || dayKey() === lastToday) return;
  if (viewDay === lastToday) viewDay = dayKey();
  lastToday = dayKey();
  if (tab === 'today' || tab === 'chat') render();
});

if (!store.profile && !store.loggedDays().length) tab = 'settings';
go(tab);
if (tab === 'settings') toast('Welcome! Start by working out your targets.');

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
