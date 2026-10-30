ideo in one conversation list. The browser
// calls the gateway with the account's key (it never leaves the browser except
// to the gateway and to this service, which only asks who the key belongs to);
// this service keeps nothing: conversations, pictures and video are kept in this
// browser (IndexedDB) and nowhere else.
"use strict";

const $ = (s, r = document) => r.querySelector(s);
const app = $("#app");
const KEY = "beenet-chat-key", SAVE = "beenet-chat-save", THEME = "beenet-chat-theme";

function h(tag, attrs, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === "class") e.className = v;
    else if (k === "text") e.textContent = v;
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) e.setAttribute(k, v === true ? "" : v);
  }
  for (const c of kids.flat()) if (c != null) e.append(c.nodeType ? c : document.createTextNode(c));
  return e;
}
function store(k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (_) { /* private mode */ } }
function load(k) { try { return localStorage.getItem(k) || ""; } catch (_) { return ""; } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fmt = (n) => (Math.round(Number(n) * 100) / 100).toLocaleString("zh-CN");

let key = load(KEY), gateway = "", tenant = "", balance = null;
// Embedded: the page is the chat inside the desktop client. The client holds the account key and adds
// it itself, so the page has no login, no key, no sign-out, and marks its calls with X-Fabric, which
// the client requires of anything that changes something.
let embedded = false;
let models = [];                 // [{id, kind}]
let chats = [];                  // sidebar summaries
let cur = null;                  // the open conversation
let think = load("beenet-chat-think") === "on"; // reasoning shown before the answer; off by default
let busy = null;                 // AbortController while an answer in words is being written
const jobs = new Set();          // pictures and videos being made: they run on the side, the chat stays usable
let keep = load(SAVE) !== "off"; // keep conversations in this browser
let secret = load("beenet-chat-secret") === "on"; // end-to-end encrypted chat to a verified confidential node (e2e.js)
let e2eCfg = { verifiers: {}, quorum: 0 };         // the verifiers this browser trusts
const e2eTokens = new Map();                       // attestation reference -> { tok, claims }
let anon = load("beenet-chat-anon") === "on";      // pay with bearer tokens: no account or key on the request (mint.js)
let mintInfo = null;                               // the mint's keys and answer caps, when the gateway offers them
let wallet = null;
let answerCap = Number(load("beenet-chat-cap")) || 2048;
let tlogCfg = null;                                // the transparency log this browser checks (tlog.js), when configured
let tlogState = null, tlogAt = 0;                  // what the log said at the last check, and when
let relay = null;                                  // { urls, cfg, ... }: the Oblivious HTTP relay pool secret-mode calls go through

// net is how the secret-mode calls reach the gateway: through a relay when there are
// any (the whole request, headers included, is encrypted to the gateway, which never
// sees the person's address), else straight. auth adds the account key.
// The relays are a pool: tried in random order, a dead one is skipped for a minute, so
// one blocked or failing relay does not stop the person. Only failures before the
// gateway has answered move on to the next relay; once an answer has begun it is the
// answer.
// The longest message the page sends. A longer one is said, not cut: a pasted document is cut only by the person.
const MAX_INPUT = 20000;
const shuffled = (a) => a.map((x) => [Math.random(), x]).sort((p, q) => p[0] - q[0]).map((p) => p[1]);
async function net(method, path, o) {
  o = o || {};
  const headers = Object.assign({}, o.headers || {}, embedded ? { "X-Fabric": "1" } : {}, o.auth && key ? { Authorization: "Bearer " + key } : {});
  if (!relay || !relay.urls.length) return fetch(gateway + path, { method, headers, body: o.body, signal: o.signal });
  const live = relay.urls.filter((u) => !(relay.down[u] > Date.now()));
  let lastErr = null;
  for (const u of shuffled(live.length ? live : relay.urls)) {
    try {
      const r = await BeeE2E.ohttpFetch(u, relay.cfg, { method, authority: new URL(gateway).host, path, headers, body: o.body }, o.signal);
      relay.last = u;
      return r;
    } catch (e) {
      if (o.signal && o.signal.aborted) throw e;
      relay.down[u] = Date.now() + 60000;
      lastErr = e;
    }
  }
  throw new Error("所有中继都连不上：" + (lastErr ? lastErr.message : ""));
}
// Whether the relay used last hides the person's address from the gateway: only if it
// is run by someone other than the gateway's operator (named by the config, or by the log).
function relayHides() {
  if (!relay || !relay.last) return false;
  return relay.indep(relay.last);
}

// ---- talking to the gateway and to this service ----

function gw(method, path, body, extra) {
  return fetch(gateway + path, { method, headers: Object.assign({ "Content-Type": "application/json" }, embedded ? { "X-Fabric": "1" } : {}, key ? { Authorization: "Bearer " + key } : {}), body: body ? JSON.stringify(body) : undefined, ...(extra || {}) });
}
// History lives in this browser only. These paths used to be a server's; they are
// answered here, from IndexedDB, with the same shapes. Only /api/search still
// goes to the service (it asks the web for the page and keeps nothing).
function srv(method, path, body, ctype) {
  if (/^\/api\/(chats|media|export|data)/.test(path)) return local(method, path, body instanceof Blob || body == null ? body : JSON.parse(JSON.stringify(body))); // as if it had been sent: only plain data is kept
  return fetch(path.replace(/^[/]/, ""), { method, headers: Object.assign(ctype ? { "Content-Type": ctype } : body ? { "Content-Type": "application/json" } : {}, embedded ? { "X-Fabric": "1" } : {}, { Authorization: "Bearer " + key }), body: body == null ? undefined : (ctype ? body : JSON.stringify(body)) });
}

let dbp = null;
function idb() {
  return dbp || (dbp = new Promise((res, rej) => {
    const q = indexedDB.open("beenet-chat", 1);
    q.onupgradeneeded = () => { q.result.createObjectStore("chats"); q.result.createObjectStore("media"); };
    q.onsuccess = () => res(q.result);
    q.onerror = () => { dbp = null; rej(q.error); };
  }));
}
// one request on one store; fn gets the store and returns the request
async function idbRun(storeName, mode, fn) {
  const d = await idb();
  return new Promise((res, rej) => {
    const t = d.transaction(storeName, mode), r = fn(t.objectStore(storeName));
    t.oncomplete = () => res(r ? r.result : undefined);
    t.onerror = t.onabort = () => rej(t.error);
  });
}
const mineRange = () => IDBKeyRange.bound(tenant + "/", tenant + "/￿");
const jres = (v, status = 200) => new Response(JSON.stringify(v), { status, headers: { "Content-Type": "application/json" } });
const newId = () => Array.from(crypto.getRandomValues(new Uint8Array(10)), (b) => b.toString(16).padStart(2, "0")).join("");

async function allChats() {
  return idbRun("chats", "readonly", (s) => s.getAll(mineRange()));
}
function tidy(c) {
  c.title = String(c.title || "").trim().slice(0, 80) || "新对话";
  c.system = String(c.system || "").slice(0, 4000);
  c.messages = Array.isArray(c.messages) ? c.messages : [];
  c.updated = Date.now();
  return c;
}

async function local(method, path, body) {
  try {
    if (!tenant) return jres({ error: "not signed in" }, 401);
    let m;
    if (path === "/api/chats" && method === "GET") {
      const l = (await allChats()).map((c) => ({ id: c.id, title: c.title, pinned: c.pinned, updated: c.updated }));
      l.sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || b.updated - a.updated);
      return jres(l);
    }
    if (path === "/api/chats" && method === "POST") {
      const c = tidy(Object.assign({}, body, { id: newId() }));
      await idbRun("chats", "readwrite", (s) => s.put(c, tenant + "/" + c.id));
      return jres(c, 201);
    }
    if ((m = /^\/api\/chats\/([a-z0-9]+)$/.exec(path))) {
      const k = tenant + "/" + m[1];
      if (method === "GET") {
        const c = await idbRun("chats", "readonly", (s) => s.get(k));
        return c ? jres(c) : jres({ error: "not found" }, 404);
      }
      if (method === "PUT") {
        const c = tidy(Object.assign({}, body, { id: m[1] }));
        await idbRun("chats", "readwrite", (s) => s.put(c, k));
        return jres(c);
      }
      if (method === "DELETE") {
        const c = await idbRun("chats", "readonly", (s) => s.get(k));
        if (!c) return jres({ error: "not found" }, 404);
        await idbRun("chats", "readwrite", (s) => s.delete(k));
        // the pictures and videos only this conversation used go with it
        const used = new Set((await allChats()).flatMap((o) => o.messages.map((x) => x.media)));
        for (const x of c.messages) if (x.media && !used.has(x.media)) await idbRun("media", "readwrite", (s) => s.delete(tenant + "/" + x.media));
        return new Response(null, { status: 204 });
      }
    }
    if (path === "/api/media" && method === "POST") {
      const id = newId();
      await idbRun("media", "readwrite", (s) => s.put(body, tenant + "/" + id)); // a Blob keeps its type
      return jres({ id }, 201);
    }
    if ((m = /^\/api\/media\/([a-z0-9]+)$/.exec(path)) && method === "GET") {
      const b = await idbRun("media", "readonly", (s) => s.get(tenant + "/" + m[1]));
      return b ? new Response(b, { headers: { "Content-Type": b.type } }) : jres({ error: "not found" }, 404);
    }
    if (path === "/api/export" && method === "GET") return jres(await allChats());
    if (path === "/api/data" && method === "DELETE") {
      await idbRun("chats", "readwrite", (s) => s.delete(mineRange()));
      await idbRun("media", "readwrite", (s) => s.delete(mineRange()));
      return new Response(null, { status: 204 });
    }
    return jres({ error: "not found" }, 404);
  } catch (_) {
    return jres({ error: "this browser would not keep it" }, 500);
  }
}
async function errText(r) {
  let t = await r.text();
  try { const j = JSON.parse(t); t = (j.error && j.error.message) || j.error || t; } catch (_) { /* plain text */ }
  t = String(t).slice(0, 300);
  if (r.status === 402) return "点数用完了";
  const say = { 401: "密钥无效或已停用，请重新登录", 429: "请求太频繁，稍等一会儿再试", 502: "平台暂时连不上，稍后重试", 503: "平台暂时连不上，稍后重试", 504: "平台暂时连不上，稍后重试" }[r.status];
  return say ? say + "（" + r.status + (t ? "：" + t : "") + "）" : t;
}
// What a failed call says to the person: the browser's own network error is English.
function friendly(e) {
  const m = String((e && e.message) || e);
  return e instanceof TypeError || /failed to fetch|networkerror|load failed/i.test(m) ? "连不上平台，请检查网络后重试。" : m;
}
// One quiet line for screen readers, in place of reading out every frame of an answer.
function say(t) {
  if (!ui.status) return;
  ui.status.textContent = "";
  setTimeout(() => { ui.status.textContent = t; }, 50);
}

// ---- answers: a small, safe Markdown subset, built from elements and text ----

function inline(parent, text) {
  const re = /(`[^`\n]+`|~~[^~\n]+~~|\*\*[^*\n]+\*\*|\*[^*\n]+\*|\[[^\]\n]+\]\(https?:\/\/[^)\s]+\))/g;
  let last = 0, m;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) parent.append(document.createTextNode(text.slice(last, m.index)));
    const t = m[0];
    if (t.startsWith("`")) parent.append(h("code", { text: t.slice(1, -1) }));
    else if (t.startsWith("**")) parent.append(h("strong", { text: t.slice(2, -2) }));
    else if (t.startsWith("[")) { const i = t.indexOf("]("); parent.append(h("a", { href: t.slice(i + 2, -1), target: "_blank", rel: "noopener noreferrer", text: t.slice(1, i) })); }
    else if (t.startsWith("~~")) parent.append(h("del", { text: t.slice(2, -2) }));
    else parent.append(h("em", { text: t.slice(1, -1) }));
    last = m.index + t.length;
  }
  if (last < text.length) parent.append(document.createTextNode(text.slice(last)));
}

// A list, with the items indented under one as its sub-list. A bullet and a number do not share a list.
const ITEM = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
function listFrom(lines, i) {
  const base = ITEM.exec(lines[i])[1].length, ordered = /\d/.test(ITEM.exec(lines[i])[2]);
  const el = h(ordered ? "ol" : "ul");
  while (i < lines.length) {
    const m = ITEM.exec(lines[i]);
    if (!m || m[1].length < base || (m[1].length === base && /\d/.test(m[2]) !== ordered)) break;
    if (m[1].length > base) {
      const sub = listFrom(lines, i);
      if (el.lastElementChild) el.lastElementChild.append(sub.el); else el.append(h("li", {}, sub.el));
      i = sub.next; continue;
    }
    const li = h("li"); inline(li, m[3]); el.append(li); i++;
  }
  return { el, next: i };
}

