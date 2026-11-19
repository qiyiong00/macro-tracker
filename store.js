// All data lives in this phone's browser storage (localStorage). Nothing is sent
// anywhere except the chat messages you send to the AI.

const DATA_KEY = 'macros.data.v1';
const CHAT_KEY = 'macros.chats.v1';
const API_KEY = 'macros.apikey';
const MODEL_KEY = 'macros.model';
const SPEND_KEY = 'macros.spend';

export const MODELS = {
  'claude-opus-5-5': { label: 'Claude Opus 5.5 (smartest)', in: 4, out: 20, cacheRead: 0.2, cacheWrite: 5 },
  'claude-haiku-5-5': { label: 'Claude Haiku 5.5 (much cheaper)', in: 0.1, out: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
};
export const DEFAULT_MODEL = 'claude-opus-5-5';

function read(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}
function write(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (e) {
    alert('Could not save — storage may be full. Try exporting a backup and clearing old chats.');
    throw e;
  }
}

const defaultData = () => ({
  profile: null,
  targets: { calories: 2000, protein: 150, carbs: 200, fat: 65 },
  entries: {}, // { 'YYYY-MM-DD': [entry, ...] }
  saved: [], // favourite foods
});

let data = { ...defaultData(), ...read(DATA_KEY, {}) };

export function dayKey(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}
export function parseDay(key) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d);
}
export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 10) / 10 : 0;
};

export const store = {
  get targets() { return data.targets; },
  get profile() { return data.profile; },
  get saved() { return data.saved; },

  setTargets(t) {
    data.targets = { calories: num(t.calories), protein: num(t.protein), carbs: num(t.carbs), fat: num(t.fat) };
    write(DATA_KEY, data);
  },
  setProfile(p) {
    data.profile = p;
    write(DATA_KEY, data);
  },

  entries(day) { return data.entries[day] || []; },
  addEntries(day, items, source = 'manual') {
    const list = (data.entries[day] ||= []);
    const added = items.map((it) => ({
      id: uid(),
      name: String(it.name || 'Food').slice(0, 120),
      calories: num(it.calories),
      protein: num(it.protein),
      carbs: num(it.carbs),
      fat: num(it.fat),
      time: Date.now(),
      source,
    }));
    list.push(...added);
    write(DATA_KEY, data);
    return added;
  },
  updateEntry(day, id, fields) {
    const e = (data.entries[day] || []).find((x) => x.id === id);
    if (!e) return null;
    const before = { ...e };
    e.name = String(fields.name || e.name).slice(0, 120);
    for (const k of ['calories', 'protein', 'carbs', 'fat']) e[k] = num(fields[k]);
    write(DATA_KEY, data);
    return before;
  },
  removeEntry(day, id) {
    data.entries[day] = (data.entries[day] || []).filter((e) => e.id !== id);
    if (!data.entries[day].length) delete data.entries[day];
    write(DATA_KEY, data);
  },
  totals(day) {
    return this.entries(day).reduce(
      (t, e) => ({
        calories: t.calories + e.calories,
        protein: t.protein + e.protein,
        carbs: t.carbs + e.carbs,
        fat: t.fat + e.fat,
        count: t.count + 1,
      }),
      { calories: 0, protein: 0, carbs: 0, fat: 0, count: 0 },
    );
  },
  loggedDays() {
    return Object.keys(data.entries).filter((k) => data.entries[k].length).sort().reverse();
  },

  addSaved(item) {
    data.saved.push({ id: uid(), name: item.name, calories: num(item.calories), protein: num(item.protein), carbs: num(item.carbs), fat: num(item.fat) });
    write(DATA_KEY, data);
  },
  removeSaved(id) {
    data.saved = data.saved.filter((s) => s.id !== id);
    write(DATA_KEY, data);
  },

  // --- AI settings (kept out of backups on purpose) ---
  get apiKey() { try { return localStorage.getItem(API_KEY) || ''; } catch { return ''; } },
  set apiKey(v) { try { v ? localStorage.setItem(API_KEY, v.trim()) : localStorage.removeItem(API_KEY); } catch {} },
  get model() {
    let m = '';
    try { m = localStorage.getItem(MODEL_KEY) || ''; } catch {}
    return MODELS[m] ? m : DEFAULT_MODEL;
  },
  set model(v) { try { localStorage.setItem(MODEL_KEY, v); } catch {} },

  // --- chats, one per day, only the last 7 days kept ---
  loadChat(day) { return read(CHAT_KEY, {})[day] || null; },
  saveChat(day, chat) {
    const all = read(CHAT_KEY, {});
    all[day] = chat;
    const keep = Object.keys(all).sort().reverse().slice(0, 7);
    const trimmed = Object.fromEntries(keep.map((k) => [k, all[k]]));
    write(CHAT_KEY, trimmed);
  },
  clearChat(day) {
    const all = read(CHAT_KEY, {});
    delete all[day];
    write(CHAT_KEY, all);
  },

  // --- estimated AI spend this month ---
  addSpend(usd) {
    const month = dayKey().slice(0, 7);
    const s = read(SPEND_KEY, { month, usd: 0 });
    const next = s.month === month ? { month, usd: s.usd + usd } : { month, usd };
    write(SPEND_KEY, next);
  },
  get monthSpend() {
    const s = read(SPEND_KEY, null);
    return s && s.month === dayKey().slice(0, 7) ? s.usd : 0;
  },

  // --- backup ---
  exportJSON() {
    return JSON.stringify({ app: 'macro-tracker', version: 1, exportedAt: new Date().toISOString(), data }, null, 2);
  },
  importJSON(text) {
    const parsed = JSON.parse(text);
    const incoming = parsed?.data;
    if (!incoming || typeof incoming.entries !== 'object') throw new Error('This file is not a Macro Tracker backup.');
    data = { ...defaultData(), ...incoming };
    write(DATA_KEY, data);
  },
  eraseAll() {
    data = defaultData();
    write(DATA_KEY, data);
    try { localStorage.removeItem(CHAT_KEY); } catch {}
  },
};

