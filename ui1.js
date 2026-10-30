= (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

  const KEM_X25519 = 0x0020, KDF = 0x0001, AEAD = 0x0001;
  const HPKE = enc.encode("HPKE-v1");
  const kemSuite = cat(enc.encode("KEM"), i2(KEM_X25519));
  const hpkeSuite = cat(enc.encode("HPKE"), i2(KEM_X25519), i2(KDF), i2(AEAD));

  async function hmac(key, data) {
    const k = await subtle().importKey("raw", key.length ? key : new Uint8Array(32), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    return new Uint8Array(await subtle().sign("HMAC", k, data));
  }
  const extract = (salt, ikm) => hmac(salt.length ? salt : new Uint8Array(32), ikm);
  async function expand(prk, info, len) {
    let t = new Uint8Array(0), out = new Uint8Array(0);
    for (let i = 1; out.length < len; i++) { t = await hmac(prk, cat(t, info, new Uint8Array([i]))); out = cat(out, t); }
    return out.slice(0, len);
  }
  const lExtract = (suite, salt, label, ikm) => extract(salt, cat(HPKE, suite, enc.encode(label), ikm));
  const lExpand = (suite, prk, label, info, len) => expand(prk, cat(i2(len), HPKE, suite, enc.encode(label), info), len);

  // ---- HPKE base mode, sender side ----
  async function setupSender(pkR, info) {
    const eph = await subtle().generateKey({ name: "X25519" }, true, ["deriveBits"]);
    const pkE = new Uint8Array(await subtle().exportKey("raw", eph.publicKey));
    const peer = await subtle().importKey("raw", pkR, { name: "X25519" }, false, []);
    const dh = new Uint8Array(await subtle().deriveBits({ name: "X25519", public: peer }, eph.privateKey, 256));
    const kemCtx = cat(pkE, pkR);
    const eae = await lExtract(kemSuite, new Uint8Array(0), "eae_prk", dh);
    const shared = await lExpand(kemSuite, eae, "shared_secret", kemCtx, 32);
    const pskIdHash = await lExtract(hpkeSuite, new Uint8Array(0), "psk_id_hash", new Uint8Array(0));
    const infoHash = await lExtract(hpkeSuite, new Uint8Array(0), "info_hash", info);
    const ks = cat(new Uint8Array([0]), pskIdHash, infoHash);
    const secret = await lExtract(hpkeSuite, shared, "secret", new Uint8Array(0));
    const key = await lExpand(hpkeSuite, secret, "key", ks, 16);
    const baseNonce = await lExpand(hpkeSuite, secret, "base_nonce", ks, 12);
    const expSecret = await lExpand(hpkeSuite, secret, "exp", ks, 32);
    return {
      enc: pkE,
      async seal(aad, pt) {
        const k = await subtle().importKey("raw", key, "AES-GCM", false, ["encrypt"]);
        return new Uint8Array(await subtle().encrypt({ name: "AES-GCM", iv: baseNonce, additionalData: aad }, k, pt)); // first message: sequence 0
      },
      exporter: (ctx, len) => lExpand(hpkeSuite, expSecret, "sec", enc.encode(ctx), len),
    };
  }

  // ---- the request and the response frames (same bytes as e2e.go) ----
  const infoFor = (ref) => enc.encode("beenet-e2e v1\0" + ref);
  const aadFor = (ref, model, path) => enc.encode(ref + "\0" + model + "\0" + path);

  // sealRequest encrypts plaintext (a string) for the node whose public key is pub
  // ({kem, key} with key base64 as the token carries it). Returns the envelope
  // and an opener for the response.
  // pad grows a JSON request with trailing spaces to a size bucket (1 KiB, 2 KiB, 4 KiB...),
  // so the length of what is sent does not tell what was asked.
  function pad(text) {
    const n = enc.encode(text).length;
    let bucket = 1024;
    while (bucket < n) bucket *= 2;
    return text + " ".repeat(bucket - n);
  }

  async function sealRequest(pub, ref, model, path, plaintext) {
    plaintext = pad(plaintext);
    if (pub.kem !== KEM_X25519) throw new Error("this browser supports X25519 keys only");
    const pk = unb64(pub.key);
    if (pk.length !== 32) throw new Error("bad node key");
    const s = await setupSender(pk, infoFor(ref));
    const ct = await s.seal(aadFor(ref, model, path), enc.encode(plaintext));
    const key = await s.exporter("beenet-e2e v1 response key", 16);
    const nonce = await s.exporter("beenet-e2e v1 response nonce", 12);
    const aesKey = await subtle().importKey("raw", key, "AES-GCM", false, ["decrypt"]);
    return { envelope: { v: 1, kem: pub.kem, ref, enc: b64(s.enc), ct: b64(ct) }, opener: new Opener(aesKey, nonce) };
  }

  class Opener {
    constructor(key, nonce) { this.key = key; this.nonce = nonce; this.seq = 0n; this.done = false; this.buf = new Uint8Array(0); }
    iv() { const n = this.nonce.slice(); let s = this.seq; for (let i = 11; i >= 4; i--) { n[i] ^= Number(s & 255n); s >>= 8n; } return n; }
    // push bytes in; returns the finished frames' plaintext chunks as {chunk, final}
    async push(bytes) {
      this.buf = cat(this.buf, bytes);
      const out = [];
      while (this.buf.length >= 5) {
        if (this.done) throw new Error("data after the final frame");
        const flag = this.buf[0], n = new DataView(this.buf.buffer, this.buf.byteOffset).getUint32(1);
        if (flag > 1 || n > (4 << 20) + 16) throw new Error("bad frame");
        if (this.buf.length < 5 + n) break;
        const ct = this.buf.slice(5, 5 + n);
        this.buf = this.buf.slice(5 + n);
        let pt;
        try { pt = new Uint8Array(await subtle().decrypt({ name: "AES-GCM", iv: this.iv(), additionalData: new Uint8Array([flag]) }, this.key, ct)); }
        catch (_) { throw new Error("a part of the answer failed authentication"); }
        this.seq++;
        out.push({ chunk: pt, final: flag === 1 });
        if (flag === 1) this.done = true;
      }
      return out;
    }
    // end: the stream has finished; an answer without its final frame was cut short
    end() { if (!this.done || this.buf.length) throw new Error("the answer was cut short"); }
  }

  // ---- the token ----
  // The bytes the verifiers signed: Go's JSON of the claims in this field order,
  // devices sorted, times as the controller wrote them.
  function canonical(c) {
    const q = JSON.stringify;
    const dev = (c.devices || []).slice().sort();
    // Go's encoding/json escapes <, > and & in strings; the fields here are hex
    // or short names, so a plain JSON.stringify gives the same bytes. Refuse
    // anything else rather than risk a mismatch that fails closed anyway.
    const parts = [
      '"node_id":' + q(c.node_id), '"nonce":' + q(c.nonce), '"measurement":' + q(c.measurement), '"gpu":' + q(c.gpu), '"cpu":' + q(c.cpu),
      '"devices":' + q(dev), '"class":' + q(c.class),
    ];
    if (c.e2e_key) parts.push('"e2e_key":' + q(c.e2e_key));
    parts.push('"issued":' + q(c.issued), '"expires":' + q(c.expires));
    return enc.encode("{" + parts.join(",") + "}");
  }
  async function keyHash(pub) {
    const h = await subtle().digest("SHA-256", cat(enc.encode("beenet-e2e-key\0"), i2(pub.kem), unb64(pub.key)));
    return hex(new Uint8Array(h));
  }
  // verifyToken: trusted is {verifierId: hex ed25519 public key}; quorum how many must have signed.
  // Throws with the reason; resolves to the token's claims when it is good for "secret" use.
  async function verifyToken(tok, trusted, quorum, now) {
    if (!(quorum >= 1)) throw new Error("no quorum configured: the browser does not know which verifiers to trust");
    const c = tok.claims, msg = canonical(c), seen = new Set();
    for (const s of tok.sigs || []) {
      const pk = trusted[s.verifier];
      if (!pk || seen.has(s.verifier)) continue;
      const k = await subtle().importKey("raw", unhex(pk), { name: "Ed25519" }, false, ["verify"]);
      if (await subtle().verify({ name: "Ed25519" }, k, unb64(s.signature), msg)) seen.add(s.verifier);
    }
    if (seen.size < quorum) throw new Error("only " + seen.size + " of " + quorum + " trusted verifiers signed this node's token");
    const t = now || Date.now();
    if (Date.parse(c.issued) > t + 60000 || !(t < Date.parse(c.expires))) throw new Error("the node's token is not valid now");
    if (c.class !== "secret" || !c.e2e_key || !tok.e2e_pub || (await keyHash(tok.e2e_pub)) !== c.e2e_key) throw new Error("the node's token is not for end-to-end use");
    return c;
  }


  // ---- Oblivious HTTP (RFC 9458; the Go side is ../../ohttp) ----
  // The whole request, headers and all, is encrypted to the gateway and passed
  // through a relay run by someone else. The relay sees the sender's address and
  // sizes; the gateway sees the request and the relay's address. The answer comes
  // back as authenticated chunks, so it still streams.
  const varint = (n) => (n < 64 ? [n] : n < 16384 ? [0x40 | (n >> 8), n & 255] : [0x80 | (n >>> 24), (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
  const lp = (b) => cat(new Uint8Array(varint(b.length)), b);
  function bhttpRequest(q) {
    const fields = [];
    for (const [k, v] of Object.entries(q.headers || {})) fields.push(lp(enc.encode(k.toLowerCase())), lp(enc.encode(String(v))));
    const sec = cat(...fields, new Uint8Array(0));
    const body = typeof q.body === "string" ? enc.encode(q.body) : q.body || new Uint8Array(0);
    return cat(new Uint8Array([0]), lp(enc.encode(q.method)), lp(enc.encode("https")), lp(enc.encode(q.authority)), lp(enc.encode(q.path)), lp(sec), lp(body));
  }
  class BReader {
    constructor(b) { this.b = b; this.p = 0; }
    varint() { const f = this.b[this.p], n = 1 << (f >> 6); let v = f & 63; for (let i = 1; i < n; i++) v = v * 256 + this.b[this.p + i]; this.p += n; return v; }
    bytes() { const n = this.varint(); const o = this.b.slice(this.p, this.p + n); this.p += n; return o; }
  }
  function bhttpResponseHead(b) {
    if (b[0] !== 1) throw new Error("not a binary HTTP response");
    const r = new BReader(b); r.p = 1;
    const status = r.varint(), sec = new BReader(r.bytes()), headers = new Headers();
    while (sec.p < sec.b.length) headers.append(dec.decode(sec.bytes()), dec.decode(sec.bytes()));
    return { status, headers };
  }
  // parseKeyConfig reads application/ohttp-keys and returns the first usable configuration.
  function parseKeyConfig(bytes) {
    let p = 0;
    while (p + 2 <= bytes.length) {
      const n = (bytes[p] << 8) | bytes[p + 1], c = bytes.slice(p + 2, p + 2 + n); p += 2 + n;
      if (c.length >= 3 + 32 + 2 && ((c[1] << 8) | c[2]) === KEM_X25519) return { id: c[0], key: c.slice(3, 35) };
    }
    throw new Error("no usable Oblivious HTTP key configuration");
  }
  async function responseKeys(exporter, encKey, respNonce) {
    const secret = await exporter("message/bhttp response", 16);
    const prk = await extract(cat(encKey, respNonce), secret);
    return { key: await subtle().importKey("raw", await expand(prk, enc.encode("key"), 16), "AES-GCM", false, ["decrypt"]), nonce: await expand(prk, enc.encode("nonce"), 12) };
  }
  // ohttpFetch sends q = {method, authority, path, headers, body} through the relay and
  // resolves, once the answer's head has arrived, to a Response whose body streams.
  async function ohttpFetch(relayUrl, cfg, q, signal) {
    const hdr = new Uint8Array([cfg.id, 0, 0x20, 0, 1, 0, 1]);
    const s = await setupSender(cfg.key, cat(enc.encode("message/bhttp request"), new Uint8Array([0]), hdr));
    const wire = cat(hdr, s.enc, await s.seal(new Uint8Array(0), bhttpRequest(q)));
    const r = await fetch(relayUrl, { method: "POST", headers: { "Content-Type": "message/ohttp-req" }, body: wire, signal });
    if (!r.ok || r.headers.get("Content-Type") !== "message/beenet-ohttp-res") throw new Error("the relay answered " + r.status);
    const rd = r.body.getReader();
    let buf = new Uint8Array(0), keys = null, seq = 0n, done = false, head = null;
    const iv = () => { const n = keys.nonce.slice(); let x = seq; for (let i = 11; i >= 4; i--) { n[i] ^= Number(x & 255n); x >>= 8n; } return n; };
    // next returns the next decrypted chunk, or null at the end of the stream
    async function next() {
      if (done) return null;
      for (;;) {
        if (!keys && buf.length >= 16) { keys = await responseKeys(s.exporter, s.enc, buf.slice(0, 16)); buf = buf.slice(16); }
        if (keys && buf.length >= 5) {
          const flag = buf[0], n = new DataView(buf.buffer, buf.byteOffset).getUint32(1);
          if (flag > 1 || n > (4 << 20) + 16) throw new Error("bad chunk from the gateway");
          if (buf.length >= 5 + n) {
            const ct = buf.slice(5, 5 + n); buf = buf.slice(5 + n);
            let pt;
            try { pt = new Uint8Array(await subtle().decrypt({ name: "AES-GCM", iv: iv(), additionalData: new Uint8Array([flag]) }, keys.key, ct)); }
            catch (_) { throw new Error("a part of the answer failed authentication"); }
            seq++;
            if (flag === 1) done = true;
            return pt;
          }
        }
        const { done: end, value } = await rd.read();
        if (end) throw new Error("the answer was cut short");
        buf = cat(buf, value);
      }
    }
    head = bhttpResponseHead((await next()) || new Uint8Array(0));
    const stream = new ReadableStream({
      async pull(ctrl) {
        for (;;) {
          const c = await next();
          if (c === null) { ctrl.close(); return; }
          if (c.length) { ctrl.enqueue(c); return; }
          if (done) { ctrl.close(); return; }
        }
      },
      cancel() { rd.cancel(); },
    });
    return new Response(head.status === 204 || head.status === 304 ? null : stream, { status: head.status, headers: head.headers });
  }

  root.BeeE2E = { pad, ohttpFetch, parseKeyConfig, sealRequest, verifyToken, canonical, keyHash, Opener, _hex: hex, _b64: b64 };
})(typeof window !== "undefined" ? window : globalThis);
"use strict";
// BeeNet client page. Everything goes to this program on 127.0.0.1: /api/* for
// the client itself, /v1/* for the platform (the client adds the API key).

const $ = (sel, root = document) => root.querySelector(sel);
const main = $("#main");
let S = null; // /api/state
let balTimer = null;
let gen = 0; // each render takes a number; a view that was overtaken by a newer render does not draw
const mount = (g, ...nodes) => { if (g === gen) main.replaceChildren(...nodes); };

function el(tag, attrs, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === "class") e.className = v;
    else if (k === "text") e.textContent = v;
    else if (k === "style") e.style.cssText = v; // set through the CSSOM: a style attribute is blocked by the CSP
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else if (v === true) e.setAttribute(k, "");
    else if (v !== false && v != null) e.setAttribute(k, v);
  }
  for (const k of kids.flat()) if (k != null) e.append(k.nodeType ? k : document.createTextNode(String(k)));
  return e;
}

async function api(path, body, method) {
  const opt = { method: method || (body === undefined ? "GET" : "POST"), headers: { "X-Fabric": "1" } };
  if (body !== undefined) { opt.headers["Content-Type"] = "application/json"; opt.body = JSON.stringify(body); }
  let r;
  try { r = await fetch(path, opt); } catch (_) { const e = new Error("连不上，请检查网络后重试。"); e.status = 0; throw e; }
  const text = await r.text();
  let data = null;
  try { data = JSON.parse(text); } catch (_) { /* not JSON */ }
  if (!r.ok) {
    const msg = (data && data.error && (data.error.message || data.error)) || text || r.statusText;
    const raw = typeof msg === "string" ? msg : JSON.stringify(msg);
    // The platform's refusals are English; say them in words and keep its text in brackets. Only the paths
    // that go on to the platform: a 401 from this client itself means something else (the page's session).
    const say = path.startsWith("/v1/") ? { 401: "密钥无效或已停用，请重新登录", 429: "请求太频繁，稍等一会儿再试", 502: "平台暂时连不上，稍后重试", 503: "平台暂时连不上，稍后重试", 504: "平台暂时连不上，稍后重试" }[r.status] : "";
    const e = new Error(say ? say + "（" + r.status + (raw ? "：" + raw : "") + "）" : raw);
    e.status = r.status;
    throw e;
  }
  return data;
}

async function loadState() { S = await api("/api/state"); return S; }

// Only NVIDIA reports its memory reliably; the others are listed by name.
const gpuLabel = (g) => g.name + (g.vendor === "nvidia" && g.vram_gib ? "（" + g.vram_gib.toFixed(0) + " GB）" : "");
const STATE_TEXT = { off: "未共享", "no-gpu": "没有可用 GPU", preparing: "准备中", waiting: "等待空闲", running: "共享中", error: "出错" };

function paintBanner() {
  const b = $("#banner");
  const u = S && S.update;
  if (!u || (!u.available && !u.staged)) { b.hidden = true; return; }
  b.hidden = false;
  if (u.staged) { b.replaceChildren("新版本 " + u.staged + " 已安装，关闭并重新打开客户端后生效。"); return; }
  const btn = el("button", { text: "更新", onclick: async () => {
    btn.disabled = true; btn.textContent = "下载并校验中…";
    try { await api("/api/update/apply", {}); await loadState(); paintBanner(); } catch (e) { btn.disabled = false; btn.textContent = "更新"; b.append(" 失败：" + e.message); }
  } });
  b.replaceChildren("有新版本 " + u.available + (u.notes ? "：" + u.notes : ""), btn);
}

function paintChip() {
  const chip = $("#chip");
  const st = S && S.share ? S.share.state : "off";
  chip.className = "chip " + st;
  chip.textContent = "GPU：" + (STATE_TEXT[st] || st);
}

async function paintBalance() {
  const b = $("#bal");
  if (!S || !S.signed_in) { b.textContent = ""; return; }
  try {
    const a = await api("/v1/account");
    if (a.billing) b.textContent = "积分 " + Number(a.available).toFixed(1);
    else b.textContent = "";
    b.classList.remove("away");
  } catch (e) {
    // an unanswered platform is said; a refused key is said elsewhere
    b.textContent = e.status === 401 ? "" : "连不上平台";
    b.classList.toggle("away", e.status !== 401);
  }
}

const TABS = [["chat", "聊天"], ["image", "图像"], ["video", "视频"], ["share", "共享 GPU"], ["account", "账户"]];

function paintNav(route) {
  const nav = $("#nav");
  // Chat (which also writes code and makes pictures and videos from the talk) is the web chat page,
  // embedded under /chat/; the other tabs are this page's own.
  nav.replaceChildren(...TABS.map(([id, name]) => el("a", { href: id === "chat" ? "/chat/" : "#/" + id, class: route === id ? "on" : "", text: name })));
}

function route() { return (location.hash.replace(/^#\//, "") || "chat").split("/")[0]; }

async function render() {
  const mine = ++gen;
  try { await loadState(); } catch (e) { main.replaceChildren(el("p", { class: "err", text: "客户端没有响应：" + e.message })); return; }
  if (mine !== gen) return;
  const top = $("#top");
  clearInterval(balTimer);
  if (!S.signed_in) { top.hidden = true; return viewWelcome(); }
  if (!S.consent_current) { top.hidden = true; return viewConsent(true); }
  top.hidden = false;
  const r = route();
  paintNav(r);
  paintBanner();
  paintChip();
  paintBalance();
  balTimer = setInterval(async () => { try { await loadState(); paintChip(); paintBalance(); } catch (_) { /* offline */ } }, 15000);
  main.className = "";
  const views = { image: viewImage, video: viewVideo, share: viewShare, account: viewAccount };
  if (!views[r]) { location.replace("/chat/"); return; } // the default page is the chat
  views[r]();
}
window.addEventListener("hashchange", render);

// ---- welcome: sign up or sign in ----

function viewWelcome() {
  const g = gen;
  main.className = "";
  const err = el("div", { class: "err" });
  const invite = el("input", { type: "text", "aria-label": "邀请码或体验密钥", placeholder: "邀请码（inv-…）或体验密钥" });
  const account = el("input", { type: "text", "aria-label": "账户名", placeholder: "给账户起个名字（字母、数字、短横线）" });
  const key = el("input", { type: "password", "aria-label": "API 密钥", placeholder: "sk-fab-…" });
  const gw = el("input", { type: "text", "aria-label": "平台地址", value: S.gateway });
  // A link from the download page carries the code (#invite=inv-...): fill it in, and take it out of the address.
  const fromLink = /[#&]invite=(inv-[0-9a-f]{32})/.exec(location.hash);
  if (fromLink) { invite.value = fromLink[1]; history.replaceState(null, "", location.pathname); }
  const go = async (fn) => { err.textContent = ""; try { await fn(); await render(); } catch (e) { err.textContent = e.message; } };
  mount(g, 
    el("h1", { text: "欢迎使用 蜂网 BeeNet" }),
    el("p", { class: "muted", text: "蜂网是一个分布式 GPU 算力网络：分布在各地的 GPU 自主协作，按需提供算力。用它聊天、写代码、生成图片和视频；你也可以把自己闲置的 GPU 接进来赚积分。" }),
    el("div", { class: "card" },
      el("h2", { text: "第一次用？从这里开始" }),
      el("ol", {},
        el("li", {}, "还没有邀请码或密钥：先在浏览器里", el("a", { href: S.gateway + "/console/try", target: "_blank", rel: "noopener", text: "免费体验" }), "，页面会给你一个“体验密钥”。把它粘贴到下面的“邀请码”框里，起一个账户名，点“注册”，体验剩下的点数会带过来。"),
        el("li", {}, "有人给了你邀请码：直接粘贴到“邀请码”框，起一个账户名，点“注册”。邀请码只能注册一次。"),
        el("li", {}, "注册后会给你一个找回码，只显示这一次，请存好。API 密钥保存在这台电脑的客户端里。想在别的电脑上登录，先到“账户”页点“显示密钥”复制下来，再在下面“已有账户”里粘贴。"),
        el("li", {}, "以后丢了密钥、客户端也没了，用账户名和找回码，在下面“已有账户”里点“忘了密钥？”找回账户。")),
      el("p", { class: "muted small", text: "密钥相当于账户的密码，不要发给别人，也不要贴到公开的地方。" })),
    el("div", { class: "card" },
      el("h2", { text: "新用户：用邀请码注册" }),
      el("label", { text: "邀请码，或网页上体验时得到的体验密钥" }), invite,
      el("label", { text: "账户名" }), account,
      el("div", { class: "row", style: "margin-top:12px" }, el("button", { class: "primary", text: "注册", onclick: () => go(async () => { const r = await api("/api/signup", { invite_code: invite.value, account: account.value }); if (r.recovery_code) await keepRecoveryCode(r.account, r.recovery_code, "注册成功"); }) }))),
    el("div", { class: "card" },
      el("h2", { text: "已有账户：用 API 密钥登录" }),
      el("p", { class: "muted small", text: "密钥在你注册过的那台电脑的客户端“账户”页里，点“显示密钥”可以复制。" }),
      key,
      el("p", { class: "muted small" }, "忘了密钥？", el("button", { class: "link", text: "用找回码找回账户", onclick: () => viewRecover() })),
      el("div", { class: "row", style: "margin-top:12px" }, el("button", { text: "登录", onclick: () => go(() => api("/api/signin", { api_key: key.value })) }))),
    err,
    el("details", {}, el("summary", { class: "muted small", text: "高级：平台地址" }),
      el("div", { class: "row", style: "margin-top:8px" }, el("div", { class: "grow" }, gw),
        el("button", { text: "保存", onclick: () => go(() => api("/api/gateway", { gateway: gw.value })) }))));
}

// A recovery code is shown once. The page waits until the person says it is saved,
// and then goes on (the caller re-renders).
function keepRecoveryCode(account, code, title) {
  return new Promise((done) => {
    const g = gen;
    const copy = el("button", { text: "复制", onclick: () => navigator.clipboard.writeText("账户名：" + account + "\n找回码：" + code).then(() => { copy.textContent = "已复制"; }) });
    mount(g,
      el("h1", { text: title }),
      el("div", { class: "card" },
        el("h2", { text: "你的找回账户的两样东西" }),
        el("p", { text: "找回账户要账户名和找回码两样，缺一样都不行。它们只显示这一次，请现在一起存进密码管理器或抄在纸上。以后可以在“账户”页生成新的找回码，旧的立即作废。" }),
        el("p", {}, "账户名：", el("code", { text: account, style: "user-select:all" })),
        el("p", {}, "找回码："),
        el("code", { text: code, style: "user-select:all;word-break:break-all;display:block;margin:12px 0" }),
        el("div", { class: "row" }, copy, el("button", { class: "primary", text: "我已经保存好了", onclick: () => done() }))));
  });
}

function viewRecover() {
  const g = gen;
  const err = el("div", { class: "err" });
  const account = el("input", { type: "text", "aria-label": "账户名", placeholder: "账户名" });
  const code = el("input", { type: "text", "aria-label": "找回码", placeholder: "rc-…" });
  const go = async () => {
    err.textContent = "";
    try {
      const r = await api("/api/recover", { account: account.value, code: code.value });
      await keepRecoveryCode(r.account, r.recovery_code, "账户已找回");
      await render();
    } catch (e) { err.textContent = e.message; }
  };
  mount(g,
    el("h1", { text: "用找回码找回账户" }),
    el("div", { class: "card" },
      el("p", { class: "muted small", text: "找回码是注册时给你的那一串（rc- 开头）。找回后，这台电脑登录到这个账户，账户自己的旧密钥全部停用，换了电脑的人用旧密钥也进不去了。授权给应用的密钥保留，可以在网页的“应用授权”里检查和撤销。" }),
      el("label", { text: "账户名" }), account,
      el("label", { text: "找回码" }), code,
      el("div", { class: "row", style: "margin-top:12px" }, el("button", { class: "primary", text: "找回", onclick: go }), el("button", { text: "返回", onclick: () => render() }))),
    err);
  account.focus();
}

// ---- consent ----

function viewConsent(first) {
  const g = gen;
  main.className = "";
  const d = (S.consent && S.consent_current) ? S.consent : S.consent_default;
  const share = el("input", { type: "checkbox" }); share.checked = !!d.share;
  const idleOnly = el("input", { type: "checkbox" }); idleOnly.checked = !!d.idle_only;
  const idleMin = el("input", { type: "number", min: "1", max: "1440", value: d.idle_minutes || 5 });
  const vram = el("input", { type: "number", "aria-label": "最多借出显存（GB）", min: "0", step: "0.5", value: d.share_vram_gib || 0 });
  const disk = el("input", { type: "number", "aria-label": "模型文件磁盘上限（GB）", min: "1", step: "1", value: d.max_disk_gib || 20 });
  const search = el("input", { type: "checkbox" }); search.checked = !!d.share_search;
  const err = el("div", { class: "err" });
  const gpus = S.gpus || [];
  const save = async () => {
    err.textContent = "";
    try {
      await api("/api/consent", { share: share.checked, idle_only: idleOnly.checked, idle_minutes: Number(idleMin.value) || 5,
        share_vram_gib: Number(vram.value) || 0, max_disk_gib: Number(disk.value) || 20, share_search: search.checked });
      location.hash = share.checked ? "#/share" : "#/chat";
      await render();
    } catch (e) { err.textContent = e.message; }
  };
  mount(g, 
    el("h1", { text: "把闲置的 GPU 接入共享网络" }),
    el("p", { class: "muted", text: "这一步是可选的，随时可以关掉。你不共享也能使用全部应用（用积分支付）。" }),
    el("div", { class: "card" },
      el("label", { class: "check" }, share, el("span", {}, el("b", { text: "在显卡空闲时，把 GPU 借给共享网络，赚取积分" }),
        el("br"), el("span", { class: "muted small", text: "已为你预先选中；取消勾选就不会共享任何东西。" }))),
      el("h2", { text: "共享时会发生什么" }),
      el("ul", { class: "plain" },
        el("li", { text: "你的电脑会下载一个 GPU 引擎（约 0.3–0.7 GB）和测速用的小模型（约 1.1 GB），之后按平台分配下载模型文件（每个约 2–3 GB），保存在本机，占用不超过下面设定的磁盘上限。" }),
        el("li", { text: "其他用户的请求会在你的电脑上由模型处理，你的 GPU 和电力会被用掉。志愿者节点只会收到“公开”级别的请求，平台不会把机密数据交给它；请求里不带用户的账户名和密钥。" }),
        el("li", { text: "你能看到自己节点的运行情况和收益，但看不到别人请求的内容与身份。" }),
        el("li", { text: "你的电脑只主动连出去，不开放任何入站端口，也不会读取你的文件。" }),
        el("li", { text: "赚到的积分先有几天确认期（期间平台会抽查结果），之后可用于这些应用；超出自用的部分可以申请兑付，需要实名和审核。" })),
      el("h2", { text: "你来控制" }),
      el("label", { class: "check" }, idleOnly, el("span", {}, "只在显卡空闲时共享：显卡空闲满 ", idleMin, " 分钟后开始。你的程序（游戏、渲染、自己的 AI）一用到显卡，就暂停；它再空闲满这么久才恢复。节点自己的运行不算在内。")),
      el("label", { class: "check" }, search, el("span", {}, "也帮平台做联网搜索（可选，默认不开）。",
        el("br"), el("span", { class: "muted small", text: "用户的搜索词会从你电脑的网络出口发给搜索引擎，搜索引擎能看到你的网络地址和这些词，但看不到用户是谁；你的电脑不保存它们。不占用 GPU。" }))),
      el("div", { class: "row" },
        el("div", { class: "grow" }, el("label", { text: "最多借出显存（GB，0 = 全部空闲显存）" }), vram),
        el("div", { class: "grow" }, el("label", { text: "模型文件磁盘上限（GB）" }), disk))),
    el("div", { class: "card" }, el("b", { text: "检测到的 GPU" }),
      gpus.length ? el("ul", { class: "plain" }, ...gpus.map(g => el("li", { text: gpuLabel(g) })))
        : el("p", { class: "muted", text: "没有检测到可用的 GPU。你仍然可以使用应用，只是无法共享。" })),
    err,
    el("div", { class: "row" }, el("button", { class: "primary", text: first ? "继续" : "保存", onclick: save }),
      el("span", { class: "muted small", text: "同意文本版本 " + S.consent_version + "；你可以随时在“共享 GPU”页修改。" })));
}

// ---- models ----

let modelsCache = null;
async function listModels() {
  if (!modelsCache) { const r = await api("/v1/models"); modelsCache = (r.data || []).map(m => m.id); }
  return modelsCache;
}
const isImage = (id) => /image|flux|sdxl|stable/i.test(id);
const isVideo = (id) => /video|wan|t2v|i2v/i.test(id);

// ---- image ----

async function viewImage() {
  const g = gen;
  let models = [];
  try { models = (await listModels()).filter(isImage); } catch (e) { mount(g, el("p", { class: "err", text: e.message })); return; }
  if (!models.length) { mount(g, el("h1", { text: "图像" }), el("p", { class: "muted", text: "现在没有可用的图像模型。" })); return; }
  const model = el("select", { "aria-label": "模型" }, ...models.map(m => el("option", { value: m, text: m })));
  const prompt = el("textarea", { "aria-label": "图片描述", placeholder: "描述想要的图片，英文效果通常更好（Ctrl+Enter 生成）" });
  const size = el("select", { "aria-label": "图片尺寸" }, ...[["512", "512 × 512（最快）"], ["768", "768 × 768"], ["1024", "1024 × 1024（较慢）"]].map(([v, t]) => el("option", { value: v, text: t })));
  const go = el("button", { class: "primary", text: "生成" });
  const status = el("div", { class: "muted" }), err = el("div", { class: "err" });
  const gallery = el("div", { class: "gallery" });
  go.addEventListener("click", async () => {
    const p = prompt.value.trim();
    if (!p) return;
    err.textContent = ""; go.disabled = true; const t0 = Date.now();
    const tick = setInterval(() => status.textContent = "生成中… " + Math.round((Date.now() - t0) / 1000) + " 秒", 500);
    try {
      const r = await api("/v1/images/generations", { model: model.value, prompt: p, n: 1, size: size.value + "x" + size.value });
      const b64 = r.data && r.data[0] && r.data[0].b64_json;
      if (!b64) throw new Error("平台没有返回图片");
      const src = "data:image/png;base64," + b64;
      gallery.prepend(el("figure", {}, el("img", { src, alt: p }), el("figcaption", {}, p, " ", el("a", { href: src, download: "image-" + Date.now() + ".png", text: "保存" }))));
    } catch (e) { err.textContent = e.message; }
    finally { clearInterval(tick); status.textContent = ""; go.disabled = false; paintBalance(); }
  });
  prompt.addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); go.click(); } });
  mount(g, el("h1", { text: "图像" }), el("div", { class: "card" }, el("div", { class: "row" }, el("div", { class: "grow" }, el("label", { text: "模型" }), model), el("div", {}, el("label", { text: "尺寸" }), size)), el("label", { text: "描述" }), prompt,
    el("div", { class: "row", style: "margin-top:10px" }, go, status), err), gallery);
}

// ---- video ----

async function viewVideo() {
  const g = gen;
  let models = [];
  try { models = (await listModels()).filter(isVideo); } catch (e) { mount(g, el("p", { class: "err", text: e.message })); return; }
  if (!models.length) { mount(g, el("h1", { text: "视频" }), el("p", { class: "muted", text: "现在没有可用的视频模型。" })); return; }
  const model = el("select", { "aria-label": "模型" }, ...models.map(m => el("option", { value: m, text: m })));
  const secs = el("select", { "aria-label": "视频时长" }, ...["2", "3", "4"].map(s => el("option", { value: s, text: s + " 秒" })));
  const prompt = el("textarea", { "aria-label": "视频描述", placeholder: "描述想要的视频内容（Ctrl+Enter 生成）" });
  const go = el("button", { class: "primary", text: "生成" });
  const status = el("div", { class: "muted" }), err = el("div", { class: "err" });
  const bar = el("div", { class: "bar", hidden: true }, el("i"));
  const gallery = el("div", { class: "gallery" });
  go.addEventListener("click", async () => {
    const p = prompt.value.trim();
    if (!p) return;
    err.textContent = ""; go.disabled = true; bar.hidden = false;
    try {
      let job = await api("/v1/videos", { model: model.value, prompt: p, seconds: secs.value });
      const t0 = Date.now();
      while (job.status === "queued" || job.status === "in_progress") {
        status.textContent = (job.status === "queued" ? "排队中" : "生成中") + "… 已 " + Math.round((Date.now() - t0) / 1000) + " 秒（视频通常需要几分钟，可以先去做别的）";
        bar.firstChild.style.width = (job.progress || 0) + "%";
        await new Promise(r => setTimeout(r, 3000));
        job = await api("/v1/videos/" + encodeURIComponent(job.id));
      }
      if (job.status !== "completed") throw new Error((job.error && job.error.message) || "生成失败");
      const r = await fetch("/v1/videos/" + encodeURIComponent(job.id) + "/content", { headers: { "X-Fabric": "1" } });
      if (!r.ok) throw new Error("取回视频失败（" + r.status + "）");
      const url = URL.createObjectURL(await r.blob());
      gallery.prepend(el("figure", {}, el("video", { src: url, controls: true }), el("figcaption", {}, p, " ", el("a", { href: url, download: "video-" + Date.now() + ".mp4", text: "保存" }))));
    } catch (e) { err.textContent = e.message; }
    finally { status.textContent = ""; bar.hidden = true; go.disabled = false; paintBalance(); }
  });
  prompt.addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); go.click(); } });
  mount(g, el("h1", { text: "视频" }), el("div", { class: "card" }, el("div", { class: "row" }, el("div", { class: "grow" }, el("label", { text: "模型" }), model), el("div", {}, el("label", { text: "时长" }), secs)),
    el("label", { text: "描述" }), prompt, el("div", { class: "row", style: "margin-top:10px" }, go, status), bar, err), gallery);
}