function blocks(box, text) {
  const lines = text.split("\n");
  let i = 0, para = [];
  const flush = () => { if (para.length) { const p = h("p"); inline(p, para.join("\n")); box.append(p); para = []; } };
  while (i < lines.length) {
    const line = lines[i];
    let m;
    if ((m = /^(#{1,4})\s+(.*)$/.exec(line))) { flush(); const t = h(m[1].length <= 2 ? "h3" : "h4"); inline(t, m[2]); box.append(t); i++; continue; }
    if (/^\s*(---+|\*\*\*+)\s*$/.test(line)) { flush(); box.append(h("hr")); i++; continue; }
    if (/^>\s?/.test(line)) { flush(); const q = []; while (i < lines.length && /^>\s?/.test(lines[i])) { q.push(lines[i].replace(/^>\s?/, "")); i++; } const bq = h("blockquote"); inline(bq, q.join("\n")); box.append(bq); continue; }
    if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
      flush();
      const cells = (l) => l.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
      const tb = h("table"), head = h("tr");
      cells(line).forEach((c) => { const th = h("th"); inline(th, c); head.append(th); });
      tb.append(head); i += 2;
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) { const tr = h("tr"); cells(lines[i]).forEach((c) => { const td = h("td"); inline(td, c); tr.append(td); }); tb.append(tr); i++; }
      box.append(tb); continue;
    }
    if (ITEM.test(line)) { flush(); const r = listFrom(lines, i); box.append(r.el); i = r.next; continue; }
    if (line.trim() === "") { flush(); i++; continue; }
    para.push(line); i++;
  }
  flush();
}

function renderReply(box, m, streaming) {
  box.replaceChildren();
  if (m.thinking) {
    const d = h("details", { class: "thought" }, h("summary", { text: streaming && !m.content ? "正在思考…" : "思考过程" }), h("div", { class: "thought-text", text: m.thinking }));
    if (streaming && !m.content) d.open = true;
    box.append(d);
  }
  const body = h("div", {});
  box.append(body);
  renderText(body, m.content, streaming);
  if (m.secret) box.append(h("div", { class: "secret-note", text: "端到端加密 · 已验证的机密节点 " + m.secret.node + (m.secret.anon ? " · 匿名付费" : "") + (m.secret.hidden ? " · 经独立中继，网关看不到你的地址" : "") + (m.secret.logged ? " · 公开日志已核对" : "") }));
  if (m.sources && m.sources.length) {
    box.append(h("div", { class: "sources" }, h("span", { text: "来源：" }), ...m.sources.map((x, i) => h("a", { href: x.url, target: "_blank", rel: "noopener noreferrer", title: x.url, text: "[" + (i + 1) + "] " + x.title }))));
  }
}

// ---- SVG shown as a picture, not as code ----
// A model that is asked for an icon, a diagram or a simple drawing answers with SVG. It is
// shown here as the picture it is, with a way to see or save the code. It is drawn through
// an <img>, where a script cannot run and nothing outside can be fetched; the copy that
// can be saved is also cleaned of scripts, event handlers and outside references.
const SVG_RE = /<svg[\s>][\s\S]*?<\/svg>/i;
function cleanSvg(src) {
  let doc;
  try { doc = new DOMParser().parseFromString(src.trim(), "image/svg+xml"); } catch (_) { return null; }
  const el = doc.documentElement;
  if (!el || el.nodeName !== "svg" || doc.querySelector("parsererror")) return null;
  doc.querySelectorAll("script, foreignObject, iframe, object, embed, audio, video").forEach((n) => n.remove());
  doc.querySelectorAll("style").forEach((n) => { n.textContent = n.textContent.replace(/@import[^;]*;?/gi, "").replace(/url\(\s*['"]?(?!#)[^)]*\)/gi, "none"); });
  doc.querySelectorAll("*").forEach((n) => {
    for (const at of [...n.attributes]) {
      const name = at.name.toLowerCase(), v = at.value.trim().toLowerCase();
      if (name.startsWith("on") || ((name === "href" || name === "xlink:href") && !v.startsWith("#")) || (name === "style" && /url\(\s*['"]?(?!#)/.test(v))) n.removeAttribute(at.name);
    }
  });
  el.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  if (!el.getAttribute("viewBox")) {
    const w = parseFloat(el.getAttribute("width")), hh = parseFloat(el.getAttribute("height"));
    el.setAttribute("viewBox", w > 0 && hh > 0 ? "0 0 " + w + " " + hh : "0 0 512 512");
  }
  el.removeAttribute("width"); el.removeAttribute("height"); // the page sizes it
  return new XMLSerializer().serializeToString(doc);
}

function svgFigure(src) {
  const clean = cleanSvg(src);
  if (!clean) return null;
  const img = h("img", { src: "data:image/svg+xml;charset=utf-8," + encodeURIComponent(clean), alt: "图形" });
  const code = h("pre", { hidden: true }, h("code", { text: src.trim() }));
  const toggle = h("button", { class: "link", text: "查看代码" });
  toggle.addEventListener("click", () => { code.hidden = !code.hidden; toggle.textContent = code.hidden ? "查看代码" : "收起代码"; });
  const save = h("button", { class: "link", text: "保存" });
  save.addEventListener("click", () => {
    const u = URL.createObjectURL(new Blob([clean], { type: "image/svg+xml" }));
    const a = h("a", { href: u, download: "beenet-graphic.svg" });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(u), 5000);
  });
  return h("figure", { class: "svg-art" }, img, h("div", { class: "svg-acts" }, toggle, save), code);
}

// text between pictures: ordinary text, and any <svg>...</svg> in it as a picture
function textWithSvg(box, p, streaming) {
  let rest = p;
  for (;;) {
    const m = SVG_RE.exec(rest);
    if (!m) break;
    if (rest.slice(0, m.index).trim()) blocks(box, rest.slice(0, m.index));
    const fig = svgFigure(m[0]);
    if (fig) box.append(fig); else box.append(h("pre", {}, h("code", { text: m[0] })));
    rest = rest.slice(m.index + m[0].length);
  }
  const open = rest.search(/<svg[\s>]/i); // an svg still being written
  if (open >= 0 && streaming) {
    if (rest.slice(0, open).trim()) blocks(box, rest.slice(0, open));
    box.append(h("p", { class: "wait", text: "正在画图形…" }));
  } else if (rest.trim()) blocks(box, rest);
}

// ---- code, the way the well-known chat apps show it ----
// A fenced block gets a header with its language and the usual actions (copy, download,
// wrap, and for HTML a preview), syntax colours, and a scroll instead of a cut-off. The
// fences are read line by line, so ``` inside a line of text or inside the code does not
// end a block early, and ~~~ and longer fences work too.
function parseFences(text) {
  const lines = text.split("\n"), segs = [];
  let buf = [], i = 0;
  const flush = () => { if (buf.length) { segs.push({ type: "text", text: buf.join("\n") }); buf = []; } };
  while (i < lines.length) {
    const m = /^\s*(`{3,}|~{3,})\s*([^\s`]*)[^`]*$/.exec(lines[i]);
    if (!m) { buf.push(lines[i]); i++; continue; }
    flush();
    const fence = m[1], code = [];
    let closed = false;
    i++;
    while (i < lines.length) {
      const c = /^\s*(`{3,}|~{3,})\s*$/.exec(lines[i]);
      if (c && c[1][0] === fence[0] && c[1].length >= fence.length) { closed = true; i++; break; }
      code.push(lines[i]); i++;
    }
    segs.push({ type: "code", lang: (m[2] || "").toLowerCase(), code: code.join("\n"), closed });
  }
  flush();
  return segs;
}

const EXT = { python: "py", javascript: "js", typescript: "ts", go: "go", java: "java", kotlin: "kt", c: "c", cpp: "cpp", csharp: "cs", rust: "rs", bash: "sh", json: "json", html: "html", css: "css", sql: "sql", yaml: "yml", xml: "xml", markdown: "md", svg: "svg" };
const LANG_ALIAS = { js: "javascript", jsx: "javascript", mjs: "javascript", node: "javascript", ts: "typescript", tsx: "typescript", py: "python", python3: "python", golang: "go", "c++": "cpp", cc: "cpp", h: "c", hpp: "cpp", "c#": "csharp", cs: "csharp", rs: "rust", sh: "bash", shell: "bash", zsh: "bash", console: "bash", yml: "yaml", scss: "css", htm: "html", md: "markdown", kt: "kotlin" };
const KEYWORDS = (() => {
  const w = (x) => new Set(x.split(/\s+/));
  const js = "break case catch class const continue debugger default delete do else export extends finally for function if import in instanceof let new of return super switch this throw try typeof var void while with yield async await static get set true false null undefined";
  const c = "auto break case char const continue default do double else enum extern float for goto if inline int long register return short signed sizeof static struct switch typedef union unsigned void volatile while NULL true false class namespace template typename using new delete public private protected virtual override nullptr bool";
  return {
    javascript: w(js), typescript: w(js + " interface type enum implements private public protected readonly abstract declare namespace as is keyof"),
    python: w("and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield True False None self"),
    go: w("break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var true false nil"),
    java: w("abstract assert boolean break byte case catch char class const continue default do double else enum extends final finally float for if implements import instanceof int interface long native new package private protected public return short static super switch synchronized this throw throws try void volatile while true false null var record fun val when object override string"),
    csharp: w("abstract as base bool break byte case catch char class const continue decimal default delegate do double else enum event explicit extern false finally fixed float for foreach if in int interface internal is lock long namespace new null object operator out override params private protected public readonly ref return sbyte sealed short static string struct switch this throw true try typeof uint ulong unsafe ushort using var virtual void volatile while async await"),
    kotlin: w("as break class continue do else false for fun if in interface is null object package return super this throw true try typealias val var when while override open data sealed private public"),
    c: w(c), cpp: w(c),
    rust: w("as async await break const continue crate dyn else enum extern false fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait true type unsafe use where while"),
    bash: w("if then else elif fi for while do done case esac function in select until return exit export local readonly echo cd sudo"),
    sql: w("select from where and or not insert into values update set delete create table drop alter add join left right inner outer on group by order having limit offset as distinct union all null is in like between exists primary key foreign references index count sum avg min max case when then else end SELECT FROM WHERE AND OR NOT INSERT INTO VALUES UPDATE SET DELETE CREATE TABLE DROP ALTER ADD JOIN LEFT RIGHT INNER OUTER ON GROUP BY ORDER HAVING LIMIT OFFSET AS DISTINCT UNION ALL NULL IS IN LIKE BETWEEN EXISTS PRIMARY KEY FOREIGN REFERENCES INDEX COUNT SUM AVG MIN MAX CASE WHEN THEN ELSE END"),
    json: w("true false null"), yaml: w("true false null yes no"), css: w(""),
  };
})();
const SYNTAX = {
  javascript: { line: ["//"], block: ["/*", "*/"], quotes: "\"'`" }, typescript: { line: ["//"], block: ["/*", "*/"], quotes: "\"'`" },
  go: { line: ["//"], block: ["/*", "*/"], quotes: "\"'`" }, java: { line: ["//"], block: ["/*", "*/"], quotes: "\"'" }, csharp: { line: ["//"], block: ["/*", "*/"], quotes: "\"'" },
  kotlin: { line: ["//"], block: ["/*", "*/"], quotes: "\"'" }, c: { line: ["//"], block: ["/*", "*/"], quotes: "\"'" }, cpp: { line: ["//"], block: ["/*", "*/"], quotes: "\"'" },
  rust: { line: ["//"], block: ["/*", "*/"], quotes: "\"'" }, python: { line: ["#"], quotes: "\"'", triple: true },
  bash: { line: ["#"], quotes: "\"'", vars: true }, yaml: { line: ["#"], quotes: "\"'", key: true }, sql: { line: ["--"], block: ["/*", "*/"], quotes: "\"'" },
  json: { line: [], quotes: "\"", key: true }, css: { line: [], block: ["/*", "*/"], quotes: "\"'", css: true },
};

// highlight returns the code as text with <span class="tok-..."> around the parts that have a colour.
// Unknown languages and very long code stay plain.
function highlight(code, lang) {
  const name = LANG_ALIAS[lang] || lang;
  const frag = document.createDocumentFragment();
  if (name === "html" || name === "xml" || name === "svg") return highlightMarkup(code, frag);
  const L = SYNTAX[name];
  if (!L || code.length > 30000) { frag.append(code); return frag; }
  const kw = KEYWORDS[name] || new Set();
  let i = 0, plain = "";
  const out = (cls, t) => { if (plain) { frag.append(plain); plain = ""; } frag.append(h("span", { class: "tok-" + cls, text: t })); };
  while (i < code.length) {
    const c = code[i];
    if (L.block && code.startsWith(L.block[0], i)) { let e = code.indexOf(L.block[1], i + L.block[0].length); e = e < 0 ? code.length : e + L.block[1].length; out("c", code.slice(i, e)); i = e; continue; }
    if (L.line.some((m) => code.startsWith(m, i))) { let e = code.indexOf("\n", i); if (e < 0) e = code.length; out("c", code.slice(i, e)); i = e; continue; }
    if (L.triple && (code.startsWith('"""', i) || code.startsWith("'''", i))) { const q = code.substr(i, 3); let e = code.indexOf(q, i + 3); e = e < 0 ? code.length : e + 3; out("s", code.slice(i, e)); i = e; continue; }
    if (L.quotes.includes(c)) {
      let e = i + 1;
      while (e < code.length && code[e] !== c && (c === "`" || code[e] !== "\n")) e += code[e] === "\\" ? 2 : 1;
      e = Math.min(code.length, e + 1);
      const str = code.slice(i, e);
      out(L.key && /^\s*:/.test(code.slice(e, e + 20)) ? "f" : "s", str); i = e; continue;
    }
    if (/[0-9]/.test(c) && !/[\w$]/.test(code[i - 1] || "")) { const m = /^(0x[\da-f]+|\d+(\.\d+)?(e[+-]?\d+)?)[a-z%]*/i.exec(code.slice(i, i + 40)); if (m) { out("n", m[0]); i += m[0].length; continue; } }
    if (L.vars && c === "$") { const m = /^\$(\{[^}]*\}|\w+)/.exec(code.slice(i, i + 80)); if (m) { out("t", m[0]); i += m[0].length; continue; } }
    if (/[A-Za-z_$]/.test(c)) {
      const w = /^[A-Za-z_$][\w$-]*/.exec(code.slice(i, i + 80))[0].replace(/-+$/, "");
      const after = code.slice(i + w.length, i + w.length + 20);
      if (kw.has(w)) out("k", w);
      else if (L.key && /^\s*:(\s|$)/.test(after)) out("f", w);
      else if (L.css && /^\s*:/.test(after)) out("t", w);
      else if (/^\s*\(/.test(after)) out("f", w);
      else if (/^[A-Z]/.test(w) && w.length > 1 && !L.css) out("t", w);
      else plain += w;
      i += w.length; continue;
    }
    plain += c; i++;
  }
  if (plain) frag.append(plain);
  return frag;
}

function highlightMarkup(code, frag) {
  if (code.length > 30000) { frag.append(code); return frag; }
  const re = /(<!--[\s\S]*?(?:-->|$))|(<\/?[A-Za-z][\w:-]*)|("[^"\n]*"|'[^'\n]*')|([\w:-]+)(?==)|(\/?>)/g;
  let last = 0, m;
  while ((m = re.exec(code))) {
    if (m.index > last) frag.append(code.slice(last, m.index));
    const cls = m[1] ? "c" : m[2] ? "k" : m[3] ? "s" : m[4] ? "t" : "p";
    frag.append(cls === "p" ? m[0] : h("span", { class: "tok-" + cls, text: m[0] }));
    last = m.index + m[0].length;
  }
  if (last < code.length) frag.append(code.slice(last));
  return frag;
}

function codeBlock(box, lang, code) {
  const name = LANG_ALIAS[lang] || lang;
  const codeEl = h("code", {});
  codeEl.append(highlight(code, lang));
  const pre = h("pre", {}, codeEl);
  const head = h("div", { class: "code-head" }, h("span", { class: "code-lang", text: lang || "代码" }), h("span", { class: "grow" }));
  const wrap = h("button", { class: "link", text: "换行", onclick: () => { const on = pre.classList.toggle("wrap"); wrap.textContent = on ? "不换行" : "换行"; } });
  head.append(wrap);
  let holder = null;
  if (name === "html" && /<\w/.test(code)) {
    holder = h("div", { class: "code-preview", hidden: true });
    const pv = h("button", { class: "link", text: "预览", onclick: () => {
      holder.hidden = !holder.hidden;
      pv.textContent = holder.hidden ? "预览" : "收起预览";
      // static HTML and CSS only: no scripts, no forms, no outside access
      if (!holder.hidden && !holder.firstChild) holder.append(h("iframe", { sandbox: "", srcdoc: code, title: "预览" }));
    } });
    head.append(pv);
  }
  head.append(h("button", { class: "link", text: "下载", onclick: () => {
    const u = URL.createObjectURL(new Blob([code], { type: "text/plain;charset=utf-8" }));
    const a = h("a", { href: u, download: "code." + (EXT[name] || "txt") });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(u), 5000);
  } }));
  const copy = h("button", { class: "link copy", text: "复制" });
  copy.addEventListener("click", () => navigator.clipboard.writeText(code).then(() => { copy.textContent = "已复制"; setTimeout(() => { copy.textContent = "复制"; }, 1500); }, () => {}));
  head.append(copy);
  box.append(h("div", { class: "codeblock" }, head, pre, holder));
}

function renderText(box, text, streaming) {
  box.replaceChildren();
  const segs = parseFences(text);
  segs.forEach((seg, i) => {
    const last = i === segs.length - 1;
    if (seg.type === "text") { if (seg.text.trim()) textWithSvg(box, seg.text, streaming && last); return; }
    // a drawing in SVG is shown as the drawing
    const isSvg = /^\s*(<\?xml[^>]*\?>\s*)?<svg[\s>]/i.test(seg.code) && ["svg", "xml", "html", ""].includes(seg.lang);
    if (isSvg) {
      if (seg.closed || SVG_RE.test(seg.code)) { const fig = SVG_RE.test(seg.code) && svgFigure(seg.code.match(SVG_RE)[0]); if (fig) { box.append(fig); return; } }
      else if (streaming) { box.append(h("p", { class: "wait", text: "正在画图形…" })); return; }
    }
    codeBlock(box, seg.lang, seg.code);
  });
}

// ---- models ----

const isVideo = (id) => /video|wan|t2v|i2v|h3/i.test(id);
const isImage = (id) => /image|flux|sdxl|stable/i.test(id);
const kindOf = (id) => (isVideo(id) ? "video" : isImage(id) ? "image" : "text");
function label(id) {
  if (id === "auto") return "自动（推荐）";
  if (/^(chat|code|video)-default$|^chat-strong$/.test(id)) return { "chat-strong": "最强（聊天）", "chat-default": "快速（聊天）", "code-default": "自动（代码）", "video-default": "自动（视频）" }[id];
  return /h3/i.test(id) ? "MiniMax H3" : id;
}
const modelsOf = (k) => models.filter((m) => m.kind === k);

// What a message asks for is decided from the words, as in ChatGPT: a request
// to draw or to make a video makes one, anything else is answered in words.
// Words that show it is a question about making things (code, how-to) stay text.
// An answer can be redone as the other kind with one click, so a wrong guess costs one.
const NOT_MAKING = /(代码|程序|函数|脚本|算法|教程|怎么|如何|为什么|是什么|原理|区别|\bcode\b|\bscript\b|\bfunction\b|\bhow (do|to|can)\b|\bwhy\b)/i;
const IMAGE_ASK = new RegExp(
  "^/(图|画|image)(\\s|$)" +
  "|^画" +
  "|(画|绘制|绘画|生成|制作|创作|设计|来|做|出|给我|帮我|想要|要)[^，。！？\\n]{0,14}(图|图片|图像|照片|插画|海报|壁纸|头像|封面|logo|漫画|手绘)" +
  "|^[^，。！？\\n]{2,60}的(图片|图像|照片|插画|海报|壁纸|头像|漫画)[。！!]?$" + // 雪地里红狐的插画
  "|\\b(draw|paint|sketch|illustrate|generate|create|make|render|show me)\\b[^.\\n]{0,40}\\b(image|picture|photo|illustration|poster|logo|wallpaper|painting|drawing|portrait)\\b", "i");
const VIDEO_ASK = new RegExp(
  "^/(视频|video)(\\s|$)" +
  "|(生成|制作|创作|来|做|拍|出|给我|帮我|想要|要)[^，。！？\\n]{0,14}(视频|短片|动画|影片|短视频)" +
  "|^[^，。！？\\n]{2,60}(的|个|段|条)(视频|短片|动画|影片|短视频)[。！!]?$" + // 一只小鹿在森林奔跑的视频
  "|\\b(generate|create|make|render|produce)\\b[^.\\n]{0,40}\\b(video|clip|animation|movie)\\b", "i");
const COMMAND = /^\/(图|画|image|视频|video|文|text)(\s+|$)/i;
// After some talk, a short request that points back at it ("把它画出来", "就按这个画",
// "做成视频") asks for a picture or video too, though it names no picture. These count
// only when there is an earlier conversation to point at, and only when short.
const IMAGE_REF = /^[^，。！？\n]{0,14}(画|绘制|生成|出)(出来|下来|一张|一幅|成图|成图片|吧|看看|图)|^[^，。！？\n]{0,10}(按|照)[^，。！？\n]{0,10}(画|绘制|生成)|^(来一张|来张图|画吧|开始画|动手画|出图)/;
const VIDEO_REF = /^[^，。！？\n]{0,14}(做成|生成|拍成|制作成|变成)[^，。！？\n]{0,6}(视频|动画|短片)|^[^，。！？\n]{0,10}拍(出来|下来)/;
function detectKind(text, hasContext, wordsOnly) {
  const have = (k) => wordsOnly || modelsOf(k).length;
  const t = text.trim();
  if (/^\/(文|text)(\s+|$)/i.test(t)) return "text";
  const strong = COMMAND.test(t);
  if (!strong && NOT_MAKING.test(t)) return "text";
  if (hasContext && t.length <= 30) {
    const core = t.replace(/^(好的|好|嗯|行|对|可以|那就|那)[，, ]*/, ""); // "好，把它画出来"
    if (VIDEO_REF.test(core) && have("video")) return "video";
    if (IMAGE_REF.test(core) && have("image")) return "image";
  }
  if (VIDEO_ASK.test(t) && have("video")) return "video";
  if (IMAGE_ASK.test(t) && have("image")) return "image";
  return "text";
}
// The words ask for a picture or a video, but no model that makes one is on offer right now (the
// computers that run it are away). Answering in words, and searching the web for it, is not what
// was asked: say so, and let the person choose.
const unavailableKind = (text, hasContext) => { const k = detectKind(text, hasContext, true); return k !== "text" && !modelsOf(k).length ? k : ""; };
const stripCommand = (t) => t.replace(COMMAND, "");

// The model that makes a picture or a video: the one chosen in Settings, else the
// first that is not a licensed-region model (H3 is for accounts that chose it).
function makerModel(kind) {
  const ms = modelsOf(kind), want = load("beenet-chat-" + kind + "-model");
  return (ms.find((m) => m.id === want) || ms.find((m) => !/h3/i.test(m.id)) || ms[0] || {}).id;
}

// What the platform said about the account: "ok", "denied" (it does not accept the key: only a 401
// means that), or "away" (no answer, a 5xx, a timeout). Only "denied" may end a login; a platform
// that is down for a minute must never cost anyone their saved key.
let acctState = "ok";
async function loadModels() {
  const res = await gw("GET", "/v1/account").catch(() => null);
  let acct = null;
  if (!res) acctState = "away";
  else if (res.status === 401) acctState = "denied";
  else if (!res.ok) acctState = "away";
  else { acctState = "ok"; acct = await res.json().catch(() => null); }
  if (acct) { tenant = acct.tenant || ""; balance = acct.available; }
  let list = [];
  if (tenant.startsWith("try-")) {
    const info = await fetch(gateway + "/v1/trial").then((r) => (r.ok ? r.json() : null)).catch(() => null);
    list = ((info && info.models) || []).map((m) => ({ id: m.id, kind: m.kind === "chat" ? "text" : m.kind }));
  } else {
    const r = await gw("GET", "/v1/models").catch(() => null);
    if (r && r.ok) list = ((await r.json()).data || []).map((m) => ({ id: m.id, kind: kindOf(m.id) }));
  }
  models = list;
}

// ---- stored media: shown through blob URLs, since the key travels in a header ----

const blobs = new Map();
async function mediaURL(id) {
  if (blobs.has(id)) return blobs.get(id);
  const r = await srv("GET", "/api/media/" + encodeURIComponent(id));
  if (!r.ok) return "";
  const u = URL.createObjectURL(await r.blob());
  blobs.set(id, u);
  return u;
}

// ---- sign in ----

// The client's earlier chat and code tabs kept their conversations in this browser under
// "fabric.convs.*". They are copied into this page's own store, once; the old copies stay.
async function migrateOldClientChats() {
  if (load("beenet-chat-migrated") === "1") return;
  try {
    for (const kind of ["chat", "code"]) {
      let list = [];
      try { list = JSON.parse(localStorage.getItem("fabric.convs." + kind) || "[]"); } catch (_) { list = []; }
      for (const c of list.slice().reverse()) {
        const t = Number(c.id) || Date.now();
        const messages = (c.msgs || []).filter((m) => m && m.content && (m.role === "user" || m.role === "assistant")).map((m) => ({ role: m.role, content: String(m.content), t }));
        if (messages.length) await srv("POST", "/api/chats", { title: (kind === "code" ? "[代码] " : "") + (c.title || "旧对话"), system: "", model: "", messages });
      }
    }
  } catch (_) { /* a conversation that cannot be copied stays where it was */ }
  store("beenet-chat-migrated", "1");
}

// Inside the client, without an account: the client's own pages do the signing in.
// The platform could not be reached. The key and the conversations stay where they are, and
// nothing here says the login is gone: it is not.
function awayView() {
  $("#app").replaceChildren(h("div", { class: "login" },
    h("div", { class: "brand" }, h("img", { src: "logo.svg", alt: "", width: "30", height: "30" }), h("span", { text: "蜂网聊天" })),
    h("p", { class: "msg", role: "status", text: "现在连不上平台。你的账户和对话都还在，网络恢复后点“重试”。" }),
    h("button", { class: "btn primary", text: "重试", onclick: () => boot() })));
}

function notSignedIn() {
  $("#app").replaceChildren(h("div", { class: "login" },
    h("div", { class: "brand" }, h("img", { src: "logo.svg", alt: "", width: "30", height: "30" }), h("span", { text: "蜂网聊天" })),
    h("p", { class: "msg bad", text: "客户端还没有登录账户，或登录已失效。" }),
    h("a", { class: "btn primary", href: "/#/account", text: "到客户端登录" })));
}

function startView(note) {
  const msg = h("p", { class: "msg" + (note ? " bad" : ""), text: note || "" });
  const keyIn = h("input", { type: "password", placeholder: "sk-fab-…", "aria-label": "API 密钥", autocomplete: "off" });
  const login = h("button", { class: "btn primary", text: "登录" });
  const run = async (k) => {
    msg.className = "msg"; msg.textContent = "";
    key = k;
    try {
      const r = await gw("GET", "/v1/account");
      if (r.status === 401) throw new Error("平台不认这个密钥");
      if (!r.ok) throw new Error("服务暂时不可用");
      store(KEY, key);
      await boot();
    } catch (e) { key = ""; msg.className = "msg bad"; msg.textContent = friendly(e); }
  };
  login.addEventListener("click", () => { const k = keyIn.value.trim(); if (k) { login.disabled = true; run(k).finally(() => { login.disabled = false; }); } });
  keyIn.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.isComposing) login.click(); });
  const tmsg = h("p", { class: "msg" });
  const trial = h("button", { class: "btn", text: "领取体验点数" });
  trial.addEventListener("click", async () => {
    trial.disabled = true; tmsg.className = "msg"; tmsg.textContent = "正在准备…";
    try {
      const ir = await fetch(gateway + "/v1/trial");
      if (!ir.ok) throw new Error(await errText(ir));
      const info = await ir.json();
      const nonce = await new Promise((res, rej) => {
        const w = new Worker("pow.js");
        w.onmessage = (e) => { if (e.data.nonce != null) { w.terminate(); res(e.data.nonce); } else tmsg.textContent = "正在验证你是真人…"; };
        w.onerror = () => { w.terminate(); rej(new Error("浏览器不能运行验证，请换一个浏览器再试")); };
        w.postMessage({ challenge: info.challenge, bits: info.bits });
      });
      const r = await fetch(gateway + "/v1/trial", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ challenge: info.challenge, nonce }) });
      if (!r.ok) throw new Error(await errText(r));
      await run((await r.json()).api_key);
    } catch (e) { tmsg.className = "msg bad"; tmsg.textContent = friendly(e); } finally { trial.disabled = false; }
  });
  app.replaceChildren(h("div", { class: "start" },
    h("div", { class: "brand" }, h("img", { src: "logo.svg", alt: "", width: "30", height: "30" }), h("span", { text: "蜂网聊天" })),
    h("div", { class: "panel" }, h("h2", { text: "用蜂网账户登录" }),
      h("p", { class: "muted", text: "用账户的 API 密钥登录。对话、图片和视频只保存在这个浏览器里，服务器不保存任何内容。换浏览器或清除站点数据后，历史就没有了，可以在设置里导出。" }),
      h("p", { class: "muted", text: "没有密钥？点下面的“领取体验点数”，不用注册就能用。已注册的账户，在注册时用的那台电脑的客户端“账户”页点“显示密钥”复制。" }),
      keyIn, h("div", { class: "row" }, login), msg),
    h("div", { class: "panel" }, h("h2", { text: "先试试" }),
      h("p", { class: "muted", text: "不用注册，不用邮箱。领一份体验点数，直接聊天、画图、做视频。体验账户是匿名的，密钥只保存在这个浏览器里。" }),
      h("div", { class: "row" }, trial), tmsg),
    h("div", { class: "note", text: "内容可能由志愿者的电脑运行，请不要输入隐私或机密。" })));
}