// Mifflin-St Jeor BMR × activity, adjusted for goal.
export const ACTIVITY = {
  sedentary: { label: 'Sedentary (desk job, little exercise)', f: 1.2 },
  light: { label: 'Light (exercise 1–3 days/week)', f: 1.375 },
  moderate: { label: 'Moderate (exercise 3–5 days/week)', f: 1.55 },
  very: { label: 'Very active (hard exercise 6–7 days/week)', f: 1.725 },
  athlete: { label: 'Athlete (2× a day / physical job)', f: 1.9 },
};
export const GOALS = {
  cut: { label: 'Lose fat (~0.5 kg/week)', delta: -500, proteinPerKg: 2.2 },
  slowcut: { label: 'Lose fat slowly (~0.25 kg/week)', delta: -250, proteinPerKg: 2.0 },
  maintain: { label: 'Maintain weight', delta: 0, proteinPerKg: 1.8 },
  gain: { label: 'Lean muscle gain', delta: 250, proteinPerKg: 1.8 },
};
export function calcTargets({ sex, age, heightCm, weightKg, activity, goal }) {
  const bmr = 10 * weightKg + 6.25 * heightCm - 5 * age + (sex === 'male' ? 5 : -161);
  const tdee = bmr * ACTIVITY[activity].f;
  const floor = sex === 'male' ? 1500 : 1200;
  const calories = Math.max(floor, Math.round((tdee + GOALS[goal].delta) / 10) * 10);
  const protein = Math.round(weightKg * GOALS[goal].proteinPerKg);
  const fat = Math.round((calories * 0.25) / 9);
  const carbs = Math.max(0, Math.round((calories - protein * 4 - fat * 9) / 4));
  return { bmr: Math.round(bmr), tdee: Math.round(tdee), calories, protein, carbs, fat };
}
