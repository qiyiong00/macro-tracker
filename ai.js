// AI chat: talks to the Claude API directly from the phone using your own API key.
import { store, dayKey, MODELS } from './store.js';

// Pinned SDK build, loaded only when you first use the chat (so the rest of the app works offline).
const SDK_URL = 'https://cdn.jsdelivr.net/npm/@anthropic-ai/sdk@1.5.0/+esm';

// Kept identical across requests so prompt caching works.
const SYSTEM = `You are the nutrition assistant inside a personal macro-tracking app. The user tracks calories, protein, carbs and fat for their fitness goals.

Logging:
- When the user tells you or shows you food they ate, are eating, or are about to eat, estimate the macros and call log_food. Put every item from one meal in a single log_food call, one entry per distinct item. Don't ask for permission first: the app shows each logged item with an Undo button.
- If portion size is unclear, assume a typical portion, say what you assumed, and log it. Ask a follow-up question only when the answer would change the estimate a lot (for example, a whole pizza vs one slice).
- When the user is only asking a question ("how much protein is in X?", "what should I eat for dinner?", "is this a good snack?"), answer it and don't log anything unless they say they ate it or ask you to log it.
- If the user says an earlier log was wrong, log a corrected entry and tell them to undo the old one in the app (you cannot delete entries).

Photos:
- Identify each food, estimate portions from visual cues (plate size, utensils, hands, packaging), and use nutrition labels if visible.
- Briefly mention the biggest uncertainty (hidden oil, sauce, portion size).

Context:
- Each user message starts with a bracketed status line from the app (not typed by the user) with the date, the user's daily targets, and what is logged today. Use it when giving advice, such as how much protein is left for the day.

Style:
- The user reads this on a phone. Keep replies short: a few lines, no tables, no headings.
- Give calories in kcal and macros in grams, rounded to whole numbers.
- Make sure each item's calories roughly match 4×protein + 4×carbs + 9×fat.`;

const LOG_TOOL = {
  name: 'log_food',
  description:
    "Add food items to the user's food diary for today. Use one call per meal containing all its items. Values are for the portion actually eaten.",
  strict: true,
  input_schema: {
    type: 'object',
    additionalProperties: false,
    required: ['items'],
    properties: {
      items: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['name', 'calories', 'protein_g', 'carbs_g', 'fat_g'],
          properties: {
            name: { type: 'string', description: 'Short name including portion, e.g. "Chicken rice (1 plate)"' },
            calories: { type: 'number', description: 'kcal' },
            protein_g: { type: 'number' },
            carbs_g: { type: 'number' },
            fat_g: { type: 'number' },
          },
        },
      },
    },
  },
};

let sdkPromise = null;
let client = null;
let clientKey = '';
async function getClient(apiKey) {
  if (!sdkPromise) {
    sdkPromise = import(SDK_URL).catch((e) => {
      sdkPromise = null;
      throw new Error('Could not load the AI library. Check your internet connection.');
    });
  }
  const mod = await sdkPromise;
  if (!client || clientKey !== apiKey) {
    const Anthropic = mod.default ?? mod.Anthropic;
    // Your key stays on your phone; requests go straight from the phone to Anthropic.
    client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
    clientKey = apiKey;
  }
  return client;
}

// ---------- conversation state (one chat per day) ----------
// `messages` is the exact API history for this session (kept verbatim, append-only).
// `display` is what the chat screen shows.
let chatDay = null;
let chat = null;

export function getChat() {
  const today = dayKey();
  if (chatDay !== today) {
    chatDay = today;
    const saved = store.loadChat(today);
    chat = saved ? { messages: saved.messages || [], display: saved.display || [] } : { messages: [], display: [] };
  }
  return chat;
}

export function resetChat() {
  store.clearChat(dayKey());
  chatDay = null;
  return getChat();
}