// ---- the app ----

const group = (t) => {
  const d = new Date(), start = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(), day = 864e5;
  return t >= start ? "今天" : t >= start - day ? "昨天" : t >= start - 7 * day ? "过去 7 天" : "更早";
};

let ui = {};

function ask(title, value, multi, okText) {
  return new Promise((res) => {
    const f = multi ? h("textarea", { rows: "6", maxlength: "4000" }) : h("input", { type: "text", maxlength: "80" });
    f.value = value || "";
    const dlg = h("dialog", {}, h("h2", { text: title }), f,
      h("div", { class: "row" }, h("button", { class: "btn", text: "取消", onclick: () => dlg.close("") }), h("button", { class: "btn primary", text: okText || "确定", onclick: () => dlg.close("ok") })));
    dlg.addEventListener("close", () => { const ok = dlg.returnValue === "ok"; dlg.remove(); res(ok ? f.value : null); });
    document.body.append(dlg); dlg.showModal(); f.focus();
  });
}

// A key handed over from the online workspace arrives in the address fragment,
// which no server sees; it is taken and removed from the address at once.
function takeHandedKey() {
  const m = /^#key=([^&]+)$/.exec(location.hash);
  if (!m) return;
  try { const k = decodeURIComponent(m[1]); if (k.length >= 8 && k.length <= 200) { key = k; store(KEY, k); } } catch (_) { /* a broken fragment is ignored */ }
  history.replaceState(null, "", location.pathname + location.search);
}

