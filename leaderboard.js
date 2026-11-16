// Towers accounts and leaderboard (browser side). Loaded before the game script.
// Talks to the Cloudflare Worker, drives the account screens, and keeps the two score lists current.
(function () {
  // The address of your Cloudflare Worker, with nothing after it.
  const API_URL = "https://towers-leaderboard.jdmiller0416.workers.dev";

  const KEY_STORE = "towers-account-key";
  const NAME_STORE = "towers-account-name";
  const NAME_PATTERN = /^[A-Za-z0-9_-]{3,12}$/;
  const KEY_PATTERN = /^[ABCDEFGHJKMNPQRSTUVWXYZ2-9]{16}$/;

  window.TowersUI = { open: false }; // the game ignores taps and keys while an account screen is open

  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) {} },
    del(k) { try { localStorage.removeItem(k); } catch (e) {} },
  };

  // "abcd efgh..." -> "ABCD-EFGH-IJKL-MNOP", or null if it can't be a key
  function cleanKey(raw) {
    const s = String(raw || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
    return KEY_PATTERN.test(s) ? s.match(/.{4}/g).join("-") : null;
  }

  // ---- the Worker. The preview page swaps in its own test version of this. ----
  const httpBackend = (() => {
    async function call(method, path, key, body) {
      const ctl = typeof AbortController === "function" ? new AbortController() : null;
      const timer = ctl ? setTimeout(() => ctl.abort(), 12000) : null;
      try {
        let res;
        try {
          res = await fetch(API_URL + path, {
            method,
            headers: Object.assign({}, body ? { "Content-Type": "application/json" } : {}, key ? { Authorization: "Bearer " + key } : {}),
            body: body ? JSON.stringify(body) : undefined,
            cache: "no-store",
            signal: ctl ? ctl.signal : undefined,
          });
        } catch (e) {
          const err = new Error("Can't reach the leaderboard. Check your connection.");
          err.offline = true;
          throw err;
        }
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          const err = new Error(data.error || "Something went wrong.");
          err.status = res.status;
          throw err;
        }
        return data;
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
    return {
      top: (cat) => call("GET", "/scores?cat=" + encodeURIComponent(cat || "score")).then((d) => d.scores || []),
      profile: (name) => call("GET", "/profile?name=" + encodeURIComponent(name)).then((d) => d.profile),
      signup: (body) => call("POST", "/signup", null, body),
      me: (key) => call("GET", "/me", key).then((d) => Object.assign(d.profile, { mustSetPassword: !!d.mustSetPassword })),
      login: (body) => call("POST", "/login", null, body),
      setPassword: (key, body) => call("POST", "/password", key, body),
      logout: (key) => call("POST", "/logout", key, {}),
      rename: (key, username) => call("POST", "/rename", key, { username }).then((d) => d.profile),
      run: (key, body) => call("POST", "/scores", key, body),
      runs: (key, body) => call("POST", "/runs", key, body),
      saveProfile: (key, body) => call("POST", "/profile", key, body).then((d) => d.profile),
      rotate: (key) => call("POST", "/rotate-key", key, {}).then((d) => d.key),
      remove: (key) => call("POST", "/delete", key, {}),
    };
  })();
  const backend = window.LEADERBOARD_BACKEND || httpBackend;

  // the game's own data: progress, high score and plane choice (set up by the game script)
  // The stats with a top 10. value() reads a profile; the server sends the rank in each.
  const stat = (p, k) => (p && p.stats && p.stats[k]) || 0;
  const CATS = {
    score:     { label: "best score",  value: (p) => p.score || 0 },
    blocks:    { label: "blocks",      value: (p) => stat(p, "blocks") },
    landmarks: { label: "landmarks",   value: (p) => stat(p, "landmarks") },
    near:      { label: "near misses", value: (p) => stat(p, "nearMisses") },
    runs:      { label: "runs",        value: (p) => stat(p, "runs") },
  };
  const BOARD_SIZE = 25;    // how many places the leaderboard shows
  let cat = "score";        // which leaderboard is showing
  let refreshSeq = 0;       // so a slow answer for an old pick can't overwrite a newer one

  const game = () => window.TowersData || { stats: () => ({}), best: () => 0, skin: () => "PROP", paint: () => "CLASSIC", vstats: () => ({}), merge() {} };

  const pad = (n) => String(n).padStart(5, "0");
  let els = null;
  let key = cleanKey(store.get(KEY_STORE));
  let me = null;            // own profile, once the Worker has confirmed the key
  let lastRun = null;
  let opener = null;
  let backAction = null;
  let armedTimer = null;
  let pwFirst = false;      // the password screen is setting a first password, so it needs no current one

  const $ = (id) => document.getElementById(id);
  const knownName = () => (me && me.name) || store.get(NAME_STORE) || "";
  const isMe = (name) => !!name && !!knownName() && name.toLowerCase() === knownName().toLowerCase();

  // ---------------- the leaderboard (it lives on the LEADERBOARD tab in the hangar) ----------------
  function note(list, text) {
    const li = document.createElement("li");
    li.className = "lb-empty";
    li.textContent = text;
    list.replaceChildren(li);
  }

  function renderList(list, scores, limit) {
    if (!scores.length) return note(list, cat === "score" ? "No scores yet. Set the first one." : "Nobody here yet. Play to take the first spot.");
    list.replaceChildren();
    scores.slice(0, limit).forEach((s, i) => {
      const li = document.createElement("li");
      li.dataset.name = s.name;
      li.tabIndex = 0;
      li.setAttribute("role", "button");
      const val = s.value !== undefined ? s.value : s.score;
      li.setAttribute("aria-label", "Profile of " + s.name + ", " + val + " " + CATS[cat].label);
      if (isMe(s.name)) li.className = "you";
      const rank = document.createElement("span");
      rank.className = "lb-rank";
      rank.textContent = i + 1 + ".";
      const who = document.createElement("span");
      who.className = "lb-name";
      who.textContent = s.name;
      const pts = document.createElement("span");
      pts.className = "lb-pts";
      pts.textContent = pad(val);
      li.append(rank, who, pts);
      list.appendChild(li);
    });
  }

  // Outside the top 25? Your own place goes under the list, after a gap.
  function addMine(list, scores) {
    els.hint.textContent = "";
    if (!key || !me || !scores.length) return;
    const mine = CATS[cat].value(me);
    if (!(mine > 0)) { els.hint.textContent = cat === "score" ? "SCORE A POINT TO GET A RANK." : "PLAY MORE TO GET A RANK."; return; }
    if (scores.some((s) => isMe(s.name))) return;
    const myRank = (me.ranks && me.ranks[cat]) || (cat === "score" ? me.rank : null);
    const gap = document.createElement("li");
    gap.className = "lb-gap";
    gap.textContent = "...";
    const li = document.createElement("li");
    li.className = "you lb-mine";
    li.dataset.name = me.name;
    li.tabIndex = 0;
    li.setAttribute("role", "button");
    li.setAttribute("aria-label", "Your profile, rank " + (myRank || "unknown") + ", " + mine + " " + CATS[cat].label);
    const rank = document.createElement("span");
    rank.className = "lb-rank";
    rank.textContent = (myRank || "?") + ".";
    const who = document.createElement("span");
    who.className = "lb-name";
    who.textContent = me.name;
    const pts = document.createElement("span");
    pts.className = "lb-pts";
    pts.textContent = pad(mine);
    li.append(rank, who, pts);
    list.append(gap, li);
  }

  function setCategory(c) {   // called by the game when a TOP 10 badge is tapped
    if (!CATS[c]) return;
    cat = c;
    if (els) els.cat.value = c;
  }

  async function refresh() {
    const seq = ++refreshSeq, want = cat;
    try {
      const scores = await backend.top(want);
      if (key) {   // your rank changes as others play, so ask again whenever the list is refreshed
        try { me = await backend.me(key); updateButtons(); } catch (e) { /* offline or signed out: the next real action sorts that out */ }
      }
      if (seq !== refreshSeq) return;   // the player has picked something else since
      els.list.setAttribute("aria-label", "Leaderboard: " + CATS[want].label);
      renderList(els.list, scores, BOARD_SIZE);
      addMine(els.list, scores.slice(0, BOARD_SIZE));   // only what's shown counts, however many the server sent
      store.set("towers-board-" + want, JSON.stringify(scores.slice(0, BOARD_SIZE)));
      els.hint.textContent = (els.hint.textContent + " " + waitingNote()).trim();
    } catch (e) {
      if (seq !== refreshSeq) return;
      let saved = null;
      try { saved = JSON.parse(store.get("towers-board-" + want) || "null"); } catch (x) { /* nothing saved */ }
      if (Array.isArray(saved) && saved.length) {   // offline, but you have seen this list before
        els.list.setAttribute("aria-label", "Leaderboard: " + CATS[want].label + " (last list you saw)");
        renderList(els.list, saved, BOARD_SIZE);
        els.hint.textContent = ("OFFLINE. THIS IS THE LAST LIST YOU SAW. " + waitingNote()).trim();
      } else note(els.list, "Leaderboard offline. Your HI still counts here.");
    }
  }

  function updateButtons() {
    els.acctBtn.textContent = knownName() ? knownName().toUpperCase() : "SIGN IN";
    els.hangarWho.textContent = "FLYING AS " + (key && knownName() ? knownName() : "GUEST");
    els.hangarWho.classList.toggle("in", !!(key && knownName()));
    els.create.hidden = !!key;
    els.boardCreate.hidden = !!key;
    els.who.hidden = !key;
    els.who.textContent = key ? knownName() + (me && me.rank ? "  -  RANK #" + me.rank : "") : "";
  }

  function setStatus(text) {
    els.status.textContent = text || "";
    els.status.hidden = !text;
  }

  // ---------------- session ----------------
  function setSession(newKey, profile) {
    key = newKey;
    me = profile;
    store.set(KEY_STORE, newKey);
    if (profile) store.set(NAME_STORE, profile.name);
    updateButtons();
    refresh();
    retryUpload();
  }

  function clearSession() {
    key = null;
    me = null;
    store.del(KEY_STORE);
    store.del(NAME_STORE);
    updateButtons();
    refresh();
  }

  // bring server progress (planes, HI, favourite plane) into this device
  function mergeIntoGame(profile, withChoice) {
    // the account's progress always comes across; its plane and color only when signing in, so reopening the app never undoes a pick made on this phone
    game().merge(Object.assign({ stats: profile.stats, vehicles: profile.vehicles, best: profile.score }, withChoice ? { skin: profile.skin, paint: profile.paint } : {}));
  }

  // ---------------- the account sheet ----------------
  const TITLES = { vAuth: "ACCOUNT", vCreate: "NEW ACCOUNT", vSignIn: "SIGN IN", vPassword: "PASSWORD", vProfile: "PROFILE", vEdit: "EDIT PROFILE" };

  function msg(text, bad) {
    els.msg.textContent = text || "";
    els.msg.classList.toggle("bad", !!bad);
  }

  function disarm() {
    clearTimeout(armedTimer);
    for (const b of els.armable) { if (b.dataset.label) { b.textContent = b.dataset.label; delete b.dataset.armed; } }
  }

  // two-tap confirmation for buttons that can't be undone
  function armed(btn, label, action) {
    btn.dataset.label = btn.dataset.label || btn.textContent;
    btn.addEventListener("click", () => {
      if (btn.dataset.armed) { disarm(); action(); return; }
      disarm();
      btn.dataset.armed = "1";
      btn.textContent = label;
      armedTimer = setTimeout(disarm, 4000);
    });
  }

  let viewSeq = 0;   // changes whenever the sheet changes view or closes, so a slow answer can tell it is out of date
  function show(view, back) {
    viewSeq++;
    disarm();
    for (const v of Object.keys(TITLES)) els[v].hidden = v !== view;
    for (const b of els.sheet.querySelectorAll(".pw-eye")) { const i = b.previousElementSibling; if (i.type === "text") b.click(); }
    els.title.textContent = TITLES[view];
    backAction = back || closeSheet;
    els.back.textContent = view === "vEdit" ? "CANCEL" : "BACK";
    els.sheet.scrollTop = 0;
  }

  function openSheet() {
    if (els.sheet.hidden) opener = document.activeElement;
    els.sheet.hidden = false;
    window.TowersUI.open = true;
  }

  function closeSheet() {
    viewSeq++;
    disarm();
    els.sheet.hidden = true;
    window.TowersUI.open = false;
    msg("");
    if (opener && opener.focus) opener.focus();
  }

  function showAuth() {
    openSheet();
    msg("");
    show("vAuth");
  }

  function showCreate() {
    msg("");
    els.newName.value = "";
    show("vCreate", showAuth);
    els.newName.focus();
  }

  function showSignIn() {
    msg("");
    els.nameIn.value = knownName() || "";
    els.keyIn.value = "";
    show("vSignIn", showAuth);
    (els.nameIn.value ? els.keyIn : els.nameIn).focus();
  }

  // choose a first password (accounts from before passwords, or after an admin reset) or change it
  function showPassword(firstTime) {
    openSheet();
    msg("");
    pwFirst = !!firstTime;
    els.curPw.value = "";
    els.setPw.value = "";
    els.curPw.closest(".pw-wrap").hidden = pwFirst;
    els.pwNote.textContent = pwFirst
      ? "YOU SIGNED IN WITH A TEMPORARY PASSWORD. PICK ONE YOU'LL REMEMBER. YOU'LL USE IT WITH YOUR NAME TO SIGN IN ON ANY PHONE."
      : "ENTER YOUR CURRENT PASSWORD, THEN THE NEW ONE. MADE YOUR ACCOUNT BEFORE PASSWORDS? YOUR OLD KEY IS YOUR CURRENT PASSWORD.";
    show("vPassword", () => (me ? showProfile(me, true) : closeSheet()));
    (pwFirst ? els.setPw : els.curPw).focus();
  }

  function sinceText(sec) {
    if (!sec) return "-";
    return new Date(sec * 1000).toLocaleDateString(undefined, { month: "short", year: "numeric" }).toUpperCase();
  }

  // A gold TOP 10 button beside a stat; tapping it opens that stat's top 10.
  function setValue(dd, text, catId, rank) {
    dd.replaceChildren(document.createTextNode(text));
    if (!catId || !rank || rank > BOARD_SIZE) return false;
    const b = document.createElement("button");
    b.type = "button";
    b.className = "badge";
    b.dataset.cat = catId;
    b.textContent = "TOP " + BOARD_SIZE + " #" + rank;
    b.setAttribute("aria-label", "Leaderboard in " + CATS[catId].label + ", rank " + rank + ". Show that leaderboard.");
    dd.appendChild(b);
    return true;
  }

  function renderStats(p) {
    const st = p.stats || {}, ranks = p.ranks || {};
    const rows = [
      ["RUNS", st.runs, "runs"], ["BLOCKS", st.blocks, "blocks"], ["LANDMARKS", st.landmarks, "landmarks"],
      ["NEAR MISSES", st.nearMisses, "near"], ["BEST COMBO", st.bestCombo > 1 ? "X" + st.bestCombo : 0, null],
    ];
    els.pStatList.replaceChildren();
    let badges = setValue(els.pBest, p.score > 0 ? pad(p.score) : "-", "score", ranks.score || p.rank);
    for (const [label, v, catId] of rows) {
      const div = document.createElement("div");
      const dt = document.createElement("dt");
      const dd = document.createElement("dd");
      dt.textContent = label;
      badges = setValue(dd, v ? String(v) : "-", catId, catId && ranks[catId]) || badges;
      div.append(dt, dd);
      els.pStatList.appendChild(div);
    }
    els.pLegend.hidden = !badges;
  }

  function showProfile(p, self, back) {
    openSheet();
    msg("");
    els.pName.textContent = p.name;
    els.pSkin.textContent = p.skin;
    els.pPaint.textContent = p.paint || "CLASSIC";
    els.pRank.textContent = p.rank ? "#" + p.rank : "-";
    els.pSince.textContent = sinceText(p.since);
    renderStats(p);
    els.pBio.textContent = p.bio || (self ? "No bio yet. Tell people about yourself." : "No bio yet.");
    els.pBio.classList.toggle("empty", !p.bio);
    els.selfRow.hidden = !self;
    show("vProfile", back);
    if (self && p.mustSetPassword) msg("You're using a temporary password. Tap PASSWORD to pick your own.");
  }

  async function openProfile(name, back) {
    openSheet();
    msg("Loading…");
    show("vProfile", back);
    els.selfRow.hidden = true;
    for (const id of ["pName", "pSkin", "pPaint", "pBest", "pRank", "pSince", "pBio"]) els[id].textContent = "";
    els.pStatList.replaceChildren();
    els.pLegend.hidden = true;
    const seq = viewSeq;   // if the player taps away before the answer comes, it must not pop the profile back open
    try {
      let p = null, self = false;
      if (isMe(name) && key) {
        try { me = await backend.me(key); p = me; self = true; } catch (e) {
          if (e.status === 401) { if (seq === viewSeq) signedOutByServer(); return; }
        }
      }
      if (!p) p = await backend.profile(name);
      if (seq !== viewSeq) return;
      showProfile(p, self, back);
    } catch (e) {
      if (seq === viewSeq) msg(e.message, true);
    }
  }

  function signedOutByServer() {
    clearSession();
    showAuth();
    msg("This device was signed out. Sign in again.", true);
  }

  async function createAccount() {
    const name = els.newName.value.trim();
    if (!NAME_PATTERN.test(name)) return msg("Name must be 3-12 letters, numbers, - or _.", true);
    const password = els.newPw.value;
    if (password.length < 6) return msg("Password must be at least 6 characters.", true);
    els.doCreate.disabled = true;
    msg("Creating…");
    try {
      const g = game();
      const res = await backend.signup({
        username: name,
        password,
        importScore: g.best() > 0 ? g.best() : undefined,
        stats: g.stats(),
        vehicles: g.vstats(),
        skin: g.skin(),
        paint: g.paint(),
      });
      setSession(cleanKey(res.key), res.profile);
      mergeIntoGame(res.profile, true);
      showProfile(res.profile, true);
      msg(res.note || "Account created. Sign in with your name and password on any phone.");
    } catch (e) {
      msg(e.message, true);
    }
    els.doCreate.disabled = false;
  }

  async function signIn() {
    const name = els.nameIn.value.trim();
    const password = els.keyIn.value;
    if (!NAME_PATTERN.test(name) || !password) return msg("Enter your name and password.", true);
    els.doSignIn.disabled = true;
    msg("Signing in…");
    try {
      const res = await backend.login({ username: name, password });
      res.profile.mustSetPassword = !!res.mustSetPassword;
      setSession(cleanKey(res.key), res.profile);
      mergeIntoGame(res.profile, true);
      if (res.mustSetPassword) showPassword(true);
      else { showProfile(res.profile, true); msg("Signed in. Your planes and high score came with you."); }
    } catch (e) {
      msg(e.message, true);
    }
    els.doSignIn.disabled = false;
  }

  async function savePassword() {
    const password = els.setPw.value;
    if (password.length < 6) return msg("Password must be at least 6 characters.", true);
    if (!pwFirst && !els.curPw.value) return msg("Enter your current password.", true);
    els.savePw.disabled = true;
    msg("Saving…");
    try {
      await backend.setPassword(key, pwFirst ? { password } : { current: els.curPw.value, password });
      if (me) me.mustSetPassword = false;
      showProfile(me, true);
      msg("Password saved. Sign in with your name and this password on any phone.");
    } catch (e) {
      if (e.status === 401 && pwFirst) signedOutByServer(); else msg(e.message, true);
    }
    els.savePw.disabled = false;
  }

  async function saveBio() {
    const newName = els.renameIn.value.trim();
    const renaming = !!me && newName !== me.name;
    if (renaming && !NAME_PATTERN.test(newName)) return msg("Name must be 3-12 letters, numbers, - or _.", true);
    els.saveBio.disabled = true;
    msg("Saving…");
    try {
      if (renaming) {
        const old = me.name;
        me = await backend.rename(key, newName);
        store.set(NAME_STORE, me.name);
        writeBox(readBox().map((e) => (sameName(e.name, old) ? Object.assign(e, { name: me.name }) : e)));   // runs waiting to upload follow the new name
        updateButtons();
        refresh();
        await new Promise((r) => setTimeout(r, 2100));   // the server wants a short gap between edits
      }
      if (els.bioIn.value !== (me.bio || "")) me = await backend.saveProfile(key, { bio: els.bioIn.value, skin: game().skin(), paint: game().paint() });
      showProfile(me, true);
      msg("Saved.");
    } catch (e) {
      if (e.status === 401) signedOutByServer(); else msg(e.message, true);
    }
    els.saveBio.disabled = false;
  }

  async function deleteAccount() {
    const gone = knownName();
    try {
      await backend.remove(key);
      writeBox(readBox().filter((e) => !sameName(e.name, gone)));   // runs waiting for a deleted account have nowhere to go
      clearSession();
      closeSheet();
      setStatus("Account deleted.");
    } catch (e) {
      if (e.status === 401) signedOutByServer(); else msg(e.message, true);
    }
  }

  // ---------------- runs played offline wait on the phone ----------------
  // Every finished run goes in the outbox first and is uploaded from there, so a run played with no signal is kept and
  // counted later. A batch keeps its id until the server has confirmed it, so a retry can never count a run twice.
  const BOX_KEY = "towers-outbox", BOX_MAX = 100, CHUNK = 25;
  const readBox = () => { try { const b = JSON.parse(store.get(BOX_KEY) || "[]"); return Array.isArray(b) ? b : []; } catch (e) { return []; } };
  const writeBox = (b) => store.set(BOX_KEY, JSON.stringify(b.slice(-BOX_MAX)));
  const sameName = (a, b) => !!a && !!b && String(a).toLowerCase() === String(b).toLowerCase();
  const newId = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  const waiting = () => readBox().filter((e) => sameName(e.name, knownName())).length;
  const dropFromBox = (ids) => { const gone = new Set(ids); writeBox(readBox().filter((e) => !gone.has(e.id))); };
  let flushing = null, retryTimer = null;

  function addToOutbox(run) {
    const box = readBox();
    box.push({ id: newId(), name: knownName(), score: run.score, durationMs: run.durationMs, run: run.run, skin: run.skin });
    writeBox(box);
  }

  // Uploads what is waiting for the account that is signed in, oldest first. Resolves with what happened.
  function flush() {
    if (flushing) return flushing;
    flushing = (async () => {
      const out = { sent: 0, offline: false, signedOut: false, latestReason: null, error: null };
      let tooSoon = 0;
      if (typeof navigator !== "undefined" && navigator.onLine === false) { out.offline = true; return out; }
      for (let guard = 0; guard < 30 && key; guard++) {
        const box = readBox(), mine = box.filter((e) => sameName(e.name, knownName()));
        if (!mine.length) break;
        const started = mine.find((e) => e.batch);                       // a batch that was sent but not confirmed goes again, as it was
        const id = started ? started.batch : newId();
        const chunk = started ? mine.filter((e) => e.batch === id) : mine.slice(0, CHUNK);
        if (!started) { for (const e of chunk) e.batch = id; writeBox(box); }
        const g = game();
        try {
          const res = await backend.runs(key, {
            batchId: id, runs: chunk.map((e) => ({ score: e.score, durationMs: e.durationMs, run: e.run, skin: e.skin })), skin: g.skin(), paint: g.paint(),
          });
          dropFromBox(chunk.map((e) => e.id));
          out.sent += chunk.length;
          if (res.profile) me = res.profile;
          if (Array.isArray(res.rejected) && res.rejected.length) out.latestReason = res.rejected[res.rejected.length - 1];
        } catch (e) {
          if (e.status === 429) { if (tooSoon++ < 2) { await new Promise((r) => setTimeout(r, 2200)); continue; } out.offline = true; break; }
          if (e.status === 401) { out.signedOut = true; break; }                       // they stay for the next sign-in
          if (e.offline || !e.status || e.status >= 500) { out.offline = true; break; }  // try again later
          dropFromBox(chunk.map((x) => x.id));                                         // refused outright: don't let it block the rest
          out.error = e.message;
        }
      }
      return out;
    })().finally(() => { flushing = null; });
    return flushing;
  }

  function scheduleRetry() {
    clearTimeout(retryTimer);
    if (key && waiting()) retryTimer = setTimeout(retryUpload, 45000);
  }

  // when the connection comes back, the app is reopened, or someone signs in: send what is waiting
  async function retryUpload() {
    if (!key || !waiting()) return;
    const out = await flush();
    if (out.signedOut) { clearSession(); setStatus("Signed out. Sign in again to save scores."); return; }
    if (out.offline) { scheduleRetry(); return; }
    if (out.sent) { updateButtons(); setStatus("Uploaded " + out.sent + " run" + (out.sent === 1 ? "" : "s") + " played offline."); }
    refresh();
  }

  const waitingNote = () => { const n = waiting(); return n ? n + " RUN" + (n === 1 ? "" : "S") + " WAITING TO UPLOAD." : ""; };

  // ---------------- game over ----------------
  async function onGameOver(run) {
    if (!els) init();
    lastRun = run;
    setStatus("");
    updateButtons();
    if (key && knownName()) {
      addToOutbox(run);
      const out = await flush();
      const n = waiting();
      if (out.signedOut) { clearSession(); setStatus("Signed out. Sign in again to save scores."); }
      else if (out.offline) {
        setStatus("Offline. " + (n === 1 ? "This run is" : n + " runs are") + " saved on this phone and will upload when you're back online.");
        scheduleRetry();
      } else if (out.error) setStatus(out.error);
      else if (out.latestReason) setStatus(out.latestReason);
      else {
        const parts = [];
        if (run.isNewBest && run.score > 0) parts.push("Score saved");
        if (out.sent > 1) parts.push("Uploaded " + (out.sent - 1) + " earlier run" + (out.sent === 2 ? "" : "s") + " played offline");
        setStatus(parts.join(". "));
        updateButtons();
      }
    }
    refresh();
  }

  // ---------------- setup ----------------
  function init() {
    if (els) return;
    els = {
      list: $("lbList"), create: $("lbCreate"), who: $("lbWho"), status: $("lbStatus"), acctBtn: $("acctBtn"),
      boardCreate: $("boardCreate"), hint: $("boardHint"), hangarWho: $("hangarWho"), goCreate: $("goCreate"), goSignIn: $("goSignIn"),
      sheet: $("sheet"), title: $("sheetTitle"), msg: $("sheetMsg"), back: $("sheetBack"),
      vAuth: $("vAuth"), vCreate: $("vCreate"), vSignIn: $("vSignIn"), vPassword: $("vPassword"), vProfile: $("vProfile"), vEdit: $("vEdit"),
      newName: $("newName"), newPw: $("newPw"), doCreate: $("doCreate"), nameIn: $("nameIn"), keyIn: $("keyIn"), doSignIn: $("doSignIn"),
      pwNote: $("pwNote"), curPw: $("curPw"), setPw: $("setPw"), savePw: $("savePw"),
      cat: $("boardCat"), pStatList: $("pStatList"), pLegend: $("pLegend"),
      pName: $("pName"), pSkin: $("pSkin"), pPaint: $("pPaint"), pBest: $("pBest"), pRank: $("pRank"), pSince: $("pSince"), pBio: $("pBio"),
      selfRow: $("selfRow"), editBio: $("editBio"), showKey: $("showKey"), signOut: $("signOut"), delAcct: $("delAcct"),
      bioIn: $("bioIn"), bioCount: $("bioCount"), saveBio: $("saveBio"), renameIn: $("renameIn"),
    };
    els.armable = [els.delAcct];

    // a SHOW / HIDE button beside every password box, so a typo can be seen before it locks someone out
    for (const input of [els.newPw, els.keyIn, els.curPw, els.setPw]) {
      const wrap = document.createElement("div");
      wrap.className = "pw-wrap";
      input.replaceWith(wrap);
      const eye = document.createElement("button");
      eye.type = "button";
      eye.className = "pw-eye";
      eye.textContent = "SHOW";
      eye.setAttribute("aria-label", "Show password");
      eye.addEventListener("click", () => {
        const showing = input.type === "text";
        input.type = showing ? "password" : "text";
        eye.textContent = showing ? "SHOW" : "HIDE";
        eye.setAttribute("aria-label", showing ? "Show password" : "Hide password");
      });
      wrap.append(input, eye);
    }

    els.acctBtn.addEventListener("click", () => (key && knownName() ? openProfile(knownName()) : showAuth()));
    els.create.addEventListener("click", showAuth);
    els.boardCreate.addEventListener("click", showAuth);
    els.goCreate.addEventListener("click", showCreate);
    els.goSignIn.addEventListener("click", showSignIn);
    els.back.addEventListener("click", () => backAction());
    els.doCreate.addEventListener("click", createAccount);
    els.doSignIn.addEventListener("click", signIn);
    const onEnter = (input, action) => input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); action(); } });
    onEnter(els.newName, () => els.newPw.focus());
    onEnter(els.newPw, createAccount);
    onEnter(els.nameIn, () => els.keyIn.focus());
    onEnter(els.keyIn, signIn);
    onEnter(els.curPw, () => els.setPw.focus());
    onEnter(els.setPw, savePassword);
    onEnter(els.renameIn, () => els.bioIn.focus());
    els.savePw.addEventListener("click", savePassword);
    els.saveBio.addEventListener("click", saveBio);
    els.editBio.addEventListener("click", () => {
      els.renameIn.value = me ? me.name : knownName() || "";
      els.bioIn.value = me ? me.bio : "";
      els.bioCount.textContent = els.bioIn.value.length + "/80";
      msg("");
      show("vEdit", () => showProfile(me, true));
      els.bioIn.focus();
    });
    els.bioIn.addEventListener("input", () => { els.bioCount.textContent = els.bioIn.value.length + "/80"; });
    els.showKey.addEventListener("click", () => showPassword(!!(me && me.mustSetPassword)));
    els.signOut.addEventListener("click", () => {
      if (key) backend.logout(key).catch(() => {});   // ends this device's sign-in on the server too; offline is fine
      clearSession(); closeSheet(); setStatus("Signed out.");
    });
    armed(els.delAcct, "TAP AGAIN TO DELETE", deleteAccount);

    // keep typing and taps in the sheet away from the game
    els.sheet.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Escape") closeSheet();
    });

    const openFromList = (e) => {
      const li = e.target.closest("li[data-name]");
      if (li) openProfile(li.dataset.name);   // the profile opens over the hangar; BACK returns to it
    };
    window.addEventListener("online", retryUpload);
    document.addEventListener("visibilitychange", () => { if (!document.hidden) retryUpload(); });
    retryUpload();   // runs left from the last time the app was open
    els.cat.addEventListener("change", () => { cat = CATS[els.cat.value] ? els.cat.value : "score"; refresh(); });
    els.vProfile.addEventListener("click", (e) => {   // TOP 10 badge: close the profile and show that board
      const b = e.target.closest("button.badge");
      if (!b) return;
      closeSheet();
      if (game().showBoard) game().showBoard(b.dataset.cat);
    });
    els.list.addEventListener("click", openFromList);
    els.list.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); openFromList(e); } });

    updateButtons();
    refresh();
    if (key) {
      backend.me(key).then(
        (profile) => {
          me = profile; store.set(NAME_STORE, profile.name); mergeIntoGame(profile); updateButtons(); refresh();
        },
        (e) => { if (e.status === 401) clearSession(); } // offline: keep the key and try again next time
      );
    }
  }

  window.Leaderboard = { onGameOver, refresh, setCategory, flush, waiting };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