// ---- share ----

async function viewShare() {
  const g = gen;
  const sh = S.share, c = S.consent;
  const err = el("div", { class: "err" });
  const box = el("div", { class: "card" });
  const detail = sh.detail ? el("p", { class: "muted", text: sh.detail }) : null;
  const toggle = el("button", { class: c.share ? "danger" : "primary", text: c.share ? "停止共享" : "开始共享", onclick: async () => {
    err.textContent = ""; try { await api("/api/share", { share: !c.share }); await render(); } catch (e) { err.textContent = e.message; } } });
  const idleOnly = el("input", { type: "checkbox" }); idleOnly.checked = c.idle_only;
  const idleMin = el("input", { type: "number", min: "1", value: c.idle_minutes || 5 });
  const vram = el("input", { type: "number", "aria-label": "最多借出显存（GB）", min: "0", step: "0.5", value: c.share_vram_gib || 0 });
  const disk = el("input", { type: "number", "aria-label": "模型文件磁盘上限（GB）", min: "1", value: c.max_disk_gib || 20 });
  const search = el("input", { type: "checkbox" }); search.checked = !!c.share_search;
  const saveBtn = el("button", { text: "保存设置", onclick: async () => {
    err.textContent = ""; try {
      await api("/api/consent", { share: c.share, idle_only: idleOnly.checked, idle_minutes: Number(idleMin.value) || 5, share_vram_gib: Number(vram.value) || 0, max_disk_gib: Number(disk.value) || 20, share_search: search.checked });
      await render(); } catch (e) { err.textContent = e.message; } } });
  const earn = el("div", { class: "card" }, el("p", { class: "muted", text: "载入收益…" }));
  const log = el("pre", { class: "log", hidden: true });
  mount(g, el("h1", { text: "共享 GPU" }),
    el("div", { class: "card" }, el("div", { class: "row" }, el("b", { text: "状态：" + (STATE_TEXT[sh.state] || sh.state) }), el("div", { class: "spacer" }), toggle), detail,
      sh.state === "error" ? el("p", { class: "muted small", text: "出错后会自动重试。" }) : null),
    earn,
    el("div", { class: "card" }, el("b", { text: "设置" }),
      el("label", { class: "check" }, idleOnly, el("span", {}, "只在显卡空闲时共享，显卡空闲满 ", idleMin, " 分钟后开始")),
      el("label", { class: "check" }, search, el("span", {}, "也帮平台做联网搜索（搜索词会从这台电脑的网络出口发出，不占 GPU）")),
      el("div", { class: "row" }, el("div", { class: "grow" }, el("label", { text: "最多借出显存（GB，0 = 全部空闲）" }), vram), el("div", { class: "grow" }, el("label", { text: "模型文件磁盘上限（GB）" }), disk)),
      el("div", { class: "row", style: "margin-top:10px" }, saveBtn)),
    el("div", { class: "card" }, el("b", { text: "这台电脑的 GPU" }),
      (S.gpus || []).length ? el("ul", { class: "plain" }, ...S.gpus.map(g => el("li", { text: gpuLabel(g) }))) : el("p", { class: "muted", text: "没有检测到可用的 GPU。" })),
    err,
    el("details", {}, el("summary", { class: "muted small", text: "节点日志" }), log));
  $("details", main).addEventListener("toggle", async (ev) => { if (ev.target.open) { log.hidden = false; log.textContent = await (await fetch("/api/log")).text() || "（还没有日志）"; } });
  try {
    const r = await api("/v1/contributions");
    const nodes = r.nodes || [];
    earn.replaceChildren(el("b", { text: "收益" }),
      el("p", {}, "可用 ", el("b", { text: Number(r.earned || 0).toFixed(2) }), " 积分；确认期中 ", Number(r.pending || 0).toFixed(2), " 积分（平台抽查通过后释放，约 ", r.hold_days, " 天）"),
      nodes.length ? el("table", {}, el("tr", {}, ...["节点", "在线", "正在服务"].map(h => el("th", { text: h }))),
        ...nodes.map(n => el("tr", {}, el("td", { text: n.name }), el("td", { text: n.online ? "是" : "否" }), el("td", { text: n.serving || "—" })))) : el("p", { class: "muted", text: "还没有节点加入。" }));
  } catch (e) { earn.replaceChildren(el("b", { text: "收益" }), el("p", { class: "muted", text: "暂时取不到收益，稍后刷新页面再看。（" + e.message + "）" })); }
}