// The mint, if this gateway offers bearer tokens: its public keys and the answer-length tiers.
async function loadMint() {
  try {
    const r = await net("GET", "/v1/mint/keys");
    if (!r.ok) return;
    mintInfo = await r.json();
    wallet = BeeMint.Wallet.load(mintInfo.keys);
    if (!mintInfo.answer_caps.includes(answerCap)) answerCap = mintInfo.answer_caps[Math.min(2, mintInfo.answer_caps.length - 1)];
  } catch (_) { mintInfo = null; }
}

async function boot() {
  takeHandedKey();
  try {
    const cfg = await (await fetch("config.json")).json();
    gateway = cfg.gateway;
    embedded = !!cfg.embedded;
    e2eCfg = { verifiers: cfg.verifiers || {}, quorum: cfg.quorum || 0 };
    if (cfg.tlog && cfg.tlog.url && cfg.tlog.logKey) tlogCfg = cfg.tlog;
    if (cfg.ohttp && cfg.ohttp.keys) {
      try {
        const statics = cfg.ohttp.relays || [];
        relay = { keysB64: cfg.ohttp.keys, urls: statics.slice(), down: {}, ops: {}, gatewayOperator: "", last: "", cfg: BeeE2E.parseKeyConfig(Uint8Array.from(atob(cfg.ohttp.keys), (c) => c.charCodeAt(0))),
          // a relay named in the service's config is independent if the operator says so; one the log lists, if its operator is not the gateway's
          indep(u) { return statics.includes(u) ? !!cfg.ohttp.independent : !!(this.ops[u] && this.gatewayOperator && this.ops[u] !== this.gatewayOperator); } };
      } catch (_) { relay = null; }
    }
    // A person can replace the trusted set with their own (stored only here).
    const mine = JSON.parse(load("beenet-chat-verifiers") || "null");
    if (mine && mine.verifiers && mine.quorum >= 1) e2eCfg = mine;
  } catch (_) { gateway = gateway || ""; }
  if (!key && !embedded) return startView();
  if (tlogCfg) await checkLog().catch(() => null); // learn the relays the log lists; a failure shows when secret mode is used
  await loadMint();
  await loadModels();
  if (!tenant) {
    if (acctState === "away") return awayView();
    if (embedded) return notSignedIn();
    key = ""; store(KEY, null); return startView("登录已失效，请重新登录。");
  }
  if (embedded) await migrateOldClientChats();
  const r = await srv("GET", "/api/chats").catch(() => null);
  chats = r && r.ok ? await r.json() : [];
  buildShell();
  newChat();
  paintList();
}

function buildShell() {
  const search = h("input", { type: "search", placeholder: "搜索对话", "aria-label": "搜索对话" });
  search.addEventListener("input", scheduleSearch);
  const list = h("div", { class: "convs", role: "list" });
  const bal = h("span", { class: "bal", text: balance != null ? fmt(balance) : "" });
  const title = h("h1", { class: "grow", text: "新对话" });
  const log = h("div", { class: "log" });
  const status = h("div", { class: "sr-only", role: "status" });
  const input = h("textarea", { rows: "1", "aria-label": "输入" });
  const count = h("span", { class: "count", "aria-live": "polite" });
  const jump = h("button", { class: "jump btn", type: "button", hidden: true, text: "回到底部 ↓", onclick: followNow });
  const send = h("button", { class: "btn primary", text: "发送" });
  const err = h("p", { class: "msg bad" });
  const sel = h("select", { "aria-label": "模型" });
  const thinkBtn = h("button", { class: "btn think", type: "button", "aria-pressed": String(think), title: "打开后，模型会先想一想再回答：答案更稳，但要等得更久" }, "思考");
  thinkBtn.addEventListener("click", () => { think = !think; store("beenet-chat-think", think ? "on" : "off"); thinkBtn.setAttribute("aria-pressed", String(think)); });
  const secretBtn = h("button", { class: "btn think", type: "button", "aria-pressed": String(secret), title: "打开后，这段对话端到端加密：只有通过验证的机密节点能读到内容，平台和节点的主人都看不到。机密模式下不联网搜索，也不能画图和做视频。" }, "机密");
  secretBtn.addEventListener("click", () => { secret = !secret; store("beenet-chat-secret", secret ? "on" : "off"); secretBtn.setAttribute("aria-pressed", String(secret)); });
  secretBtn.hidden = !(e2eCfg.quorum >= 1);
  const anonBtn = h("button", { class: "btn think", type: "button", "aria-pressed": String(anon), title: "打开后，用匿名额度付费：请求里没有账号和密钥，平台不知道是谁在用。先从账户里取出一些匿名额度；额度只存在这个浏览器里，请备份。" }, "匿名付费");
  anonBtn.addEventListener("click", async () => {
    anon = !anon; store("beenet-chat-anon", anon ? "on" : "off"); anonBtn.setAttribute("aria-pressed", String(anon));
    if (anon && wallet && wallet.balance() < 2000) await topUp();
    paintWallet();
  });
  anonBtn.hidden = !(e2eCfg.quorum >= 1 && mintInfo);
  const walletNote = h("span", { class: "wallet-note" });
  const shell = h("div", { class: "shell" });
  ui = { search, list, bal, title, log, input, send, err, sel, shell, thinkBtn, secretBtn, anonBtn, walletNote, count, jump, status };

  sel.addEventListener("change", () => { if (cur) cur.model = sel.value; });
  input.addEventListener("input", () => { input.style.height = "auto"; input.style.height = Math.min(input.scrollHeight, window.innerHeight * 0.4) + "px"; paintCount(); });
  input.addEventListener("keydown", (e) => {
    // ↑ in an empty box edits the last message of the person's
    if (e.key === "ArrowUp" && !input.value && !busy) {
      const row = [...log.querySelectorAll(".msgrow.user")].pop();
      const m = cur.messages.filter((x) => x.role === "user").pop();
      if (row && m) { e.preventDefault(); editMessage(row, m); }
      return;
    }
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); if (!busy) submit(); }
  });
  send.addEventListener("click", () => { if (busy) busy.abort(); else submit(); });
  log.addEventListener("scroll", () => { following = atBottom(); paintJump(); });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && busy) { busy.abort(); return; }
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === "k") { e.preventDefault(); shell.classList.add("open"); search.focus(); }
  });

  const file = h("input", { type: "file", hidden: true, accept: TEXT_TYPES, "aria-label": "选择文本文件" });
  file.addEventListener("change", () => { const f = file.files[0]; file.value = ""; if (f) attachFile(f); });
  const attach = h("button", { class: "btn think", type: "button", title: "把一个文本或代码文件放进输入框（最大 200 KB）", onclick: () => file.click() }, "附件");

  const menu = h("button", { class: "btn menu", "aria-label": "对话列表", text: "对话", onclick: () => shell.classList.toggle("open") });
  shell.append(
    h("aside", { class: "side" },
      h("div", { class: "top" },
        h("div", { class: "brand" }, h("img", { src: "logo.svg", alt: "", width: "24", height: "24" }), h("span", { text: "蜂网聊天" })),
        h("button", { class: "btn primary", text: "新对话", onclick: () => { if (busy) return flashBusy(); newChat(); shell.classList.remove("open"); } }), search),
      list,
      h("div", { class: "foot" },
        h("div", { class: "who" }, h("span", { class: "muted", text: tenant.startsWith("try-") ? "体验账户" : tenant }), h("span", {}, "点数 ", bal)),
        h("div", { class: "row" }, h("button", { class: "link", text: "设置", onclick: settings }), embedded ? h("a", { class: "link", href: "/#/share", text: "客户端" }) : h("button", { class: "link", text: "退出", onclick: signOut })))),
    h("main", { class: "main" },
      h("div", { class: "bar" }, menu, title,
        h("button", { class: "btn", text: "导出", title: "把这个对话存成 Markdown 文件", onclick: exportChat }), h("button", { class: "btn", text: "对话设置", onclick: chatSettings })),
      log, status,
      h("div", { class: "composer" }, jump,
        h("div", { class: "box" }, input,
          h("div", { class: "tools" }, sel, thinkBtn, secretBtn, anonBtn, attach, file, walletNote, count, h("span", { class: "grow" }), send)),
        err,
        h("div", { class: "hint", text: "直接说想要什么：提问、写代码、画图、做视频，会自动判断。Enter 发送，Shift+Enter 换行。内容可能由志愿者的电脑运行，请不要输入隐私或机密。" }))));
  app.replaceChildren(shell);
  paintMode();
}

// The picker lists the models that answer in words; pictures and video follow the words of the message.
function paintMode() {
  const ms = modelsOf("text");
  ms.sort((a, b) => (b.id === "auto") - (a.id === "auto"));
  ui.sel.replaceChildren(...ms.map((m) => h("option", { value: m.id, text: label(m.id) })));
  const want = (cur && cur.model) || (ms.find((m) => m.id === "auto") || ms.find((m) => m.id === "chat-strong") || ms.find((m) => m.id === "chat-default") || {}).id;
  if (want && ms.some((m) => m.id === want)) ui.sel.value = want;
  ui.sel.hidden = ms.length < 2;
  ui.input.placeholder = "想问点什么，想画什么，想做什么视频？";
  ui.send.disabled = !models.length;
}

// Search looks through the words of the stored chats as well as their titles. It waits a
// moment after typing, and only the newest search counts: a slow answer for an older
// question is dropped. The open conversation is searched as it is on the page, saved or not.
let hitList = [], hitsFor = "", searchSeq = 0, searchTimer = 0;
function scheduleSearch() {
  clearTimeout(searchTimer);
  const q = ui.search.value.trim();
  if (!q) { hitList = []; hitsFor = ""; paintList(); return; }
  paintList();
  searchTimer = setTimeout(() => runSearch(q), 250);
}
async function runSearch(q) {
  const seq = ++searchSeq;
  const r = await srv("GET", "/api/export").catch(() => null);
  if (seq !== searchSeq || !r || !r.ok) return;
  let all = await r.json();
  if (cur && cur.messages.length) all = all.filter((c) => c.id !== cur.id).concat([Object.assign({}, cur, { updated: Date.now() })]);
  const lower = q.toLowerCase();
  const list = [];
  for (const c of all) {
    const title = String(c.title || "");
    const m = (c.messages || []).find((x) => String(x.content || "").toLowerCase().includes(lower));
    if (!m && !title.toLowerCase().includes(lower)) continue;
    list.push({ id: c.id || "", title, pinned: !!c.pinned, updated: c.updated || 0, snippet: m ? snippetOf(m.content, lower) : "" });
  }
  list.sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || b.updated - a.updated);
  if (seq !== searchSeq) return;
  hitList = list; hitsFor = q;
  paintList();
}
// the words around the first match, with the match kept whole
function snippetOf(text, lower) {
  // the markdown marks are left out: a snippet reads as the words
  const s = String(text).replace(/[*`#>]+/g, "").replace(/\s+/g, " ");
  const i = s.toLowerCase().indexOf(lower);
  const from = Math.max(0, i - 24), to = i + lower.length + 40;
  return (from > 0 ? "…" : "") + s.slice(from, to) + (to < s.length ? "…" : "");
}

function paintList() {
  const q = ui.search.value.trim().toLowerCase();
  // the words found, once the search for this text has finished; until then, the titles
  const items = q && hitsFor === ui.search.value.trim() ? hitList : chats.filter((c) => !q || c.title.toLowerCase().includes(q));
  const out = [];
  let lastG = "";
  for (const c of items) {
    const g = c.pinned ? "置顶" : group(c.updated);
    if (g !== lastG) { out.push(h("h3", { text: g })); lastG = g; }
    out.push(h("div", { class: "conv" + (cur && cur.id === c.id ? " on" : ""), role: "listitem" },
      h("button", { class: "title", text: c.title, onclick: () => { if (busy) return flashBusy(); if (c.id) openChat(c.id); ui.shell.classList.remove("open"); } }),
      c.snippet ? h("span", { class: "snip", text: c.snippet }) : null,
      h("span", { class: "acts" },
        h("button", { class: "link", text: c.pinned ? "取消置顶" : "置顶", onclick: () => pin(c) }),
        h("button", { class: "link", text: "改名", onclick: () => rename(c) }),
        h("button", { class: "link", text: "删除", onclick: () => remove(c) }))));
  }
  if (!out.length) out.push(h("p", { class: "muted", text: q ? (keep ? "没有匹配的对话" : "没有匹配的对话。保存对话已关闭，搜索只包括这个页面里的对话") : keep ? "还没有对话" : "保存对话已关闭，对话只在这个页面里" }));
  ui.list.replaceChildren(...out);
}

// Text files a person may attach: read in the browser and put in the box, nothing sent.
const TEXT_TYPES = ".txt,.md,.markdown,.csv,.json,.yaml,.yml,.xml,.html,.css,.js,.ts,.jsx,.tsx,.py,.go,.java,.kt,.c,.h,.cpp,.hpp,.cs,.rs,.rb,.php,.sh,.sql,.log";
const MAX_FILE = 200 * 1024;
async function attachFile(f) {
  ui.err.textContent = "";
  if (f.size > MAX_FILE) { ui.err.textContent = "文件太大（" + Math.round(f.size / 1024) + " KB），最多 200 KB。"; return; }
  const text = await f.text();
  if (text.includes("\u0000")) { ui.err.textContent = "这不像是文本文件，没有放进来。"; return; }
  const lang = (f.name.split(".").pop() || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  // a fence longer than any run of backticks in the file keeps the file's own fences intact
  const run = Math.max(2, ...(text.match(/`+/g) || []).map((x) => x.length));
  const fence = "`".repeat(run + 1);
  const block = "文件：" + f.name + "\n" + fence + lang + "\n" + text.replace(/\n$/, "") + "\n" + fence + "\n";
  const next = ui.input.value ? ui.input.value.replace(/\s*$/, "") + "\n\n" + block : block;
  if (next.length > MAX_INPUT) { ui.err.textContent = "放进来会超过 " + MAX_INPUT.toLocaleString("zh-CN") + " 字（这个文件有 " + text.length.toLocaleString("zh-CN") + " 字）。可以只选文件的一部分，或分几次发。"; return; }
  ui.input.value = next;
  ui.input.dispatchEvent(new Event("input"));
  ui.input.focus();
}