// Saved copy drops photos (too big) and thinking blocks (only valid in the session that made them).
function sanitizeForStorage(messages) {
  return messages.map((m) => {
    if (typeof m.content === 'string') return m;
    let content = m.content
      .map((b) => {
        if (b.type === 'image') return { type: 'text', text: '[photo]' };
        if (m.role === 'assistant' && b.type !== 'text' && b.type !== 'tool_use') return null;
        if (b.type === 'text') return { type: 'text', text: b.text };
        if (b.type === 'tool_use') return { type: 'tool_use', id: b.id, name: b.name, input: b.input };
        return b;
      })
      .filter(Boolean);
    if (!content.length) content = [{ type: 'text', text: '(no reply)' }];
    return { role: m.role, content };
  });
}

function persist() {
  store.saveChat(chatDay, { messages: sanitizeForStorage(chat.messages), display: chat.display });
}

function statusLine() {
  const t = store.targets;
  const s = store.totals(dayKey());
  const now = new Date();
  const when = now.toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  return `[App status — ${when}. Daily targets: ${t.calories} kcal, protein ${t.protein} g, carbs ${t.carbs} g, fat ${t.fat} g. Logged today: ${Math.round(s.calories)} kcal, protein ${Math.round(s.protein)} g, carbs ${Math.round(s.carbs)} g, fat ${Math.round(s.fat)} g (${s.count} items).]`;
}

function costOf(model, usage) {
  const p = MODELS[model];
  if (!p || !usage) return 0;
  return (
    ((usage.input_tokens || 0) * p.in +
      (usage.output_tokens || 0) * p.out +
      (usage.cache_read_input_tokens || 0) * p.cacheRead +
      (usage.cache_creation_input_tokens || 0) * p.cacheWrite) /
    1e6
  );
}

function runLogFood(input) {
  const items = Array.isArray(input?.items) ? input.items : null;
  const ok =
    items &&
    items.length > 0 &&
    items.every(
      (it) =>
        typeof it.name === 'string' &&
        ['calories', 'protein_g', 'carbs_g', 'fat_g'].every((k) => Number.isFinite(it[k]) && it[k] >= 0),
    );
  if (!ok) return { error: 'Invalid input: items must be a non-empty list with name, calories, protein_g, carbs_g, fat_g (numbers ≥ 0).' };
  const day = dayKey();
  const added = store.addEntries(
    day,
    items.map((it) => ({ name: it.name, calories: it.calories, protein: it.protein_g, carbs: it.carbs_g, fat: it.fat_g })),
    'ai',
  );
  const s = store.totals(day);
  return {
    added,
    result: `Logged ${added.length} item(s). New totals today: ${Math.round(s.calories)} kcal, protein ${Math.round(s.protein)} g, carbs ${Math.round(s.carbs)} g, fat ${Math.round(s.fat)} g.`,
  };
}

function friendlyError(e) {
  const status = e?.status;
  const msg = String(e?.error?.error?.message || e?.message || e);
  if (status === 401) return 'Your API key was rejected. Check it in Settings.';
  if (/credit balance/i.test(msg)) return 'Your Anthropic account is out of credits. Add credits at console.anthropic.com.';
  if (status === 429) return 'Too many requests right now. Wait a moment and try again.';
  if (status === 529 || status >= 500) return 'The AI service is busy. Try again in a moment.';
  if (/fetch|network|load/i.test(msg) && !status) return 'No connection. The chat needs internet (logging by hand works offline).';
  return msg;
}

/**
 * Send one user turn and run the tool loop until the model finishes.
 * `emit` receives display events as they happen: {type:'assistant', text} | {type:'logged', items} | {type:'error', text}
 */
