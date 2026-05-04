const $ = (id) => document.getElementById(id);
const input = $("input");
const output = $("output");
const status = $("status");
const keyBtn = $("key-btn");
const autoBtn = $("auto-btn");

const MODEL = "gemini-flash-latest";
const KEY_STORAGE = "gemini_api_key";
const AUTO_STORAGE = "auto_rewrite";
const DEBOUNCE_MS = 700;
const isMac = navigator.platform.toLowerCase().includes("mac");
const RUN_HINT = isMac ? "⌘↵" : "Ctrl+↵";

const SYSTEM_PROMPT = `You rewrite a user's rough draft into a clean prompt for an AI assistant.

# The only rule that matters
Use ONLY information the user literally wrote. If the user did not say it, it does not appear in the output. No exceptions. Do not "professionalize" the prompt by adding plausible-sounding requirements, deliverables, methodologies, or output formats. Inventing content is the worst possible failure of this task.

# Length
Output length must be proportional to input length. A two-line draft yields a two-to-four-line prompt. Never pad.

# Sections (Markdown bold labels, not headings; include only when the user's words clearly map to one)
**Context:** the facts the user stated, in plain explicit English. (Almost always present.)
**Task:** one imperative sentence — the thing the user asked the AI to do. (Almost always present.)
**Requirements:** ONLY include if the user explicitly stated constraints (a tech stack name, a length limit, a must/must-not, a forbidden approach). If the user only described a problem, omit this section entirely.
**Output format:** ONLY include if the user explicitly asked for a specific shape (table, code, steps, etc.). Do not infer one. Omit otherwise.
**Role:** omit unless the user explicitly named a role.

Do NOT add any "Open questions", "Clarifications", "Assumptions", or similar speculation sections. If information is missing, leave it missing — the user will follow up themselves.

# Style
- Translate non-English input to English. Resolve pronouns, slang, shorthand.
- Be terse. One sentence per section, or a tight 2–4 bullet list.
- No preamble, no commentary, no sign-off, no outer code fence. Output only the prompt.

# Self-check before answering
For each line in your output, ask: "Did the user actually write this or imply it directly?" If no, delete the line.`;

function setStatus(text, cls) {
  status.textContent = text;
  status.className = "status " + (cls || "idle");
}

function getKey() {
  return localStorage.getItem(KEY_STORAGE) || "";
}

function promptForKey() {
  const current = getKey();
  const next = window.prompt("Gemini API key (stored locally in your browser):", current);
  if (next === null) return;
  localStorage.setItem(KEY_STORAGE, next.trim());
  setStatus(next.trim() ? "key saved" : "key cleared", "ok");
}

keyBtn.addEventListener("click", promptForKey);

function flash(btn, label) {
  const old = btn.textContent;
  btn.textContent = label;
  setTimeout(() => (btn.textContent = old), 900);
}

document.querySelectorAll("button[data-copy]").forEach((btn) => {
  btn.addEventListener("click", async () => {
    const target = $(btn.dataset.copy);
    if (!target.value) return;
    try {
      await navigator.clipboard.writeText(target.value);
      flash(btn, "Copied");
    } catch {
      target.select();
      document.execCommand("copy");
    }
  });
});

document.querySelectorAll("button[data-paste]").forEach((btn) => {
  btn.addEventListener("click", async () => {
    const target = $(btn.dataset.paste);
    try {
      const text = await navigator.clipboard.readText();
      if (!text) return;
      target.value = text;
      target.focus();
      flash(btn, "Pasted");
      schedule();
    } catch {
      flash(btn, "Blocked");
    }
  });
});

document.querySelectorAll("button[data-clear]").forEach((btn) => {
  btn.addEventListener("click", () => {
    const target = $(btn.dataset.clear);
    target.value = "";
    output.value = "";
    target.focus();
    setStatus("idle", "idle");
  });
});

let pending = null;
let inflight = null;

async function streamGemini(text, model, signal, onChunk) {
  const key = getKey();
  if (!key) throw new Error("Set your API key (top right).");

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse&key=${encodeURIComponent(key)}`;

  const body = {
    systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
    contents: [{ role: "user", parts: [{ text }] }],
    generationConfig: { temperature: 0, maxOutputTokens: 2048 },
  };

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok || !res.body) {
    const detail = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status} ${detail.slice(0, 200)}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });

    let idx;
    while ((idx = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line.startsWith("data:")) continue;
      const json = line.slice(5).trim();
      if (!json) continue;
      try {
        const data = JSON.parse(json);
        const chunk = (data?.candidates?.[0]?.content?.parts || [])
          .map((p) => p.text || "")
          .join("");
        if (chunk) onChunk(chunk);
      } catch { /* skip malformed line */ }
    }
  }
}

async function rewrite() {
  const text = input.value.trim();
  if (!text) {
    output.value = "";
    setStatus("idle", "idle");
    return;
  }

  if (inflight) inflight.abort();
  const ctrl = new AbortController();
  inflight = ctrl;

  output.value = "";
  setStatus("rewriting…", "working");
  try {
    let acc = "";
    await streamGemini(text, MODEL, ctrl.signal, (chunk) => {
      acc += chunk;
      output.value = acc;
      output.scrollTop = output.scrollHeight;
    });
    output.value = acc.trim();
    setStatus("ready", "ok");
  } catch (err) {
    if (err.name === "AbortError") return;
    setStatus(err.message || "error", "err");
  } finally {
    if (inflight === ctrl) inflight = null;
  }
}

function isAuto() {
  return localStorage.getItem(AUTO_STORAGE) !== "0";
}

function renderAutoBtn() {
  autoBtn.textContent = isAuto() ? "Auto: on" : `Auto: off (${RUN_HINT})`;
}

function setAuto(on) {
  localStorage.setItem(AUTO_STORAGE, on ? "1" : "0");
  renderAutoBtn();
  if (on) schedule();
}

autoBtn.addEventListener("click", () => setAuto(!isAuto()));

function schedule() {
  clearTimeout(pending);
  if (!isAuto()) return;
  pending = setTimeout(rewrite, DEBOUNCE_MS);
}

input.addEventListener("input", schedule);

document.addEventListener("keydown", (e) => {
  const mod = isMac ? e.metaKey : e.ctrlKey;
  if (mod && e.key === "Enter") {
    e.preventDefault();
    clearTimeout(pending);
    rewrite();
  }
});

renderAutoBtn();
if (!getKey()) setStatus("set API key →", "warn");