function newChat() {
  failure = null;
  cur = { id: "", title: "新对话", system: "", model: "", messages: [] };
  ui.title.textContent = cur.title;
  ui.err.textContent = "";
  paintMsgs();
  paintMode();
  paintList();
  ui.input.focus();
}

async function openChat(id) {
  failure = null;
  // A conversation with a picture still being made is opened from memory: the copy on the server lacks the request in flight.
  const live = [...jobs].find((j) => j.chat.id === id);
  if (live) cur = live.chat;
  else {
    const r = await srv("GET", "/api/chats/" + id);
    if (!r.ok) { ui.err.textContent = "打开不了这个对话"; return; }
    cur = await r.json();
  }
  ui.title.textContent = cur.title;
  ui.err.textContent = "";
  paintMsgs();
  paintMode();
  paintList();
}

// ---- messages ----

// ---- while an answer comes in ----
// The page is drawn once per frame, and it follows the answer only while the reader is at its end:
// once they scroll up it stays where they are, and a button brings them back to the end.
let liveFrame = 0, following = true;
let failure = null; // the last answer that did not come: its message and the retry, shown under the conversation
const atBottom = () => ui.log.scrollHeight - ui.log.scrollTop - ui.log.clientHeight < 80;
function paintLive(b, reply) {
  if (liveFrame) return;
  liveFrame = requestAnimationFrame(() => {
    liveFrame = 0;
    renderReply(b, reply, true);
    if (following) ui.log.scrollTop = ui.log.scrollHeight;
  });
}
function stopLive() { if (liveFrame) cancelAnimationFrame(liveFrame); liveFrame = 0; }
function paintJump() { if (ui.jump) ui.jump.hidden = following || !busy; }
function followNow() { following = true; ui.log.scrollTop = ui.log.scrollHeight; paintJump(); }
function flashBusy() { ui.err.textContent = "回答还没结束。点“停止”或按 Esc 可以先停下来。"; }
function paintCount() {
  const n = ui.input.value.length;
  ui.count.textContent = n >= 1500 ? n.toLocaleString("zh-CN") + " / " + MAX_INPUT.toLocaleString("zh-CN") : "";
  ui.count.classList.toggle("over", n > MAX_INPUT);
}
function failNode() {
  const f = failure;
  return h("div", { class: "msgrow assistant" }, h("div", { class: "bubble failed" },
    h("p", { class: "err", text: f.message }),
    h("button", { class: "btn", text: "重试", onclick: () => { failure = null; paintMsgs(); f.retry(); } }),
    ...(f.other ? [h("button", { class: "btn", text: f.other.label, onclick: () => { failure = null; paintMsgs(); f.other.run(); } })] : [])));
}

// ---- messages ----

function copyBtn(text) {
  return h("button", { class: "link", text: "复制", onclick: (e) => navigator.clipboard.writeText(text).then(() => { e.target.textContent = "已复制"; setTimeout(() => { e.target.textContent = "复制"; }, 1500); }, () => {}) });
}

// Editing a message of the person's: the answers after it are dropped and the new text is answered.
function editMessage(row, m) {
  if (busy) return flashBusy();
  if ([...jobs].some((j) => j.chat === cur)) { ui.err.textContent = "这个对话里还有图片或视频在做，等它做完再改。"; return; }
  const ta = h("textarea", { rows: "3", "aria-label": "修改这条消息" });
  ta.value = m.content;
  row.querySelector(".bubble").replaceChildren(ta, h("div", { class: "row edit" },
    h("button", { class: "btn", text: "取消", onclick: () => paintMsgs() }),
    h("button", { class: "btn primary", text: "保存并重新回答", onclick: () => resend(cur.messages.indexOf(m), ta.value.trim()) })));
  ta.focus();
}

// True when a picture or video was asked for and cannot be made now. The models are asked for once
// more first (a computer may have come back since the page loaded); only then is the person told.
async function declineMaking(um, text) {
  const ctx = cur.messages.length > 1;
  if (!unavailableKind(text, ctx)) return false;
  await loadModels().catch(() => null);
  if (!unavailableKind(text, ctx)) return false;
  const what = unavailableKind(text, ctx) === "video" ? "做视频" : "画图";
  failure = {
    message: "现在不能" + what + "：提供" + (what === "画图" ? "画图" : "视频") + "的电脑暂时不在线。过一会儿再试，或者让我用文字回答。",
    retry: () => submitAgain(um, text),
    other: { label: "用文字回答", run: () => { um.content = stripCommand(text) || text; return produce(um.content, "text", um); } },
  };
  paintMsgs();
  say(failure.message);
  return true;
}
async function submitAgain(um, text) {
  if (await declineMaking(um, text)) return;
  const kind = detectKind(text, cur.messages.length > 1);
  if (kind !== "text") um.content = stripCommand(text) || text;
  await produce(um.content, kind, um);
}

async function resend(idx, text) {
  if (busy) return flashBusy();
  if (idx < 0 || !text) return;
  cur.messages.splice(idx);
  const um = { role: "user", content: text, t: Date.now() };
  cur.messages.push(um);
  paintMsgs();
  if (await declineMaking(um, text)) return;
  const kind = detectKind(text, cur.messages.length > 1);
  if (kind !== "text") um.content = stripCommand(text) || text;
  await produce(um.content, kind, um);
}