export async function sendMessage({ text, image, thumb }, emit) {
  const apiKey = store.apiKey;
  if (!apiKey) throw new Error('Add your Anthropic API key in Settings first.');
  const model = store.model;
  getChat();

  const userText = text?.trim() || "I'm eating this. Estimate the macros and log it.";
  const content = [];
  if (image) content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: image } });
  content.push({ type: 'text', text: `${statusLine()}\n\n${userText}` });

  const startLen = chat.messages.length;
  chat.messages.push({ role: 'user', content });
  const userDisplay = { role: 'user', text: text?.trim() || '', thumb: thumb || null };
  chat.display.push(userDisplay);

  let spent = 0;
  try {
    const anthropic = await getClient(apiKey);
    for (let turn = 0; turn < 6; turn++) {
      const params = {
        model,
        max_tokens: 16000,
        system: SYSTEM,
        tools: [LOG_TOOL],
        messages: chat.messages,
        cache_control: { type: 'ephemeral' },
        output_config: { effort: 'medium' },
      };
      if (model === 'claude-opus-5-5') {
        // If a safety filter wrongly declines (rare for food), the API retries on a fallback model.
        params.betas = ['server-side-fallback-2026-07-01'];
        params.fallbacks = 'default';
      }
      const resp = await anthropic.beta.messages.create(params);
      spent += costOf(model, resp.usage);

      if (resp.stop_reason === 'refusal') {
        // Drop the declined turn so the history stays clean.
        chat.messages.length = startLen;
        if (chat.display.at(-1) === userDisplay) chat.display.pop();
        emit({ type: 'error', text: "Claude couldn't help with that request. Try rephrasing it." });
        break;
      }

      chat.messages.push({ role: 'assistant', content: resp.content });
      const replyText = resp.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
      if (replyText) {
        const ev = { role: 'assistant', text: replyText };
        chat.display.push(ev);
        emit({ type: 'assistant', text: replyText });
      }

      const toolUses = resp.content.filter((b) => b.type === 'tool_use');
      if (resp.stop_reason !== 'tool_use' || !toolUses.length) {
        if (resp.stop_reason === 'max_tokens') emit({ type: 'error', text: 'The reply was cut off. Try asking again.' });
        break;
      }

      const results = [];
      for (const tu of toolUses) {
        if (tu.name === 'log_food') {
          const r = runLogFood(tu.input);
          if (r.error) {
            results.push({ type: 'tool_result', tool_use_id: tu.id, content: r.error, is_error: true });
          } else {
            const ev = { role: 'logged', items: r.added.map((a) => ({ id: a.id, name: a.name, calories: a.calories, protein: a.protein, carbs: a.carbs, fat: a.fat })) };
            chat.display.push(ev);
            emit({ type: 'logged', items: ev.items });
            results.push({ type: 'tool_result', tool_use_id: tu.id, content: r.result });
          }
        } else {
          results.push({ type: 'tool_result', tool_use_id: tu.id, content: `Unknown tool ${tu.name}`, is_error: true });
        }
      }
      chat.messages.push({ role: 'user', content: results });
    }
  } catch (e) {
    // Roll back the unfinished turn (entries already logged stay logged and can be undone).
    chat.messages.length = startLen;
    if (chat.display.at(-1) === userDisplay) chat.display.pop();
    else userDisplay.failed = true;
    emit({ type: 'error', text: friendlyError(e) });
  } finally {
    if (spent) store.addSpend(spent);
    persist();
  }
  return { cost: spent };
}

// Shrink a photo before sending: fewer tokens, faster upload.
export async function prepareImage(file) {
  const bitmap = await loadImage(file);
  const big = drawScaled(bitmap, 1568, 0.85);
  const small = drawScaled(bitmap, 160, 0.7);
  return { image: big.split(',')[1], thumb: small, preview: small };
}
function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not read that image.')); };
    img.src = url;
  });
}
function drawScaled(img, maxSide, quality) {
  const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.round(img.naturalWidth * scale);
  const h = Math.round(img.naturalHeight * scale);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  c.getContext('2d').drawImage(img, 0, 0, w, h);
  return c.toDataURL('image/jpeg', quality);
}