// ---- account ----

async function viewAccount() {
  const g = gen;
  const info = el("div", { class: "card" }, el("p", { class: "muted", text: "载入…" }));
  const err = el("div", { class: "err" });
  const autoBox = el("input", { type: "checkbox" });
  autoBox.checked = !!S.autostart;
  autoBox.addEventListener("change", async () => { err.textContent = ""; try { await api("/api/autostart", { on: autoBox.checked }); } catch (e) { autoBox.checked = !autoBox.checked; err.textContent = e.message; } });
  const keyShown = el("div", { class: "muted small" });
  const keyBtn = el("button", { text: "显示密钥" });
  keyBtn.addEventListener("click", async () => {
    if (keyShown.firstChild) { keyShown.replaceChildren(); keyBtn.textContent = "显示密钥"; paintUsage(""); return; }
    err.textContent = "";
    try {
      const r = await api("/api/key/reveal", {});
      const code = el("code", { text: r.api_key, style: "user-select:all;word-break:break-all" });
      const copy = el("button", { text: "复制", onclick: () => navigator.clipboard.writeText(r.api_key).then(() => { copy.textContent = "已复制"; setTimeout(() => { copy.textContent = "复制"; }, 1500); }) });
      keyShown.replaceChildren(code, " ", copy);
      keyBtn.textContent = "隐藏密钥";
      paintUsage(r.api_key);
    } catch (e) { err.textContent = e.message; }
  });
  const keyCard = el("div", { class: "card" }, el("h2", { text: "API 密钥" }),
    el("p", { class: "muted small", text: "换电脑、重装、或退出登录后重新登录都要用它。它相当于账户的密码：不要发给别人，不要贴到公开的地方；丢了又没有别的登录方式时，账户就进不去了。" }),
    el("div", { class: "row" }, keyBtn), keyShown);
  // Using the key in another app: the address, the key, and a command that runs as it is.
  // The key appears in the examples only after "显示密钥", so they are copied, never shown by accident.
  const apiBase = S.gateway.replace(/\/$/, "") + "/v1";
  const usageKey = el("div", { class: "muted small" });
  const curlPre = el("pre", { style: "white-space:pre-wrap;word-break:break-all;user-select:all" });
  const pyPre = el("pre", { style: "white-space:pre-wrap;word-break:break-all;user-select:all" });
  const paintUsage = (k) => {
    const shown = k || "你的密钥";
    usageKey.replaceChildren(k ? el("span", { text: "密钥已经填进下面的例子里，可以直接复制。" }) : el("span", { text: "点上面的“显示密钥”，这里和下面的例子就会填上密钥。" }));
    curlPre.textContent = "curl " + apiBase + "/chat/completions \\\n  -H \"Authorization: Bearer " + shown + "\" \\\n  -H \"Content-Type: application/json\" \\\n  -d '{\"model\": \"auto\", \"messages\": [{\"role\": \"user\", \"content\": \"你好\"}]}'";
    pyPre.textContent = "from openai import OpenAI\n\nclient = OpenAI(base_url=\"" + apiBase + "\", api_key=\"" + shown + "\")\nreply = client.chat.completions.create(\n    model=\"auto\",\n    messages=[{\"role\": \"user\", \"content\": \"你好\"}],\n)\nprint(reply.choices[0].message.content)";
  };
  paintUsage("");
  const usageCard = el("div", { class: "card" }, el("h2", { text: "怎么在别的应用里用这把密钥" }),
    el("p", { class: "muted small", text: "聊天软件、编辑器里的 AI 插件、你自己写的程序，都可以用它。这些应用和 OpenAI 的接口兼容，只要填两项：" }),
    el("table", {},
      el("tr", {}, el("td", { text: "接口地址（Base URL）" }), el("td", {}, el("code", { text: apiBase, style: "user-select:all" }))),
      el("tr", {}, el("td", { text: "API 密钥" }), el("td", {}, usageKey))),
    el("p", { class: "muted small", text: "在命令行里试一下：" }), curlPre,
    el("p", { class: "muted small", text: "用 Python（openai 库）：" }), pyPre,
    el("p", { class: "muted small", text: "Open WebUI、Cherry Studio、Chatbox 等软件，在设置里添加“OpenAI 兼容”的服务商，填上面两项即可。模型名填 auto 就由蜂网替你选合适的模型；也可以指定 chat-default（快）、chat-strong（强）、code-default（代码）；图像用 z-image-turbo。" }),
    el("p", { class: "muted small" }, "更多说明（视频、错误码、限额）：", el("a", { href: S.gateway + "/docs/", target: "_blank", rel: "noopener", text: "开发者文档" })));
  const recShown = el("div", { class: "muted small" });
  const recBtn = el("button", { text: "生成新的找回码" });
  recBtn.addEventListener("click", async () => {
    err.textContent = "";
    if (!confirm("生成新的找回码？旧的找回码会立即作废。账户的密钥不受影响。")) return;
    try {
      const r = await api("/api/recovery-code", {});
      recShown.replaceChildren("账户名：", el("code", { text: S.account, style: "user-select:all" }), "　找回码：", el("code", { text: r.recovery_code, style: "user-select:all;word-break:break-all" }), "　只显示这一次，请和账户名一起存好。");
    } catch (e) { err.textContent = e.message; }
  });
  const recCard = el("div", { class: "card" }, el("h2", { text: "找回码" }),
    el("p", { class: "muted small", text: "丢了所有密钥、客户端也没了的时候，用账户名和找回码在登录页找回账户。找回码只显示一次，请存进密码管理器。" }),
    el("div", { class: "row" }, recBtn), recShown);
  // The local API: other programs on this computer use the client as an OpenAI-compatible
  // service, with a token of their own (not the account key). Off until switched on.
  const localBox = el("input", { type: "checkbox" });
  const localInfo = el("div", { class: "muted small" });
  const localRenew = el("button", { text: "换一个新令牌" });
  const paintLocal = (v) => {
    localBox.checked = !!v.on;
    localRenew.hidden = !v.on;
    if (!v.on) { localInfo.replaceChildren("现在是关闭的，本机上的其他程序用不了这个客户端。"); return; }
    localInfo.replaceChildren(
      el("table", {},
        el("tr", {}, el("td", { text: "接口地址（Base URL）" }), el("td", {}, el("code", { text: v.base, style: "user-select:all" }))),
        el("tr", {}, el("td", { text: "API 密钥（令牌）" }), el("td", {}, el("code", { text: v.token, style: "user-select:all;word-break:break-all" })))),
      el("p", { class: "muted small", text: "在 Open WebUI、Cherry Studio、编辑器插件或你自己的程序里，添加“OpenAI 兼容”服务，填这两项。它只对这台电脑开放，用的是你账户的积分。令牌只能用于聊天、补全、图像和视频，动不了账户。" }));
  };
  localBox.addEventListener("change", async () => {
    err.textContent = "";
    try { paintLocal(await api("/api/localapi", { on: localBox.checked })); } catch (e) { localBox.checked = !localBox.checked; err.textContent = e.message; }
  });
  localRenew.addEventListener("click", async () => {
    err.textContent = "";
    if (!confirm("换一个新令牌？旧令牌立刻失效，用它的程序要改成新的。")) return;
    try { paintLocal(await api("/api/localapi", { on: true, renew: true })); } catch (e) { err.textContent = e.message; }
  });
  api("/api/localapi").then(paintLocal).catch(() => { localInfo.textContent = ""; });
  const localCard = el("div", { class: "card" }, el("h2", { text: "本机接口（给这台电脑上的其他程序用）" }),
    el("label", { class: "check" }, localBox, el("span", { text: "让本机上的其他程序通过 127.0.0.1 使用蜂网（默认关闭）。" })),
    localInfo, el("div", { class: "row", style: "margin-top:8px" }, localRenew));
  // What this computer can do: its GPUs, which ones can work on a model together, and how big a model runs.
  const machBody = el("div", { class: "muted small", text: "正在读取这台电脑的显卡…" });
  api("/api/machine").then((m) => {
    const rows = [];
    if (m.note) rows.push(el("p", { class: "muted small", text: m.note }));
    if (!m.gpus || !m.gpus.length) { machBody.replaceChildren(...rows); return; }
    rows.push(el("table", {}, ...m.gpus.map(g => el("tr", {}, el("td", { text: "显卡 " + g.index }), el("td", { text: g.name }), el("td", { text: g.total_gib.toFixed(0) + " GB（空闲 " + g.free_gib.toFixed(0) + " GB）" + (g.pcie ? " · PCIe " + g.pcie : "") })))));
    rows.push(el("p", { class: "muted small", text: "哪些显卡可以一起跑一个模型，以及能跑多大的（4 位量化、8k 上下文、速度不低于舒适下限）：" }));
    rows.push(el("table", {}, ...m.islands.map(i => el("tr", {}, el("td", { text: "显卡 " + i.gpus.join("、") }), el("td", { text: i.link }), el("td", { text: i.mem_gib.toFixed(0) + " GB" }), el("td", { text: i.largest ? "最大约 " + i.largest : "只适合很小的模型" })))));
    if (m.islands.length > 1 || (m.islands[0] && m.islands[0].gpus.length > 1)) rows.push(el("p", { class: "muted small", text: "有多张 NVIDIA 显卡时，共享时客户端为每张卡各起一个代理，每张卡各跑一个模型（同一个模型可以放在几张卡上，吞吐更高，一张卡出问题只损失一个副本）。放不进一张卡的大模型，由平台把几张卡拼成一条流水线来跑。" }));
    machBody.replaceChildren(...rows);
  }).catch(() => { machBody.textContent = ""; });
  const machCard = el("div", { class: "card" }, el("h2", { text: "这台电脑能做什么" }), machBody);
  // Presets: a name for "this model, with this system prompt and these settings", kept on this computer.
  // Other programs (and the command line) see a preset as one more model, by its name.
  const prList = el("div", { class: "muted small" });
  const prName = el("input", { type: "text", maxlength: "64", placeholder: "名字，例如 translator", "aria-label": "预设名字", style: "width:14em" });
  const prBase = el("input", { type: "text", placeholder: "基础模型，例如 auto", "aria-label": "基础模型", style: "width:16em" });
  const prSys = el("textarea", { "aria-label": "系统提示", placeholder: "系统提示，例如：你是翻译，把用户的话翻成英文，只输出译文。", rows: "3", style: "width:100%" });
  const prTemp = el("input", { type: "number", step: "0.1", min: "0", max: "2", placeholder: "temperature（可空）", "aria-label": "temperature", style: "width:11em" });
  const prAdd = el("button", { class: "primary", text: "保存预设" });
  const paintPresets = (l) => {
    if (!l.length) { prList.replaceChildren("还没有预设。"); return; }
    prList.replaceChildren(...l.map(x => {
      const del = el("button", { text: "删除", "aria-label": "删除预设 " + x.name });
      del.addEventListener("click", async () => {
        err.textContent = "";
        if (!confirm("删除预设“" + x.name + "”？")) return;
        try { paintPresets((await api("/api/presets/" + encodeURIComponent(x.name), undefined, "DELETE")).presets); } catch (e) { err.textContent = e.message; }
      });
      return el("div", { class: "row", style: "align-items:center;margin:4px 0" }, el("code", { text: x.name }), el("span", { text: " 基于 " + x.base + (x.system ? " · " + x.system.slice(0, 40) + (x.system.length > 40 ? "…" : "") : "") }), del);
    }));
  };
  api("/api/presets").then(r => paintPresets(r.presets)).catch(() => {});
  prAdd.addEventListener("click", async () => {
    err.textContent = "";
    const body = { name: prName.value.trim(), base: prBase.value.trim(), system: prSys.value };
    if (prTemp.value !== "") body.temperature = Number(prTemp.value);
    try {
      paintPresets((await api("/api/presets", body)).presets);
      prName.value = ""; prSys.value = ""; prTemp.value = "";
    } catch (e) { err.textContent = e.message; }
  });
  const presetCard = el("div", { class: "card" }, el("h2", { text: "我的预设" }),
    el("p", { class: "muted small", text: "给“某个模型 + 一段系统提示 + 几个参数”起个名字，之后在聊天软件、编辑器插件或命令行（beenet run 名字）里像别的模型一样按名字用。预设只保存在这台电脑上，不会上传；每次提问时由客户端把系统提示加在前面。名字不要和平台上的模型重名。" }),
    prList,
    el("div", { class: "row", style: "margin-top:10px" }, prName, prBase, prTemp),
    el("div", { class: "row", style: "margin-top:8px" }, prSys),
    el("div", { class: "row", style: "margin-top:8px" }, prAdd));
  // The Ollama port: tools that only know Ollama look at 127.0.0.1:11434. BeeNet answers there only
  // while Ollama is neither installed nor running and the port is free (the client checks, and gives the
  // port back if Ollama is installed later).
  const olBox = el("input", { type: "checkbox" });
  const olInfo = el("div", { class: "muted small" });
  const paintOl = (v) => {
    olBox.checked = !!v.on && !!v.open;
    const d = v.detected || {};
    if (v.blocked && !v.open) { olBox.disabled = true; olInfo.textContent = v.blocked; return; }
    olBox.disabled = false;
    olInfo.textContent = v.open ? "已开启：本机上只认 Ollama 地址的软件，把地址填 http://127.0.0.1:11434 即可（不需要密钥）。" : "没有检测到 Ollama，11434 端口空闲，可以开启。";
  };
  olBox.addEventListener("change", async () => {
    err.textContent = "";
    try { paintOl(await api("/api/ollama", { on: olBox.checked })); } catch (e) { olBox.checked = false; err.textContent = e.message; api("/api/ollama").then(paintOl).catch(() => {}); }
  });
  api("/api/ollama").then(paintOl).catch(() => {});
  const olCard = el("div", { class: "card" }, el("h2", { text: "Ollama 兼容端口（11434）" }),
    el("label", { class: "check" }, olBox, el("span", { text: "在 11434 端口也提供 Ollama 接口，给只认 Ollama 地址的软件用（默认关闭）。" })),
    olInfo,
    el("p", { class: "muted small", text: "这台电脑上有 Ollama（已安装或正在运行）时不会开启，也不会去抢它的端口；开启之后如果装了 Ollama，会自动让出端口并关掉这个开关。这个端口和 Ollama 一样不需要密钥，但只接受本机程序的请求，浏览器网页访问不了。上面的“本机接口”开着时，客户端自己的端口上也有 /api/chat 等 Ollama 接口，用同一个令牌。" }));
  // Reaching the platform over Tor: every call (the page's and the local API's) goes through the
  // Tor proxy on this computer to the platform's onion service; if Tor is not there the call fails.
  const torBox = el("input", { type: "checkbox" });
  const torAddr = el("input", { type: "text", value: "127.0.0.1:9050", "aria-label": "Tor 代理地址", style: "width:12em" });
  const torNote = el("div", { class: "muted small" });
  const paintTor = (v) => { torBox.checked = !!v.on; torAddr.value = v.socks || "127.0.0.1:9050"; torNote.textContent = v.on ? (v.note || "已开启：发往平台的请求都经过 Tor。") : (v.note || ""); };
  torBox.addEventListener("change", async () => {
    err.textContent = "";
    try { paintTor(await api("/api/tor", { on: torBox.checked, socks: torAddr.value.trim() })); } catch (e) { torBox.checked = !torBox.checked; err.textContent = e.message; }
  });
  api("/api/tor").then(paintTor).catch(() => {});
  const torCard = el("div", { class: "card" }, el("h2", { text: "经 Tor 访问" }),
    el("label", { class: "check" }, torBox, el("span", { text: "发往平台的所有请求（包括上面“本机接口”给其他程序用的）都经 Tor 到达平台的洋葱服务，平台和中间的网络看不到你这台电脑的地址。" })),
    el("div", { class: "row", style: "margin-top:8px" }, el("label", { text: "Tor 代理地址" }), torAddr),
    torNote,
    el("p", { class: "muted small", text: "需要本机已经运行 Tor：独立的 Tor 服务默认是 127.0.0.1:9050，Tor 浏览器是 127.0.0.1:9150。没找到 Tor 时请求会失败，不会改走直连。经 Tor 会慢一些；有地区限制的模型（例如 H3）在这条路上用不了。检查更新和下载新版本也走 Tor。" }));
  // Automatic updates: on by default; the person can turn them off here.
  const updBox = el("input", { type: "checkbox" });
  updBox.checked = S.auto_update !== false;
  updBox.addEventListener("change", async () => { err.textContent = ""; try { await api("/api/autoupdate", { on: updBox.checked }); } catch (e) { updBox.checked = !updBox.checked; err.textContent = e.message; } });
  const updCard = el("div", { class: "card" }, el("h2", { text: "自动更新" }),
    el("label", { class: "check" }, updBox, el("span", { text: "有新版本时自动下载并安装（推荐）。新版本在你下次打开客户端时生效。" })),
    el("p", { class: "muted small", text: "关掉以后，有新版本时页面顶部会提示，由你点“更新”才会安装。无论哪种方式，安装都会先核对发布签名和文件校验码，不通过就不会安装。" }));
  // Merging this account into another one: the other account's key is typed in here, once.
  const mergeKey = el("input", { type: "password", autocomplete: "off", spellcheck: "false", "aria-label": "要保留的那个账户的 API 密钥", placeholder: "要保留的那个账户的 API 密钥", style: "width:100%" });
  const mergeBtn = el("button", { class: "danger", text: "合并到那个账户" });
  mergeBtn.addEventListener("click", async () => {
    err.textContent = "";
    const target = mergeKey.value.trim();
    if (!target) { err.textContent = "请先填入要保留的那个账户的 API 密钥。"; return; }
    if (!confirm("把这个账户合并到你填入的账户？\n\n合并后：这个账户已赚的积分、购买的积分和名下的节点，都归到那个账户；这个账户的密钥全部失效；本电脑改用那个账户的密钥。\n赠送的积分留在这个账户，不会合并过去。\n其他电脑上登录着这个账户的，要用那个账户的密钥重新登录。\n合并不能撤销。")) return;
    try {
      await api("/api/account/merge", { target_key: target });
      mergeKey.value = "";
      await render();
    } catch (e) { err.textContent = e.message; }
  });
  const mergeCard = el("div", { class: "card" }, el("h2", { text: "合并到另一个账户" }),
    el("p", { class: "muted small", text: "如果你在几台电脑上各用了一个账户，可以把这个账户合并到另一个账户里，积分和节点就都在那一个账户下。在下面填入要保留的那个账户的 API 密钥（在那台电脑的“显示密钥”里可以看到）。" }),
    el("p", { class: "muted small", text: "合并后这个账户的密钥全部失效，本电脑改用要保留的那个账户的密钥。赠送的积分不会合并。合并不能撤销。" }),
    el("div", { class: "row" }, mergeKey), el("div", { class: "row", style: "margin-top:8px" }, mergeBtn));
  // Diagnostics: shown first, so the person sees what they are about to send; keys, codes and
  // addresses are left out by the client itself (diagnostics.go).
  const diagOut = el("pre", { class: "log", hidden: true });
  const diagCopy = el("button", { text: "复制", hidden: true });
  const diagBtn = el("button", { text: "生成诊断信息" });
  diagBtn.addEventListener("click", async () => {
    err.textContent = ""; diagBtn.disabled = true;
    try {
      diagOut.textContent = await (await fetch("/api/diagnostics")).text();
      diagOut.hidden = false; diagCopy.hidden = false; diagCopy.textContent = "复制";
    } catch (e) { err.textContent = "生成不了：" + e.message; }
    diagBtn.disabled = false;
  });
  diagCopy.addEventListener("click", () => navigator.clipboard.writeText(diagOut.textContent).then(() => { diagCopy.textContent = "已复制"; }, () => { diagCopy.textContent = "复制失败，请手动选中复制"; }));
  const diagCard = el("div", { class: "card" }, el("h2", { text: "遇到问题？" }),
    el("p", { class: "muted small", text: "点“生成诊断信息”，把下面出现的文字发给帮你的人。里面有版本、系统、显卡、共享状态和日志的最后几十行；密钥、找回码、邀请码、令牌、网络地址和你的文件夹路径已经被隐去。生成后请先看一遍再复制。" }),
    el("div", { class: "row" }, diagBtn, diagCopy), diagOut);
  // Clear this computer: a deletion, so two steps (what it does, then the word typed). The client
  // checks the word again; the account itself stays on the platform.
  const clearBtn = el("button", { class: "danger", text: "清除这台电脑上的数据" });
  clearBtn.addEventListener("click", async () => {
    err.textContent = "";
    if (!confirm("这会：停止共享、取消开机自启、退出登录，并删除这台电脑上客户端保存的全部文件（密钥、设置、已下载的引擎和模型、日志），然后关闭客户端。\n\n账户本身还在平台上：用账户名和找回码，在任何电脑上都能找回。如果你还没有保存找回码，现在先取消。\n\n继续？")) return;
    const word = prompt("请输入“清除”两个字来确认：");
    if (word !== "清除") { err.textContent = "没有输入“清除”，什么也没有删除。"; return; }
    clearBtn.disabled = true;
    try {
      const r = await api("/api/uninstall", { confirm: word, delete_data: true });
      const left = r.failed && r.failed.length ? "有 " + r.failed.length + " 项正在使用，没删掉：" + r.failed.join("、") + "。" : "";
      document.body.replaceChildren(el("p", { class: "muted center", text: "已清除这台电脑上的数据，客户端已关闭。" + left + "程序本身的文件请像删除其他程序一样删除。" }));
    } catch (e) { clearBtn.disabled = false; err.textContent = e.message; }
  });
  const clearCard = el("div", { class: "card" }, el("h2", { text: "不再使用这台电脑？" }),
    el("p", { class: "muted small", text: "清除后，这台电脑上不会留下你的账户密钥、设置和下载的文件，也不会再自动启动。账户和积分仍在平台上，之后可以用找回码找回。只会删除蜂网客户端自己保存的文件。" }),
    el("div", { class: "row" }, clearBtn));
  mount(g, el("h1", { text: "账户" }), info, updCard, keyCard, usageCard, machCard, presetCard, localCard, olCard, torCard, recCard, mergeCard, diagCard, clearCard,
    el("div", { class: "card" }, S.autostart_ok ? el("label", { class: "check" }, autoBox, el("span", { text: "登录电脑时自动启动蜂网客户端（只在你自己的账户下，不需要管理员权限）" })) : null, el("div", { class: "row" },
      el("button", { text: "查看同意文本并修改", onclick: () => viewConsent(false) }),
      el("button", { class: "danger", text: "退出登录", onclick: async () => { if (confirm("退出登录会停止共享，并删除本机保存的密钥。\n\n如果你还没有把 API 密钥复制保存下来（上面的“显示密钥”），退出后就没法再登录这个账户了。\n继续退出？")) { await api("/api/signout", {}); location.hash = ""; await render(); } } }),
      el("button", { text: "关闭客户端", onclick: async () => { if (confirm("关闭客户端会同时停止共享。继续？")) { try { await api("/api/quit", {}); } catch (_) { /* gone */ } document.body.replaceChildren(el("p", { class: "muted center", text: "客户端已关闭，可以关掉这个页面。" })); } } })),
      el("p", { class: "muted small", text: "平台：" + S.gateway + "　版本：" + S.version })), err);
  try {
    const a = await api("/v1/account");
    const rows = [["账户", a.tenant], ["可用积分", a.available != null ? Number(a.available).toFixed(2) : "—"]];
    for (const [k, n] of [["gift", "赠送"], ["purchased", "购买"], ["earned", "贡献所得"]]) if (a[k] != null) rows.push([n, Number(a[k]).toFixed(2)]);
    info.replaceChildren(el("table", {}, ...rows.map(([k, v]) => el("tr", {}, el("td", { text: k }), el("td", { text: String(v) })))));
  } catch (e) { info.replaceChildren(el("p", { class: "err", text: e.message })); }
}

render();
// BeeNet Chat. Text, pictures and v