// The conversation as a Markdown file: the words only; pictures and videos as their request.
function exportChat() {
  if (!cur || !cur.messages.length) return;
  const out = ["# " + cur.title, ""];
  for (const m of cur.messages) {
    const who = m.role === "user" ? "我" : m.model ? label(m.model) : "助手";
    const body = m.kind ? "（" + (m.kind === "image" ? "图片" : "视频") + "：" + m.content + "）" : m.content;
    out.push("## " + who, "", body, "");
  }
  const url = URL.createObjectURL(new Blob([out.join("\n")], { type: "text/markdown;charset=utf-8" }));
  const a = h("a", { href: url, download: cur.title.replace(/[\\/:*?"<>|\s]+/g, "_").slice(0, 60) + ".md" });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function msgNode(m, idx) {
  const row = h("div", { class: "msgrow " + m.role });
  const b = h("div", { class: "bubble" });
  if (m.role === "assistant" && (m.kind === "image" || m.kind === "video")) {
    b.append(h("p", { class: "wait", text: "正在取回…" }));
    if (m.media) mediaURL(m.media).then((u) => {
      b.replaceChildren(u ? (m.kind === "image" ? h("img", { src: u, alt: m.content.slice(0, 80) }) : h("video", { src: u, controls: true, loop: true, playsinline: true })) : h("p", { class: "wait", text: "这个文件已经过期，没有保存了。" }));
    });
  } else if (m.role === "assistant") renderReply(b, m, false);
  else b.textContent = m.content;
  row.append(b);
  if (m.role === "user") row.append(h("div", { class: "meta" }, copyBtn(m.content), h("button", { class: "link", text: "编辑", onclick: () => editMessage(row, m) })));
  if (m.role === "assistant") {
    const meta = h("div", { class: "meta" });
    if (m.model) meta.append(h("span", { text: label(m.model) }));
    if (m.alts && m.alts.length > 1 && idx >= 0) {
      meta.append(h("span", { class: "versions" },
        h("button", { class: "link", text: "‹", "aria-label": "上一个回答", disabled: m.ai === 0, onclick: () => pickVersion(idx, m.ai - 1) }),
        h("span", { text: (m.ai + 1) + " / " + m.alts.length }),
        h("button", { class: "link", text: "›", "aria-label": "下一个回答", disabled: m.ai === m.alts.length - 1, onclick: () => pickVersion(idx, m.ai + 1) })));
    }
    if (m.took) meta.append(h("span", { text: m.took + " 秒" }));
    if (m.stopped) meta.append(h("span", { text: "已停止" }));
    if (!m.kind) meta.append(h("button", { class: "link", text: "复制", onclick: (e) => navigator.clipboard.writeText(m.content).then(() => { e.target.textContent = "已复制"; setTimeout(() => { e.target.textContent = "复制"; }, 1500); }, () => {}) }));
    if (idx === cur.messages.length - 1) {
      meta.append(h("button", { class: "link", text: "重新生成", onclick: () => { if (!busy) regenerate(); } }));
      if (m.kind) meta.append(h("button", { class: "link", text: "改成文字回答", onclick: () => redoAs("text") }));
      else {
        if (modelsOf("image").length) meta.append(h("button", { class: "link", text: "改成画图", onclick: () => redoAs("image") }));
        if (modelsOf("video").length) meta.append(h("button", { class: "link", text: "改成视频", onclick: () => redoAs("video") }));
      }
    }
    if (m.kind && m.media) meta.append(h("button", { class: "link", text: "保存", onclick: async () => { const u = await mediaURL(m.media); if (u) { const a = h("a", { href: u, download: "beenet-" + m.kind + (m.kind === "image" ? ".png" : ".mp4") }); document.body.append(a); a.click(); a.remove(); } } }));
    row.append(meta);
  }
  return row;
}

function paintMsgs() {
  if (!cur.messages.length) {
    ui.log.replaceChildren(h("div", { class: "empty" }, h("h2", { text: "想做点什么？" }),
      h("p", { text: "聊天、写代码、画图、做视频，都在这一个输入框里，说出来就行。" }),
      h("div", { class: "tips" }, ...["用三句话解释什么是分布式计算", "帮我写一个 Go 的并发下载器", "画一只雪地里的红狐，清晨的光线", "做一段红狐在雪地里奔跑的视频"].filter((t) => detectKind(t) === "text" || modelsOf(detectKind(t)).length).map((t) => h("button", { class: "btn", text: t, onclick: () => { ui.input.value = t; ui.input.focus(); } })))));
    return;
  }
  // A picture or video still being made keeps its place at the end of its conversation.
  const making = [...jobs].filter((j) => j.chat === cur).map((j) => j.node);
  ui.log.replaceChildren(h("div", { class: "inner" }, ...cur.messages.map(msgNode), ...making, ...(failure ? [failNode()] : [])));
  ui.log.scrollTop = ui.log.scrollHeight;
}

function addNode(m) {
  let inner = $(".inner", ui.log);
  if (!inner) { ui.log.replaceChildren(h("div", { class: "inner" })); inner = $(".inner", ui.log); }
  const n = msgNode(m, -1);
  inner.append(n);
  n.scrollIntoView({ block: "nearest" });
  return n;
}

// Save the conversation (when saving is on) and refresh the sidebar.
// Saves are queued one after another: a picture finishing while an answer is
// being saved must not create the same conversation twice.
let saving = Promise.resolve();
function persist(c = cur) {
  saving = saving.then(() => save(c)).catch(() => {});
  return saving;
}
async function save(c) {
  if (!keep || !c.messages.length) return;
  const r = await srv(c.id ? "PUT" : "POST", c.id ? "/api/chats/" + c.id : "/api/chats", c).catch(() => null);
  if (r && r.ok) {
    const saved = await r.json();
    c.id = saved.id;
    const i = chats.findIndex((c) => c.id === saved.id);
    const sm = { id: saved.id, title: saved.title, pinned: saved.pinned, updated: saved.updated };
    if (i >= 0) chats[i] = sm; else chats.unshift(sm);
    chats.sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || b.updated - a.updated);
  } else if (r && r.status === 413 && c === cur) ui.err.textContent = "这个对话太大了，没有保存。可以新开一个对话。";
  paintList();
}

async function refreshBalance() {
  // In anonymous mode no call with the account's key follows an anonymous request:
  // it would tie the two together by time and address.
  if (anon && wallet) return;
  const r = await gw("GET", "/v1/account").catch(() => null);
  if (r && r.ok) { balance = (await r.json()).available; ui.bal.textContent = balance != null ? fmt(balance) : ""; }
}

function setBusy(ctl) {
  busy = ctl;
  ui.send.textContent = ctl ? "停止" : "发送";
  ui.send.title = ctl ? "停止回答（Esc）" : "";
  paintJump();
  ui.sel.disabled = !!ctl;
  ui.thinkBtn.disabled = !!ctl;
  ui.secretBtn.disabled = !!ctl;
  ui.anonBtn.disabled = !!ctl;

}

async function submit() {
  const text = ui.input.value.trim();
  if (!text || !models.length) return;
  if (text.length > MAX_INPUT) { ui.err.textContent = "这段内容有 " + text.length.toLocaleString("zh-CN") + " 字，超过了 " + MAX_INPUT.toLocaleString("zh-CN") + " 字。可以分成几段发。"; return; }
  ui.err.textContent = "";
  following = true;
  ui.input.value = ""; ui.input.style.height = "auto"; paintCount();
  if ($(".empty", ui.log)) ui.log.replaceChildren();
  const um = { role: "user", content: text, t: Date.now() };
  cur.messages.push(um);
  if (cur.title === "新对话") { cur.title = text.replace(/\s+/g, " ").slice(0, 28); ui.title.textContent = cur.title; }
  addNode(um);
  if (await declineMaking(um, text)) return;
  const kind = detectKind(text, cur.messages.length > 1); // the message itself is already in the list
  if (kind !== "text") um.content = stripCommand(text) || text;
  await produce(um.content, kind, um);
}

// Answers to the same question: each text answer keeps the ones before it in `alts`, and `ai`
// is the one shown. Older conversations have no `alts`: they show their single answer.
const VERSION_KEYS = ["content", "thinking", "sources", "model", "took", "stopped", "secret"];
function snap(m) {
  const o = { role: "assistant" };
  for (const k of VERSION_KEYS) if (m[k] !== undefined) o[k] = m[k];
  return o;
}
function withVersions(reply, prior) {
  if (!prior) return reply;
  const alts = (prior.old.alts || [snap(prior.old)]).concat([snap(reply)]);
  return Object.assign(reply, { alts, ai: alts.length - 1 });
}
// a regenerated answer that did not come leaves the one before it in place
function restore(chat, prior) { if (prior) chat.messages.push(prior.old); }
function pickVersion(idx, i) {
  const m = cur.messages[idx];
  if (busy || !m || !m.alts || i < 0 || i >= m.alts.length) return;
  cur.messages[idx] = Object.assign({ role: "assistant" }, m.alts[i], { alts: m.alts, ai: i });
  paintMsgs();
  persist();
}

async function regenerate() {
  const last = cur.messages[cur.messages.length - 1];
  if (!last || last.role !== "assistant") return;
  cur.messages.pop();
  const um = cur.messages[cur.messages.length - 1];
  paintMsgs();
  if (um) await produce(um.content, last.kind || "text", um, last.kind ? null : { old: last });
}

// The same request again, as a different kind of answer.
async function redoAs(kind) {
  if (busy) return;
  const last = cur.messages[cur.messages.length - 1];
  if (!last || last.role !== "assistant") return;
  cur.messages.pop();
  const um = cur.messages[cur.messages.length - 1];
  paintMsgs();
  if (um) await produce(um.content, kind, um);
}

// The progress shown while a picture or a video is made. The gateway reports a
// video job only as waiting, running or done, so the bar is an estimate from how
// long this kind took before (kept in this browser), easing toward 95% and
// reaching 100% when the result arrives; the page says it is an estimate.
const USUAL = { image: 25, video: 240 };
function usual(kind) { const v = Number(load("beenet-chat-usual-" + kind)); return v > 3 ? v : USUAL[kind]; }
function startProgress(b, kind, onCancel) {
  const T = usual(kind), t0 = Date.now();
  const bar = h("progress", { max: "100", value: "0", "aria-label": kind === "video" ? "视频生成进度" : "图片生成进度" });
  const what = h("div", { class: "gen-what", text: kind === "video" ? "排队中" : "正在画" });
  const note = h("div", { class: "gen-note" });
  const frame = h("div", { class: "gen " + kind, role: "status" }, h("div", { class: "gen-body" }, what, note, h("button", { class: "link", type: "button", text: "取消", onclick: onCancel })), bar);
  b.replaceChildren(frame);
  const tick = () => {
    const s = (Date.now() - t0) / 1000;
    const p = Math.min(95, 95 * (1 - Math.exp(-1.6 * s / T)));
    bar.value = p;
    note.textContent = "已用 " + Math.round(s) + " 秒，通常约 " + Math.round(T) + " 秒" + (s > T * 1.6 ? "，这次比平时久，还在生成" : "");
  };
  tick();
  const timer = setInterval(tick, 500);
  return {
    stage(status) { what.textContent = status === "in_progress" ? "正在生成" : status === "queued" ? "排队中，前面有任务要先做完" : "正在取回"; },
    stop(ok) {
      clearInterval(timer);
      if (ok) { bar.value = 100; const secs = (Date.now() - t0) / 1000; store("beenet-chat-usual-" + kind, String(Math.round(0.6 * T + 0.4 * secs))); }
    },
  };
}

async function produce(prompt, mode, um, prior) {
  if (secret && e2eCfg.quorum >= 1 && mode !== "text") {
    ui.err.textContent = "机密模式下只能文字对话：图片和视频还不能端到端加密。关掉“机密”再试。";
    return;
  }
  if (mode !== "text") return produceMedia(prompt, mode, um);
  failure = null;
  const model = ui.sel.value, ctl = new AbortController();
  setBusy(ctl);
  const reply = { role: "assistant", content: "", model, t: Date.now() };
  const node = addNode({ role: "assistant", content: "", kind: mode });
  const b = $(".bubble", node);
  b.replaceChildren(h("p", { class: "wait", text: "正在回答…" }));
  const chat = cur;
  try {
    await makeText(model, reply, b, ctl);
    if (reply.content) { chat.messages.push(withVersions(reply, prior)); say("回答完成"); }
    else { node.remove(); restore(chat, prior); }
  } catch (e) {
    say(e.name === "AbortError" ? "已停止" : friendly(e));
    if (reply.content) {
      if (e.name === "AbortError") reply.stopped = true; else ui.err.textContent = friendly(e);
      chat.messages.push(withVersions(reply, prior));
    } else {
      node.remove();
      restore(chat, prior);
      if (e.name !== "AbortError") failure = { message: friendly(e), retry: () => { if (prior && cur.messages[cur.messages.length - 1] === prior.old) cur.messages.pop(); return produce(um.content, mode, um, prior); } };
    }
  } finally {
    stopLive();
    setBusy(null);
    paintMsgs();
    await persist(chat);
    refreshBalance();
  }
}

// A picture or a video is made on the side: the box stays free for more questions
// meanwhile, and the result lands right under the request it answers.
// The conversation before message `upTo`, as lines a model can read. Pictures and
// videos made earlier appear as what they were made from, so "把猫换成黑色的" has
// something to refer to.
function talkBefore(chat, upTo, limit) {
  const at = chat.messages.indexOf(upTo);
  const prior = (at >= 0 ? chat.messages.slice(0, at) : chat.messages).filter((m) => m.content).slice(-(limit || 10));
  return prior.map((m) => {
    if (m.role === "user") return "用户：" + m.content.slice(0, 600);
    if (m.kind === "image" || m.kind === "video") return "助手：（画了一" + (m.kind === "image" ? "张图" : "段视频") + "，提示词：" + (m.usedPrompt || m.content).slice(0, 600) + "）";
    return "助手：" + m.content.slice(0, 600);
  });
}

const COMPOSE = {
  image: "你是绘图提示词助手，不回答问题。根据下面的对话和用户最后的要求，写一条可以直接交给绘图模型的完整提示词：把对话里已经讨论、确定的画面内容（主体、数量、姿态、场景）、风格、色彩、构图、光线都写进去，让它不看对话也能看懂；用户最后一句里的修改（比如“改成夜晚”“换成黑色的”）要落实在提示词里，之前画过的图也可以作为基础；对话里没有说的不要编造。只输出提示词本身，一段话，不要解释，不要加引号，不超过 300 字。",
  video: "你是视频提示词助手，不回答问题。根据下面的对话和用户最后的要求，写一条可以直接交给视频模型的完整提示词：画面主体、动作、场景、镜头、风格、光线，让它不看对话也能看懂；用户最后一句里的修改要落实；对话里没有说的不要编造。只输出提示词本身，一段话，不要解释，不要加引号，不超过 300 字。",
};

// composePrompt returns the prompt to give the maker. With no earlier conversation, or if
// the helper model does not answer in time, it is the person's own words.
async function composePrompt(kind, prompt, chat, um, signal) {
  const talk = talkBefore(chat, um);
  if (!talk.length) return prompt;
  const text = modelsOf("text");
  const m = text.find((x) => x.id === "chat-default") || text.find((x) => x.id !== "chat-strong" && x.id !== "auto") || text[0];
  if (!m) return prompt;
  const ctl = new AbortController(), stop = () => ctl.abort();
  signal.addEventListener("abort", stop);
  const t = setTimeout(stop, 25000);
  try {
    const r = await gw("POST", "/v1/chat/completions", { model: m.id, stream: false, max_tokens: 500, temperature: 0.3, chat_template_kwargs: { enable_thinking: false },
      messages: [{ role: "system", content: COMPOSE[kind] || COMPOSE.image }, { role: "user", content: "对话：\n" + talk.join("\n") + "\n\n用户最后的要求：" + prompt }] }, { signal: ctl.signal });
    if (!r.ok) return prompt;
    const out = (((await r.json()).choices || [{}])[0].message || {}).content || "";
    const line = out.replace(/<think>[\s\S]*?<\/think>/g, "").trim().replace(/^[\s"“'「]+|[\s"”'」]+$/g, "").slice(0, 600);
    return line.length >= 4 ? line : prompt;
  } catch (e) {
    if (signal.aborted) throw e;
    return prompt;
  } finally { clearTimeout(t); signal.removeEventListener("abort", stop); }
}

async function produceMedia(prompt, mode, um) {
  const chat = cur, model = makerModel(mode), ctl = new AbortController();
  const reply = { role: "assistant", content: "", model, t: Date.now() };
  const node = addNode({ role: "assistant", content: "", kind: mode });
  const job = { chat, ctl, node };
  jobs.add(job);
  const prog = startProgress($(".bubble", node), mode, () => ctl.abort());
  try {
    // What the person wants drawn is often only clear from the conversation ("画出来",
    // "改成夜晚"): a text model turns the conversation and the request into one
    // complete prompt, and that is what the picture or video model gets.
    const used = await composePrompt(mode, prompt, chat, um, ctl.signal);
    if (mode === "image") await makeImage(model, used, reply, ctl);
    else await makeVideo(model, used, reply, ctl, prog);
    if (reply.media) { reply.content = prompt; if (used !== prompt) reply.usedPrompt = used; }
  } catch (e) {
    if (e.name !== "AbortError" && cur === chat) ui.err.textContent = friendly(e);
  }
  prog.stop(!!reply.media);
  jobs.delete(job);
  if (!reply.media) { node.remove(); return; }
  const at = chat.messages.indexOf(um);
  chat.messages.splice(at >= 0 ? at + 1 : chat.messages.length, 0, reply);
  if (cur === chat) { if (busy) node.replaceWith(msgNode(reply, -1)); else paintMsgs(); }
  await persist(chat);
  refreshBalance();
}

// Whether a question needs the web is decided per message, not by a switch: a small
// model reads the last turns and either answers NO or writes the search words (it also
// turns "那明天呢" into a search that makes sense alone). If it cannot be asked in time,
// the words of the question decide (NEEDS_WEB) and the question itself is searched.
const ROUTER = "你是搜索判断器，不回答问题。根据对话判断：要回答最后一个问题，是否必须上网查最新的或具体的事实（新闻、天气、价格行情、赛事比分、近期发生的事、现任人物、新发布的产品或版本、当前的数据等）。常识、写作、翻译、代码、数学、闲聊、对话里已有答案的，都不需要。需要时只输出一行搜索关键词（6 个词以内，不要标点、不要解释；中国国内的事用中文关键词，其他一律用英文关键词）；不需要时只输出 NO。";
async function webQuery(msgs, today, signal) {
  const last = (msgs[msgs.length - 1] || {}).content || "";
  if (last.trim().length < 4 || last.includes("```")) return "";
  const text = modelsOf("text");
  const m = text.find((x) => x.id === "chat-default") || text.find((x) => x.id !== "chat-strong" && x.id !== "auto") || text[0];
  const guess = () => (needsWeb(last) ? last.replace(/\s+/g, " ").slice(0, 100) : "");
  if (!m) return guess();
  const ctl = new AbortController(), stop = () => ctl.abort();
  signal.addEventListener("abort", stop);
  const t = setTimeout(stop, 6000);
  try {
    const talk = msgs.slice(-5).map((x) => (x.role === "user" ? "用户：" : "助手：") + x.content.slice(0, 300)).join("\n");
    const r = await gw("POST", "/v1/chat/completions", { model: m.id, stream: false, max_tokens: 40, temperature: 0, chat_template_kwargs: { enable_thinking: false },
      messages: [{ role: "system", content: ROUTER + "\n" + today }, { role: "user", content: "对话：\n" + talk + "\n\n最后一个问题：" + last }] }, { signal: ctl.signal });
    if (!r.ok) return guess();
    const out = (((await r.json()).choices || [{}])[0].message || {}).content || "";
    const line = out.replace(/<think>[\s\S]*?<\/think>/g, "").trim().split("\n")[0].replace(/^[\s"“'「]+|[\s"”'」]+$/g, "");
    if (!line) return guess();
    return /^no\b/i.test(line) ? "" : line.slice(0, 100);
  } catch (e) {
    if (signal.aborted) throw e;
    return guess();
  } finally { clearTimeout(t); signal.removeEventListener("abort", stop); }
}

// The fallback: the words of the question alone (code, rewriting and general knowledge stay off the web).
const NEEDS_WEB = /(今晚|最新|最近|近期|本周|这周|本月|这个月|今年|刚刚|实时|新闻|头条|热搜|天气|气温|下雨|股价|股票|汇率|油价|金价|价格|多少钱|比分|赛程|票房|排行|榜单|发布了|上线了|现任|\b20(2[5-9]|3\d)\b|\b(latest|today|tonight|yesterday|tomorrow|news|current|currently|recent|recently|price|weather|score|stock|trending)\b)/i;
const NOT_WEB = /(代码|函数|脚本|翻译|润色|改写|改成|总结下面|解释这段|写一(个|段|篇|首)|\bcode\b|\btranslate\b)/i;
function needsWeb(text) {
  const t = text.trim();
  return t.length >= 4 && !t.includes("```") && NEEDS_WEB.test(t) && !NOT_WEB.test(t);
}

async function search(q, signal) {
  try {
    // In the client the page holds no key: the client asks the online service with its own
    // key (the same service, the same answers). Online, the page asks it directly.
    const r = embedded
      ? await fetch("/api/chat/search?q=" + encodeURIComponent(q), { headers: { "X-Fabric": "1" }, signal })
      : await srv("GET", "/api/search?q=" + encodeURIComponent(q), null, undefined);
    if (!r.ok) return [];
    return ((await r.json()).results || []).filter((x) => x.title && /^https?:\/\//.test(x.url));
  } catch (_) { return []; }
}

// ---- secret mode: end-to-end encrypted chat (e2e.js) ----
// Find a node that holds a current confidential token for this model, fetch that
// token, check it against the verifiers THIS browser trusts, encrypt the request to
// the key the token commits to, send it through the gateway (which sees ciphertext
// and routes by the token), and decrypt the answer as it arrives. Returns what
// makeText reads: { ok, body } with the answer's plaintext as a byte stream.
// ---- bearer tokens (mint.js) ----
setInterval(() => { try { paintWallet(); } catch (_) { /* before the page is built */ } }, 30000);
function paintWallet() {
  if (!ui || !ui.walletNote) return;
  if (!anon || !wallet) { ui.walletNote.textContent = ""; return; }
  const p = wallet.pending();
  ui.walletNote.textContent = "匿名额度 " + wallet.balance() + (p.amount ? "（另有 " + p.amount + " 将在 " + Math.max(1, Math.ceil((p.at - Date.now()) / 60000)) + " 分钟后生效）" : "");
}

// topUp withdraws anonymous credit from the signed-in account. This is the one
// step that knows who the person is; what comes back it could not read.
async function topUp() {
  try { await checkMintLog(); } catch (e) { ui.err.textContent = e.message; anon = false; store("beenet-chat-anon", "off"); ui.anonBtn.setAttribute("aria-pressed", "false"); return; }
  const units = 20000, credits = units * mintInfo.unit_credits;
  if (!confirm("从账户取出 " + credits + " 个额度，换成匿名额度（只存在这个浏览器里，请备份）？")) { anon = false; store("beenet-chat-anon", "off"); ui.anonBtn.setAttribute("aria-pressed", "false"); return; }
  try {
    // Spending soon after withdrawing lets the time of one be matched with the other, so
    // by default the credit becomes usable after a random wait.
    const immediate = confirm("要立刻能用吗？\n立刻用最方便，但取币和花币的时间容易被对上；点“取消”则错开 10 到 60 分钟后再生效（更不容易被对上）。");
    await wallet.withdraw(units, async (body) => {
      const r = await net("POST", "/v1/mint/withdraw", { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), auth: true });
      if (!r.ok) throw new Error(await errText(r));
      return r.json();
    }, { immediate });
  } catch (e) { ui.err.textContent = "取匿名额度失败：" + e.message; anon = false; ui.anonBtn.setAttribute("aria-pressed", "false"); }
  paintWallet();
}

// payAnon: the envelope is sealed first (its size is part of the price), then
// the gateway says what it costs, then exactly that is paid in tokens.
async function e2ePost(model, path, envelope, ref, signal) {
  const text = JSON.stringify(envelope);
  const hdr = { "Content-Type": "application/json", "X-BeeNet-Model": model, "X-BeeNet-Path": path, "X-Attestation-Ref": ref };
  if (!anon || !wallet) return net("POST", "/v1/e2e", { signal, headers: hdr, body: text, auth: true });
  await checkMintLog();
  const bytes = new TextEncoder().encode(text).length;
  const pr = await net("GET", "/v1/mint/price?model=" + encodeURIComponent(model) + "&bytes=" + bytes + "&max=" + answerCap, { signal });
  if (!pr.ok) throw new Error(await errText(pr));
  const price = (await pr.json()).units;
  let toks = wallet.take(price, false) || wallet.take(price, true);
  if (!toks) {
    const p = wallet.pending();
    if (p.amount && wallet.balance() + p.amount >= price) throw new Error("匿名额度还没生效（约 " + Math.max(1, Math.ceil((p.at - Date.now()) / 60000)) + " 分钟后）。可以先关掉“匿名付费”用账户付，或等一等。");
    if (wallet.balance() >= price) throw new Error("匿名额度的面额不够凑出这次的价格，请再取一些。");
    throw new Error("匿名额度不够（这次要 " + price + "），点“匿名付费”再取一些。");
  }
  paintWallet();
  hdr["X-BeeNet-Tokens"] = btoa(JSON.stringify(BeeMint.Wallet.wire(toks)));
  hdr["X-BeeNet-Max-Tokens"] = String(answerCap);
  let r;
  try { r = await net("POST", "/v1/e2e", { signal, headers: hdr, body: text }); }
  catch (e) { wallet.giveBack(toks); paintWallet(); throw e; }
  if (!r.ok) {
    // not served: the gateway released the tokens, unless they were bad (spent or forged), which are dropped
    const bad = r.status === 402 && (await r.clone().text().catch(() => "")).includes("invalid_tokens");
    if (!bad) wallet.giveBack(toks);
    paintWallet();
  }
  return r;
}

// ---- the transparency log (tlog.js) ----
// When a log is configured, secret mode does not rely on the platform's word for
// which software images, verifiers, mint keys and relay key are the real ones: it
// checks them against the public log, which a few independent witnesses watch.
// Fails closed: if the log cannot be checked, secret mode is not used.
async function checkLog() {
  if (!tlogCfg) return null;
  if (tlogState && Date.now() - tlogAt < 300000) return tlogState;
  let prev = null;
  try { prev = JSON.parse(load("beenet-chat-tlog") || "null"); } catch (_) { prev = null; }
  let r;
  try { r = await BeeTLog.check((p) => fetch(tlogCfg.url.replace(/\/$/, "") + p), tlogCfg, prev); }
  catch (e) { throw new Error("公开日志核对失败，不使用机密模式：" + e.message); }
  store("beenet-chat-tlog", JSON.stringify({ size: r.checkpoint.size, root: r.checkpoint.root }));
  tlogState = r.state; tlogAt = Date.now();
  // the verifiers this browser was configured with must be the ones the log names
  for (const [id, k] of Object.entries(e2eCfg.verifiers)) {
    if (tlogState.verifiers[id] !== k) throw new Error("公开日志核对失败：验证器 " + id + " 的公钥和日志里的不一致，不使用机密模式。");
  }
  // relays the log lists join the pool (their operators are as the log says)
  if (relay) {
    relay.gatewayOperator = tlogState.gatewayOperator || "";
    for (const [u, op] of Object.entries(tlogState.relays)) {
      relay.ops[u] = op;
      if (!relay.urls.includes(u)) relay.urls.push(u);
    }
  }
  // and so must the relay's gateway key
  if (relay && tlogState.ohttpKeys.length) {
    const have = Array.from(atob(tlogCfg.ohttpKeysB64 || relay.keysB64 || ""), (c) => c.charCodeAt(0).toString(16).padStart(2, "0")).join("");
    if (have && have !== tlogState.ohttpKeys[tlogState.ohttpKeys.length - 1]) throw new Error("公开日志核对失败：中继用的网关公钥和日志里的不一致，不使用机密模式。");
  }
  return tlogState;
}

// The mint's keys must be the ones the log recorded for their epoch (a mint that
// showed one person other keys could tell their tokens apart).
async function checkMintLog() {
  if (!tlogCfg || !mintInfo) return;
  const st = await checkLog();
  const want = st.mintKeys[mintInfo.keys.epoch];
  if (!want) throw new Error("公开日志里没有这一期的铸币公钥，不使用匿名付费。");
  if ((await BeeTLog.keySetHash(mintInfo.keys)) !== want) throw new Error("铸币公钥和公开日志里记的不一致，不使用匿名付费。");
}

async function e2eToken(model, avoid) {
  const get = (path) => net("GET", path, { auth: !(anon && wallet) }); // no account on anonymous calls
  const nodes = await (await get("/v1/e2e/nodes?model=" + encodeURIComponent(model))).json().catch(() => ({ refs: [] }));
  const refs = (nodes.refs || []).filter((x) => x !== avoid);
  if (!refs.length) throw new Error("现在没有可用的机密节点（" + model + "）。可以关掉“机密”用普通模式，或稍后再试。");
  let lastErr = "";
  for (const ref of refs.sort(() => Math.random() - 0.5)) {
    const cached = e2eTokens.get(ref);
    if (cached && Date.parse(cached.claims.expires) - Date.now() > 60000) {
      // a token checked once is checked again against the log: an image revoked since is no longer trusted
      const st = await checkLog();
      if (!st || cached.claims.measurement in st.allowed) return { ref, ...cached };
      e2eTokens.delete(ref);
      lastErr = "这个节点运行的软件镜像不在公开日志的允许名单里";
      continue;
    }
    try {
      const r = await get("/v1/attest/token/" + encodeURIComponent(ref));
      if (!r.ok) { lastErr = "取不到节点的证明"; continue; }
      const got = await r.json();
      const claims = await BeeE2E.verifyToken(got.token, e2eCfg.verifiers, e2eCfg.quorum, Date.now());
      if (got.revoked) { lastErr = "这个节点的证明已被吊销"; continue; }
      const st = await checkLog();
      if (st && !(claims.measurement in st.allowed)) { lastErr = "这个节点运行的软件镜像不在公开日志的允许名单里"; continue; }
      e2eTokens.set(ref, { tok: got.token, claims });
      return { ref, tok: got.token, claims };
    } catch (e) { if (String(e.message).startsWith("公开日志核对失败")) throw e; lastErr = e.message; } // a token that does not check out is not used; try the next node
  }
  throw new Error("没有通过验证的机密节点：" + lastErr);
}

async function e2eChat(model, body, signal, reply, retried) {
  const { ref, tok, claims } = await e2eToken(model, retried);
  const path = "/v1/chat/completions";
  const { envelope, opener } = await BeeE2E.sealRequest(tok.e2e_pub, ref, model, path, JSON.stringify(body));
  const r = await e2ePost(model, path, envelope, ref, signal);
  if (r.status === 409 && !retried) { e2eTokens.delete(ref); return e2eChat(model, body, signal, reply, ref); } // the node renewed its token: use the new one
  if (!r.ok) return r;
  reply.secret = { node: String(claims.node_id).slice(0, 8), anon: !!(anon && wallet), hidden: relayHides(), logged: !!tlogState };
  const rd = r.body.getReader();
  const stream = new ReadableStream({
    async pull(ctrl) {
      for (;;) {
        const { done, value } = await rd.read();
        if (done) { opener.end(); ctrl.close(); return; }
        const frames = await opener.push(value);
        const out = frames.filter((f) => f.chunk.length).map((f) => f.chunk);
        if (out.length) { out.forEach((c) => ctrl.enqueue(c)); return; }
        if (opener.done) { ctrl.close(); return; }
      }
    },
    cancel() { rd.cancel(); },
  });
  return { ok: true, body: stream };
}

// The chat model is told what this window can do. Without it, a model asked about a
// picture suggests prompts for other companies' drawing apps. Drawing prompts are for
// our own drawing model and are written behind the scenes (composePrompt); a person
// is never asked to read, copy or paste one.
// Code the way the well-known chat apps answer it: a line on the approach, the code in a
// block with its language, then how to run it. The window shows the block with copy,
// download and syntax colours, so the model does not need to describe those.
const CODE_NOTE = "写代码时：先用一两句话说思路；代码放在带语言标记的代码块里（如 ```python），要完整、能直接运行，不要用省略号或“其余部分同上”代替；多个文件分别用各自的代码块，并在块前一行写清文件名；代码之后简短说明怎么运行或用法、需要注意的地方。改已有代码时说明改了哪里，并给出完整的新代码或能直接替换的完整片段。";
function makerNote() {
  const img = modelsOf("image").length, vid = modelsOf("video").length;
  if (!img && !vid) return "";
  return "这个聊天窗口本身就能" + (img ? "画图" : "") + (img && vid ? "和" : "") + (vid ? "做视频" : "") + "：用户说“画一张……”“把它画出来”" + (vid ? "“做成视频”" : "") + "，系统就会在这里直接画出来，不用去别的应用。所以：" +
    "不要推荐 Midjourney、DALL·E、Stable Diffusion、即梦、文心一格、可灵等其他绘图或视频应用和网站；" +
    "不要写给人看的绘图提示词，也不要说“把下面的提示词粘贴到……”，绘图用的提示词由系统自己生成；" +
    "和用户讨论画面时，用自然的话说想法和可选方向，需要时告诉用户直接说“画出来”就能在这里画，想改就直接说怎么改。" +
    (vid ? "视频同样：用户想要动起来的画面，就告诉他直接说“做成视频”或“做一段……的视频”，这里会直接生成，不要说做不了视频。" : "") +
    "如果用户要的是简单的图形、图标、示意图，也可以直接输出完整的 SVG（放在 ```svg 代码块里），窗口会把它显示成图；不要叫用户另存为文件或粘贴到别处去看。";
}

async function makeText(model, reply, b, ctl) {
  const t0 = Date.now();
  // A picture or video made earlier is told to the model as what it was made from, so the talk can go on about it.
  const msgs = cur.messages.filter((m) => m.content).slice(-30).map((m) => ({ role: m.role, content: m.kind ? "（内部记录，不要向用户复述：这里已经画出了一" + (m.kind === "image" ? "张图" : "段视频") + "，画面内容是：" + (m.usedPrompt || m.content) + "。可以接着聊它，用自然的话，不要贴出这段描述。）" : m.content }));
  // A model does not know the date, and what happened after its training. The date
  // always goes in; with the web switch on, a search runs first and its pages go in too.
  const sys = [cur.system, "今天是" + new Date().toLocaleString("zh-CN", { dateStyle: "full", timeStyle: "short", hour12: false }) + "（用户所在时区）。", makerNote(), CODE_NOTE];
  const ask = (msgs[msgs.length - 1] || {}).content || "";
  const useSecret = secret && e2eCfg.quorum >= 1;
  // In secret mode nothing leaves in clear: no search (its words would go to a
  // search engine) and no helper model deciding whether to search.
  const q = useSecret ? "" : await webQuery(msgs, sys[sys.length - 1], ctl.signal);
  if (q) {
    b.replaceChildren(h("p", { class: "wait", text: "正在上网搜索…" }));
    const found = await search(q, ctl.signal);
    if (found.length) {
      reply.sources = found.map((x) => ({ title: x.title.slice(0, 80), url: x.url }));
      sys.push("下面是刚刚上网搜到的网页，可能不完整，只在和问题相关时使用；用到时在句末标上编号，如 [1]；如果这些网页和问题明显无关，或没有你要的信息，就直说没有查到，不要根据它们编造。\n" +
        found.map((x, i) => "[" + (i + 1) + "] " + x.title + "\n" + x.snippet + "\n" + x.url).join("\n\n"));
    } else ui.err.textContent = "这个问题需要最新信息，但这次没有搜到可用的网页，按已有知识回答。";
    b.replaceChildren(h("p", { class: "wait", text: "正在回答…" }));
  }
  msgs.unshift({ role: "system", content: sys.filter(Boolean).join("\n\n") });
  // Thinking is the person's switch (off by default: pages of reasoning before the
  // answer look like a hang). Engines that do not know the setting ignore it.
  const body = { model, stream: true, messages: msgs, chat_template_kwargs: { enable_thinking: think } };
  if (useSecret && anon && wallet) body.max_tokens = answerCap; // what was paid for
  const r = useSecret ? await e2eChat(model, body, ctl.signal, reply) : await gw("POST", "/v1/chat/completions", body, { signal: ctl.signal });
  if (!r.ok) throw new Error(await errText(r));
  const rd = r.body.getReader(), dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await rd.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") continue;
      try {
        const d = JSON.parse(data).choices[0].delta;
        if (d && (d.content || d.reasoning_content)) {
          if (d.reasoning_content) reply.thinking = (reply.thinking || "") + d.reasoning_content;
          if (d.content) reply.content += d.content;
          paintLive(b, reply);
        }
      } catch (_) { /* a partial line */ }
    }
  }
  if (!reply.content) throw new Error("没有收到回答");
  cur.model = model;
  reply.took = Math.round((Date.now() - t0) / 100) / 10;
}

// A made picture or video goes to the account's media store (when saving is on)
// and is shown from there; with saving off it is shown from memory only.
async function keepMedia(blob, mime, reply, kind, prompt) {
  reply.kind = kind;
  reply.content = prompt;
  if (keep) {
    const r = await srv("POST", "/api/media", blob, mime).catch(() => null);
    if (r && r.ok) { reply.media = (await r.json()).id; blobs.set(reply.media, URL.createObjectURL(blob)); return; }
    ui.err.textContent = "已生成，但没有保存成功。请现在保存到本地。";
  }
  reply.media = "tmp" + Math.random().toString(36).slice(2, 12).padEnd(10, "0");
  blobs.set(reply.media, URL.createObjectURL(blob));
}

async function makeImage(model, prompt, reply, ctl) {
  const side = tenant.startsWith("try-") ? 768 : 1024;
  // A picture is one long request; give up after 10 minutes with a plain message
  // instead of leaving the bar running for ever.
  const cut = setTimeout(() => ctl.abort("slow"), 600000);
  let r;
  try {
    r = await gw("POST", "/v1/images/generations", { model, prompt, size: side + "x" + side, n: 1 }, { signal: ctl.signal });
  } catch (e) {
    if (ctl.signal.reason === "slow") throw new Error("画图用了超过 10 分钟，已经停下。可以再试一次，或到设置里换一个画图模型。");
    throw e;
  } finally { clearTimeout(cut); }
  if (!r.ok) throw new Error(await errText(r));
  const b64 = ((await r.json()).data || [{}])[0].b64_json;
  if (!b64) throw new Error("没有收到图片");
  const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  await keepMedia(new Blob([bin], { type: "image/png" }), "image/png", reply, "image", prompt);
}

async function makeVideo(model, prompt, reply, ctl, prog) {
  let r = await gw("POST", "/v1/videos", { model, prompt }, { signal: ctl.signal });
  if (!r.ok) throw new Error(await errText(r));
  let job = await r.json();
  prog.stage(job.status);
  // The job runs on the server whatever the page does, so one failed poll (a
  // dropped connection, a gateway restart) is retried instead of ending the wait.
  let bad = 0;
  for (let i = 0; i < 1200 && job.status !== "completed" && job.status !== "failed"; i++) {
    await sleep(3000);
    if (ctl.signal.aborted) throw new DOMException("stopped", "AbortError");
    try {
      r = await gw("GET", "/v1/videos/" + encodeURIComponent(job.id), null, { signal: ctl.signal });
      if (r.status === 404 || r.status === 401 || r.status === 403) throw new Error(await errText(r));
      if (!r.ok) throw new Error("retry");
      job = await r.json();
      bad = 0;
    } catch (e) {
      if (e.name === "AbortError" || (e.message !== "retry" && e instanceof Error && !(e instanceof TypeError))) throw e;
      if (++bad > 20) throw new Error("和服务器的连接断了。视频可能还在做，稍后到对话里再看。");
      continue;
    }
    prog.stage(job.status);
  }
  if (job.status !== "completed") throw new Error((job.error && job.error.message) || "视频没有生成成功，没有扣点数");
  const c = await gw("GET", "/v1/videos/" + encodeURIComponent(job.id) + "/content", null, { signal: ctl.signal });
  if (!c.ok) throw new Error(await errText(c));
  await keepMedia(await c.blob(), "video/mp4", reply, "video", prompt);
}

// ---- conversation and account actions ----

async function pin(c) {
  const r = await srv("GET", "/api/chats/" + c.id);
  if (!r.ok) return;
  const full = await r.json(); full.pinned = !full.pinned;
  const w = await srv("PUT", "/api/chats/" + c.id, full);
  if (w.ok) { Object.assign(c, { pinned: full.pinned }); if (cur && cur.id === c.id) cur.pinned = full.pinned; chats.sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || b.updated - a.updated); paintList(); }
}
async function rename(c) {
  const v = await ask("改名", c.title);
  if (!v || !v.trim()) return;
  const r = await srv("GET", "/api/chats/" + c.id);
  if (!r.ok) return;
  const full = await r.json(); full.title = v.trim();
  const w = await srv("PUT", "/api/chats/" + c.id, full);
  if (w.ok) { c.title = (await w.json()).title; if (cur && cur.id === c.id) { cur.title = c.title; ui.title.textContent = c.title; } paintList(); }
}
async function remove(c) {
  if (!confirm("删除“" + c.title + "”？删掉后找不回来。")) return;
  const r = await srv("DELETE", "/api/chats/" + c.id);
  if (!r.ok && r.status !== 404) return;
  chats = chats.filter((x) => x.id !== c.id);
  if (cur && cur.id === c.id) newChat(); else paintList();
}
async function chatSettings() {
  const v = await ask("这个对话的系统提示词", cur.system, true, "保存");
  if (v == null) return;
  cur.system = v.trim();
  await persist();
}

function settings() {
  const msg = h("p", { class: "msg" });
  const save = h("input", { type: "checkbox", id: "keep" });
  save.checked = keep;
  save.addEventListener("change", () => { keep = save.checked; store(SAVE, keep ? "on" : "off"); paintList(); });
  const theme = h("select", { "aria-label": "外观" }, h("option", { value: "", text: "跟随系统" }), h("option", { value: "light", text: "浅色" }), h("option", { value: "dark", text: "深色" }));
  theme.value = load(THEME);
  theme.addEventListener("change", () => { store(THEME, theme.value || null); applyTheme(); });
  const dlg = h("dialog", {}, h("h2", { text: "设置" }),
    h("label", { for: "keep" }, save, " 把对话、图片和视频保存在这个浏览器里"),
    h("p", { class: "muted", text: "只保存在这个浏览器里，不会上传到任何服务器。关掉以后，新的对话只留在这个页面里，关掉页面就没有了。已经保存的不受影响。" }),
    h("label", { text: "外观" }), theme,
    ...["image", "video"].filter((k) => modelsOf(k).length > 1).flatMap((k) => {
      const m = h("select", { "aria-label": k === "image" ? "画图用的模型" : "做视频用的模型" }, ...modelsOf(k).map((x) => h("option", { value: x.id, text: label(x.id) })));
      m.value = makerModel(k);
      m.addEventListener("change", () => store("beenet-chat-" + k + "-model", m.value));
      return [h("label", { text: k === "image" ? "画图用的模型" : "做视频用的模型" }), m];
    }),
    h("div", { class: "row" },
      h("button", { class: "btn", text: "导出全部对话", onclick: async () => {
        const r = await srv("GET", "/api/export");
        if (!r.ok) { msg.className = "msg bad"; msg.textContent = "导出失败"; return; }
        const u = URL.createObjectURL(await r.blob());
        const a = h("a", { href: u, download: "beenet-chats.json" }); document.body.append(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(u), 5000);
      } }),
      h("button", { class: "btn", text: "删除这个浏览器里保存的全部内容", onclick: async () => {
        if (!confirm("这会删掉这个浏览器里这个账户的所有对话、图片和视频，找不回来。确定吗？")) return;
        const r = await srv("DELETE", "/api/data");
        if (r.ok || r.status === 204) { chats = []; newChat(); msg.className = "msg"; msg.textContent = "已删除。"; } else { msg.className = "msg bad"; msg.textContent = "删除失败"; }
      } })),
    msg,
    h("label", { text: "账户和客户端" }),
    embedded ? h("div", { class: "row" },
      h("a", { class: "btn", href: "/#/share", text: "共享 GPU 赚点数" }),
      h("a", { class: "btn", href: "/#/account", text: "账户" })) : h("div", { class: "row" },
      h("a", { class: "btn", href: gateway + "/client/", target: "_blank", rel: "noopener", text: "下载客户端" }),
      h("a", { class: "btn", href: gateway + "/console/", target: "_blank", rel: "noopener", text: "账户控制台" }),
      h("a", { class: "btn", href: gateway + "/console/try?classic=1", target: "_blank", rel: "noopener", text: "共享 GPU 赚点数" }),
      h("a", { class: "btn", href: gateway + "/console/try?classic=1", target: "_blank", rel: "noopener", text: "开发者测试" }),
      tenant.startsWith("try-") ? h("button", { class: "btn", text: "复制体验密钥", onclick: (e) => navigator.clipboard.writeText(key).then(() => { e.target.textContent = "已复制，粘贴到客户端注册页的邀请码一栏"; }, () => { msg.className = "msg bad"; msg.textContent = "浏览器不让复制"; }) }) : null),
    h("div", { class: "row" }, h("button", { class: "btn primary", text: "关闭", onclick: () => dlg.close() })));
  dlg.addEventListener("close", () => dlg.remove());
  document.body.append(dlg); dlg.showModal();
}

function applyTheme() {
  const t = load(THEME);
  if (t) document.documentElement.setAttribute("data-theme", t); else document.documentElement.removeAttribute("data-theme");
}

function signOut() {
  if (busy) busy.abort();
  jobs.forEach((j) => j.ctl.abort()); jobs.clear();
  store(KEY, null); key = ""; chats = []; cur = null; blobs.forEach((u) => URL.revokeObjectURL(u)); blobs.clear();
  startView();
}

applyTheme();
boot();
                     �*      U             ڶm    m۶                          *      �       I      �       �       *�J�R�T �J�R�T* 5       J)��R   ��RJ)         U       "             2333   ����    	       �       
       %       *       $I�     �$I            TU     ��      DDDD    """"    I�$     ����    UUUU    �              �      �      �HWZ  �:    U      ?       U             �              "               1       =       @       UUUU   ~       :       [       ]       .       v       /    2       UU                                       �       j(                   (�     �     �       �      �
             �      �&      �      )       	      +       i       '              �c�   1�    8E     k       UU            	.     %      \       8       4       H              ��     ��      TUUU   %      ������  UUUUUU  h       UU      �       �            �*      &	      �             )2     �}='   ��     U      F       )��N   [_      h>     �      EQEQ  ��(��(  �,˲,�  Y�eY�e         �t�p`5 �xό          7      Ke     �      ��     ********j      �      I       &       <       >       ;       2      �       t       ��      �             �       $       %����X  p  3 �            4      �      8             ����    �              ����������������
       @P   B       �     O       �m�     ۶m     X     �      _          �   6       f             X              N       "      z       H      b      e       s       	F
    V       	      	D     $      J�R�T*� �R�T*�J (�U     �      |       �       �      A       �      �       M
      'I$	    �$	     �       D      !�$    �?)�s� 1I      )I%    R�D    �P     �      �H      ��B$   �      �       E       �      �      �j�     ��     �            F      ^       b�      �$     
�$    �       !      !
     �      M      �      E      
�B�P( �B�P(
 E D  �      {0      e      �       'H�     	      b       �Zk��   k���Z   e�L�	   e�L     L       �@     	     ���Z   �            �$(�   �       �       I      �       ė      y       �       Rh      n�h\    �      ��m     �n�   ݈     ��10�F75     j#>    d�     �
             �      �      ���    �t�E��
-&�! ffff    3333    a      �             �      �      �      ��     �       2      �$I�$I  I�$I�$  R�      �      �      A      	�      �       A$     i��    J             �       1      ZS�    �      ���    =	      I��    �      WD����(A       *���J*���J      �TRI%�TRI%      *�J��D*�J��D  �H%R�T"�H%R�T"  �$   ))4       ����������������E�$#�H�B
��   A�(Q�D�%jK    D�%J�(Q�       �$I$�D�$              @       �Q             UUUUUUUUUU      v��t�E�      UUUUUUUUUUUUUU       pQ