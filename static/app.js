"use strict";

/* ================================================================ Утилиты */

const $app = document.getElementById("app");
const PARTICIPANT_KEY = "fk_participant";
const ROLE_NAMES = {
  specialist: "Специалист МК",
  site_admin: "Администратор площадки",
  college_admin: "Администратор колледжа",
  system_admin: "Администратор системы",
};

const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmtTime = s => s ? new Date(s).toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "";
const siteLabel = s => [s.name, s.floor && `этаж ${s.floor}`, s.room && `каб. ${s.room}`].filter(Boolean).join(" · ");
const nameOr = (n, fallback = "Без имени") => n && n.trim() ? n : fallback;

function storage(key, value) {
  try {
    if (value === undefined) return localStorage.getItem(key);
    if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, value);
  } catch { return null; }
}

function toast(msg, isError = false) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.classList.toggle("error", isError);
  t.classList.add("show");
  clearTimeout(t._h);
  t._h = setTimeout(() => t.classList.remove("show"), 3000);
}

async function api(method, url, body, headers = {}) {
  const res = await fetch(url, {
    method,
    credentials: "same-origin",
    headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { /* пустой ответ */ }
  if (!res.ok) {
    let msg = data && data.detail;
    if (Array.isArray(msg)) msg = msg.map(d => d.msg).join("; ");
    const err = new Error(msg || `Ошибка ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

// Обёртка для обработчиков: показывает ошибку тостом
const guard = fn => async (...a) => { try { await fn(...a); } catch (e) { toast(e.message, true); } };

function formData(form) {
  return Object.fromEntries([...new FormData(form)].map(([k, v]) => [k, typeof v === "string" ? v.trim() : v]));
}

function downloadCsv(name, header, rows) {
  const cell = v => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const text = "﻿" + [header, ...rows].map(r => r.map(cell).join(";")).join("\r\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// Периодическое обновление текущего экрана; сбрасывается при смене экрана
let refreshTimer = null;
function setRefresh(fn, ms) {
  clearInterval(refreshTimer);
  refreshTimer = fn ? setInterval(() => { if (!document.hidden) fn(); }, ms) : null;
}

/* ================================================================ Камера и распознавание QR */

const Camera = {
  stream: null,
  canvas: document.getElementById("canvas"),
  ctx: null,
  onCode: null,
  video: null,
  viewer: null,

  decode(w, h) {
    const image = this.ctx.getImageData(0, 0, w, h);
    return jsQR(image.data, w, h, { inversionAttempts: "attemptBoth" });
  },

  async start(video, viewer, onCode) {
    this.stop();
    this.ctx ||= this.canvas.getContext("2d", { willReadFrequently: true });
    this.video = video; this.viewer = viewer; this.onCode = onCode;
    this.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false });
    video.srcObject = this.stream;
    await video.play();
    viewer.classList.add("active");
    requestAnimationFrame(() => this.tick());
  },

  tick() {
    if (!this.stream) return;
    const v = this.video;
    if (v.readyState === v.HAVE_ENOUGH_DATA) {
      this.canvas.width = v.videoWidth;
      this.canvas.height = v.videoHeight;
      this.ctx.drawImage(v, 0, 0, this.canvas.width, this.canvas.height);
      const code = this.decode(this.canvas.width, this.canvas.height);
      if (code) {
        const cb = this.onCode;
        this.stop();
        cb(code.data);
        return;
      }
    }
    requestAnimationFrame(() => this.tick());
  },

  stop() {
    if (this.stream) this.stream.getTracks().forEach(t => t.stop());
    this.stream = null;
    if (this.video) this.video.srcObject = null;
    if (this.viewer) this.viewer.classList.remove("active");
  },

  fromFile(file) {
    return new Promise((resolve, reject) => {
      this.ctx ||= this.canvas.getContext("2d", { willReadFrequently: true });
      const img = new Image();
      img.onload = () => {
        this.canvas.width = img.naturalWidth;
        this.canvas.height = img.naturalHeight;
        this.ctx.drawImage(img, 0, 0);
        URL.revokeObjectURL(img.src);
        const code = this.decode(this.canvas.width, this.canvas.height);
        code ? resolve(code.data) : reject(new Error("На картинке не найден QR-код"));
      };
      img.onerror = () => reject(new Error("Не удалось открыть картинку"));
      img.src = URL.createObjectURL(file);
    });
  },
};

/* ================================================================ Старт */

async function boot() {
  // Ссылка восстановления участника: https://…/#p=<secret>
  const m = location.hash.match(/p=([\w-]+)/);
  if (m) {
    storage(PARTICIPANT_KEY, m[1]);
    history.replaceState(null, "", location.pathname);
  }
  try {
    const me = await api("GET", "/api/me");
    return renderStaff(me);
  } catch (e) {
    if (e.status !== 401) console.error(e);
  }
  if (storage(PARTICIPANT_KEY)) return renderParticipant();
  renderStart();
}

function renderStart() {
  setRefresh(null);
  Camera.stop();
  $app.innerHTML = `
    <div class="wrap narrow" style="padding-top:32px">
      <h1 class="center">ФК — QR</h1>
      <p class="hint center">Баллы за посещение мастер-классов</p>
      <div class="card center">
        <h2 style="justify-content:center">Я участник</h2>
        <p class="hint">Получите личный QR-код и показывайте его специалисту на каждом мастер-классе.</p>
        <button class="block" id="becomeParticipant">Получить мой QR-код</button>
      </div>
      <form class="card stack" id="loginForm">
        <h2>Вход для организаторов</h2>
        <label class="f">Логин<input name="login" autocomplete="username" required></label>
        <label class="f">Пароль<input name="password" type="password" autocomplete="current-password" required></label>
        <button class="block">Войти</button>
      </form>
    </div>`;
  document.getElementById("becomeParticipant").onclick = guard(async () => {
    const p = await api("POST", "/api/participant/register");
    storage(PARTICIPANT_KEY, p.secret);
    renderParticipant();
  });
  document.getElementById("loginForm").onsubmit = guard(async e => {
    e.preventDefault();
    await api("POST", "/api/auth/login", formData(e.target));
    renderStaff(await api("GET", "/api/me"));
  });
}

/* ================================================================ Участник */

async function renderParticipant() {
  const token = storage(PARTICIPANT_KEY);
  let data;
  try {
    data = await api("GET", "/api/participant/me", null, { "X-Participant-Token": token });
  } catch (e) {
    if (e.status === 404 || e.status === 401) { storage(PARTICIPANT_KEY, null); return renderStart(); }
    $app.innerHTML = `<div class="wrap narrow"><div class="card center">Нет связи с сервером: ${esc(e.message)}<br><br><button onclick="location.reload()">Повторить</button></div></div>`;
    return;
  }
  const restore = `${location.origin}/#p=${token}`;
  const visits = data.visits.length ? data.visits.map(v => `
      <div class="list-item">
        <div class="grow"><b>${esc(v.name)}</b><div class="muted">${esc([v.floor && `этаж ${v.floor}`, v.room && `каб. ${v.room}`, v.college_name].filter(Boolean).join(" · "))}</div></div>
        ${v.points ? '<span class="pill ok">+1 балл</span>' : '<span class="pill muted">без балла</span>'}
      </div>`).join("") : '<div class="empty">Вы пока не посетили ни одной площадки</div>';

  $app.innerHTML = `
    <header class="bar"><div class="wrap narrow">
      <span class="brand">ФК — QR</span><span class="who"><b>${esc(nameOr(data.full_name, "Участник"))}</b><br>${esc(data.institution)}</span>
      <button class="ghost" id="pLogout">Выйти</button>
    </div></header>
    <div class="wrap narrow">
      <div class="card center">
        <p class="hint" style="margin:0">Покажите этот код специалисту мастер-класса</p>
        <img class="qr" src="/api/participant/qr.svg?t=${encodeURIComponent(token)}" alt="Мой QR-код">
        <div class="code">${esc(data.code)}</div>
        ${data.full_name ? "" : '<p class="hint" style="margin:8px 0 0">ФИО и учебное заведение впишет специалист при первом сканировании</p>'}
      </div>
      <div class="card center">
        <div class="muted">Начислено баллов</div>
        <div class="bigpts">${data.total_points}</div>
        <div class="muted">площадок посещено: ${data.visits.length}</div>
      </div>
      <div class="card"><h2>Посещённые площадки</h2>${visits}</div>
      <div class="card">
        <h3>Не потеряйте свой QR-код</h3>
        <p class="hint" style="margin-bottom:8px">Код хранится в этом браузере. Сохраните ссылку — по ней код откроется на любом устройстве.</p>
        <button class="secondary block" id="copyLink">Скопировать ссылку</button>
      </div>
    </div>`;
  document.getElementById("copyLink").onclick = async () => {
    try { await navigator.clipboard.writeText(restore); toast("Ссылка скопирована"); }
    catch { prompt("Скопируйте ссылку:", restore); }
  };
  document.getElementById("pLogout").onclick = () => {
    if (!confirm("Выйти? Без сохранённой ссылки вернуть этот QR-код будет нельзя.")) return;
    storage(PARTICIPANT_KEY, null);
    renderStart();
  };
  setRefresh(async () => {
    try {
      const fresh = await api("GET", "/api/participant/me", null, { "X-Participant-Token": token });
      if (fresh.total_points !== data.total_points || fresh.visits.length !== data.visits.length || fresh.full_name !== data.full_name) renderParticipant();
    } catch { /* офлайн — попробуем позже */ }
  }, 8000);
}

/* ================================================================ Сотрудник: каркас */

let ME = null;

const TABS = {
  specialist: [["scanner", "Сканер"]],
  site_admin: [["scanner", "Сканер"], ["staff", "Специалисты"], ["participants", "Участники"]],
  college_admin: [["overview", "Обзор"], ["scanner", "Сканер"], ["sites", "Площадки"], ["users", "Пользователи"], ["rating", "Рейтинг"]],
  system_admin: [["overview", "Обзор"], ["scanner", "Сканер"], ["colleges", "Колледжи"], ["sites", "Площадки"], ["users", "Пользователи"], ["rating", "Рейтинг"]],
};

function renderStaff(me) {
  ME = me;
  const place = me.site ? siteLabel(me.site) : me.college ? me.college.name : "";
  $app.innerHTML = `
    <header class="bar">
      <div class="wrap">
        <span class="brand">ФК — QR</span>
        <span class="who"><b>${esc(nameOr(me.full_name, me.login))}</b> · ${esc(me.role_name)}<br>${esc(place)}</span>
        <button class="ghost" id="pwdBtn">Пароль</button>
        <button class="ghost" id="logoutBtn">Выйти</button>
      </div>
      <div class="wrap" style="padding-top:0;padding-bottom:0"><nav class="tabs" id="tabs">
        ${TABS[me.role].map(([id, title]) => `<button data-tab="${id}">${title}</button>`).join("")}
      </nav></div>
    </header>
    <main class="wrap" id="view"></main>`;
  document.getElementById("logoutBtn").onclick = guard(async () => {
    Camera.stop();
    await api("POST", "/api/auth/logout");
    ME = null;
    renderStart();
  });
  document.getElementById("pwdBtn").onclick = guard(async () => {
    const old_password = prompt("Текущий пароль:");
    if (!old_password) return;
    const new_password = prompt("Новый пароль (не короче 6 символов):");
    if (!new_password) return;
    await api("POST", "/api/me/password", { old_password, new_password });
    toast("Пароль изменён");
  });
  document.getElementById("tabs").onclick = e => {
    const b = e.target.closest("button[data-tab]");
    if (b) openTab(b.dataset.tab);
  };
  const saved = storage("fk_tab");
  openTab(TABS[me.role].some(([id]) => id === saved) ? saved : TABS[me.role][0][0]);
}

function openTab(id, arg) {
  Camera.stop();
  setRefresh(null);
  storage("fk_tab", id);
  document.querySelectorAll("#tabs button").forEach(b => b.classList.toggle("active", b.dataset.tab === id));
  const view = document.getElementById("view");
  view.onclick = null;
  view.innerHTML = '<div class="empty">Загрузка…</div>';
  const screens = {
    overview: renderOverview,
    scanner: renderScanner,
    staff: v => renderSiteStaff(v, ME.site_id),
    participants: v => renderSiteParticipants(v, ME.site_id),
    colleges: renderColleges,
    sites: renderSites,
    users: renderUsers,
    rating: renderRating,
    site: v => renderSiteDetail(v, arg),
  };
  guard(async () => {
    try { await screens[id](view); }
    catch (e) {
      if (e.status === 401) { toast("Сессия истекла, войдите снова", true); return renderStart(); }
      view.innerHTML = `<div class="card bad">${esc(e.message)}</div>`;
    }
  })();
}

/* ================================================================ Сканер */

async function renderScanner(view) {
  const multi = ME.role === "college_admin" || ME.role === "system_admin";
  let sites = [], siteId = ME.site_id;
  if (multi) {
    sites = await api("GET", "/api/sites");
    if (!sites.length) {
      view.innerHTML = '<div class="card empty">Сначала создайте площадку во вкладке «Площадки»</div>';
      return;
    }
    const saved = Number(storage("fk_scan_site"));
    siteId = sites.some(s => s.id === saved) ? saved : sites[0].id;
  }
  const site = multi ? sites.find(s => s.id === siteId) : ME.site;

  view.innerHTML = `
    <div class="grid2">
      <div>
        <div class="card">
          ${multi ? `<label class="f" style="margin-bottom:12px">Площадка
            <select id="siteSel">${sites.map(s => `<option value="${s.id}" ${s.id === siteId ? "selected" : ""}>${esc(siteLabel(s))}${ME.role === "system_admin" ? " — " + esc(s.college_name) : ""}</option>`).join("")}</select></label>`
            : `<h2>${esc(siteLabel(site))}</h2>`}
          <div class="viewer" id="viewer"><video id="video" playsinline muted></video><div class="frame"></div></div>
          <div class="stack">
            <button class="block" id="scanBtn">Сканировать QR-код</button>
            <div class="row">
              <button class="secondary" id="fileBtn" style="flex:1">Из картинки</button>
              <button class="secondary" id="manualBtn" style="flex:1">Ввести код</button>
            </div>
          </div>
          <input id="fileInput" type="file" accept="image/*" hidden>
          <p id="status"></p>
          <div id="result"></div>
        </div>
      </div>
      <div>
        <div class="card">
          <h2>Посетили площадку <span class="pill info" id="visitCount">0</span><span class="sp"></span>
            <span class="muted" id="pointsCount"></span></h2>
          <input id="search" placeholder="Поиск по ФИО, учебному заведению, коду" style="margin:0 0 8px">
          <div id="visitList"><div class="empty">Загрузка…</div></div>
        </div>
      </div>
    </div>`;

  const statusEl = view.querySelector("#status");
  const resultEl = view.querySelector("#result");
  const scanBtn = view.querySelector("#scanBtn");
  const setStatus = (t, err = false) => { statusEl.textContent = t; statusEl.classList.toggle("error", err); };
  let visits = [];

  if (multi) view.querySelector("#siteSel").onchange = e => { storage("fk_scan_site", e.target.value); openTab("scanner"); };

  async function loadVisits() {
    visits = await api("GET", `/api/sites/${siteId}/visits`);
    drawVisits();
  }

  function drawVisits() {
    const q = view.querySelector("#search").value.trim().toLowerCase();
    const list = visits.filter(v => !q || [v.full_name, v.institution, v.code].join(" ").toLowerCase().includes(q));
    view.querySelector("#visitCount").textContent = visits.length;
    view.querySelector("#pointsCount").textContent = `баллов выдано: ${visits.filter(v => v.points).length}`;
    view.querySelector("#visitList").innerHTML = list.length ? list.map(v => `
      <div class="list-item">
        <div class="grow">
          <b>${esc(nameOr(v.full_name))}</b>
          <div class="muted">${esc(v.institution || "—")} · ${esc(v.code)} · ${fmtTime(v.scanned_at)}</div>
          ${v.points ? `<div class="muted">балл начислил: ${esc(v.awarded_by_name || "—")}, ${fmtTime(v.awarded_at)}</div>` : ""}
        </div>
        ${v.points ? '<span class="pill ok">1 балл</span>' : `<button class="sm ok" data-award="${v.id}">+1 балл</button>`}
      </div>`).join("") : `<div class="empty">${visits.length ? "Ничего не найдено" : "Пока никто не отсканирован"}</div>`;
  }

  view.querySelector("#search").oninput = drawVisits;
  view.querySelector("#visitList").onclick = guard(async e => {
    const b = e.target.closest("[data-award]");
    if (!b) return;
    b.disabled = true;
    await api("POST", `/api/visits/${b.dataset.award}/award`);
    toast("Балл начислен");
    await loadVisits();
  });

  function showResult(r) {
    const v = r.visit;
    const header = r.already_visited ? '<span class="pill warn">Уже отмечен ранее</span>' : '<span class="pill info">Новый посетитель</span>';
    resultEl.innerHTML = `
      <div class="result ${v.points ? "done" : ""}">
        <div class="row" style="align-items:center;margin-bottom:8px">${header}<span class="muted" style="text-align:right">${esc(v.code)}</span></div>
        <form id="pForm" class="stack" ${r.needs_info ? "" : "hidden"}>
          <label class="f">ФИО участника<input name="full_name" value="${esc(v.full_name)}" required maxlength="200" autocomplete="off"></label>
          <label class="f">Колледж / школа<input name="institution" value="${esc(v.institution)}" maxlength="300" autocomplete="off"></label>
          <button class="block">Сохранить данные</button>
        </form>
        <div id="pInfo" ${r.needs_info ? "hidden" : ""}>
          <div style="font-size:18px;font-weight:700">${esc(nameOr(v.full_name))}</div>
          <div class="muted">${esc(v.institution || "учебное заведение не указано")}</div>
          <button class="ghost sm" id="editP" style="padding-left:0">Изменить данные</button>
        </div>
        <div style="margin-top:12px" id="awardBox">
          ${v.points
            ? `<div class="pill ok" style="font-size:14px;padding:6px 12px">✓ Балл начислен (${esc(v.awarded_by_name || "")})</div>`
            : `<button class="ok block" id="awardBtn" ${r.needs_info ? "disabled" : ""}>Начислить 1 балл</button>`}
        </div>
        <button class="secondary block" id="nextBtn" style="margin-top:8px">Сканировать следующего</button>
      </div>`;
    const form = resultEl.querySelector("#pForm");
    form.onsubmit = guard(async e => {
      e.preventDefault();
      const d = formData(form);
      await api("PATCH", `/api/participants/${v.participant_id}`, d);
      Object.assign(v, d);
      toast("Данные сохранены");
      showResult({ ...r, visit: v, needs_info: false });
      loadVisits();
    });
    resultEl.querySelector("#editP").onclick = () => { form.hidden = false; resultEl.querySelector("#pInfo").hidden = true; };
    const awardBtn = resultEl.querySelector("#awardBtn");
    if (awardBtn) awardBtn.onclick = guard(async () => {
      awardBtn.disabled = true;
      const nv = await api("POST", `/api/visits/${v.id}/award`);
      toast("Балл начислен");
      showResult({ ...r, visit: nv, needs_info: false });
      loadVisits();
    });
    resultEl.querySelector("#nextBtn").onclick = () => { resultEl.innerHTML = ""; startScan(); };
  }

  const handleCode = guard(async raw => {
    setStatus("Проверяю код…");
    try {
      const r = await api("POST", "/api/scan", { code: raw, site_id: siteId });
      setStatus("");
      if (navigator.vibrate) navigator.vibrate(80);
      showResult(r);
      loadVisits();
    } catch (e) {
      setStatus(e.message, true);
    }
  });

  async function startScan() {
    resultEl.innerHTML = "";
    setStatus("Запрашиваю доступ к камере…");
    try {
      await Camera.start(view.querySelector("#video"), view.querySelector("#viewer"), code => {
        scanBtn.textContent = "Сканировать QR-код";
        handleCode(code);
      });
      scanBtn.textContent = "Остановить";
      setStatus("Наведите камеру на QR-код участника");
    } catch (e) {
      setStatus("Нет доступа к камере: " + e.message, true);
    }
  }

  scanBtn.onclick = () => {
    if (Camera.stream) { Camera.stop(); scanBtn.textContent = "Сканировать QR-код"; setStatus(""); }
    else startScan();
  };
  const fileInput = view.querySelector("#fileInput");
  view.querySelector("#fileBtn").onclick = () => fileInput.click();
  fileInput.onchange = async () => {
    const f = fileInput.files[0];
    fileInput.value = "";
    if (!f) return;
    Camera.stop();
    scanBtn.textContent = "Сканировать QR-код";
    try { handleCode(await Camera.fromFile(f)); } catch (e) { setStatus(e.message, true); }
  };
  view.querySelector("#manualBtn").onclick = () => {
    const code = prompt("Код участника (под QR-кодом), например FK-ABCD2345:");
    if (code) handleCode(code);
  };

  await loadVisits();
  setRefresh(loadVisits, 15000);
}

/* ================================================================ Площадка: специалисты и участники */

function groupAwards(visits) {
  const by = {};
  visits.filter(v => v.points && v.awarded_by).forEach(v => (by[v.awarded_by] ||= []).push(v));
  return by;
}

async function renderSiteStaff(el, siteId) {
  const rep = await api("GET", `/api/sites/${siteId}/report`);
  const awards = groupAwards(rep.visits);
  const canAdmins = ME.role === "college_admin" || ME.role === "system_admin";
  el.innerHTML = `
    <form class="card" id="newStaff">
      <h2>Добавить ${canAdmins ? "сотрудника площадки" : "специалиста МК"}</h2>
      <p class="hint">Площадка: <b>${esc(siteLabel(rep.site))}</b></p>
      <div class="row">
        ${canAdmins ? `<label class="f">Роль<select name="role"><option value="specialist">Специалист МК</option><option value="site_admin">Администратор площадки</option></select></label>` : ""}
        <label class="f">ФИО<input name="full_name" required maxlength="200"></label>
        <label class="f">Логин<input name="login" required minlength="3" maxlength="50" pattern="[A-Za-z0-9_.\\-]+" title="Латиница, цифры, точка, дефис, подчёркивание" autocomplete="off"></label>
        <label class="f">Пароль<input name="password" required minlength="6" autocomplete="new-password"></label>
        <button>Создать</button>
      </div>
    </form>
    <div class="card">
      <h2>Сотрудники площадки и начисленные баллы</h2>
      <div class="scroll"><table>
        <thead><tr><th>ФИО</th><th>Логин</th><th>Роль</th><th class="num">Баллов начислено</th><th></th></tr></thead>
        <tbody>${rep.staff.length ? rep.staff.map(u => `
          <tr>
            <td><b>${esc(nameOr(u.full_name, u.login))}</b>${u.is_active ? "" : ' <span class="pill bad">отключён</span>'}
              ${(awards[u.id] || []).length ? `<details><summary>Кому начислил (${awards[u.id].length})</summary>
                ${awards[u.id].map(v => `<div class="muted">${esc(nameOr(v.full_name))} — ${esc(v.institution || "—")}, ${fmtTime(v.awarded_at)}</div>`).join("")}</details>` : ""}
            </td>
            <td>${esc(u.login)}</td>
            <td>${esc(ROLE_NAMES[u.role])}</td>
            <td class="num"><b>${u.points}</b></td>
            <td class="num">${userActions(u)}</td>
          </tr>`).join("") : '<tr><td colspan="5" class="empty">Сотрудников пока нет</td></tr>'}
        </tbody>
      </table></div>
    </div>`;
  el.querySelector("#newStaff").onsubmit = guard(async e => {
    e.preventDefault();
    const d = formData(e.target);
    await api("POST", "/api/users", { role: "specialist", ...d, site_id: siteId });
    toast("Сотрудник создан");
    renderSiteStaff(el, siteId);
  });
  bindUserActions(el, () => renderSiteStaff(el, siteId));
}

async function renderSiteParticipants(el, siteId) {
  const rep = await api("GET", `/api/sites/${siteId}/report`);
  const draw = () => {
    const q = el.querySelector("#pSearch").value.trim().toLowerCase();
    const list = rep.visits.filter(v => !q || [v.full_name, v.institution, v.code].join(" ").toLowerCase().includes(q));
    el.querySelector("#pBody").innerHTML = list.length ? list.map(v => `
      <tr>
        <td><b>${esc(nameOr(v.full_name))}</b><div class="muted">${esc(v.code)}</div></td>
        <td>${esc(v.institution || "—")}</td>
        <td>${fmtTime(v.scanned_at)}<div class="muted">${esc(v.scanned_by_name || "")}</div></td>
        <td>${v.points ? `<span class="pill ok">1 балл</span><div class="muted">${esc(v.awarded_by_name || "")}, ${fmtTime(v.awarded_at)}</div>` : '<span class="pill muted">0</span>'}</td>
        <td class="num">${v.points ? `<button class="ghost sm danger" data-revoke="${v.id}">Отменить балл</button>` : `<button class="sm ok" data-award="${v.id}">+1 балл</button>`}</td>
      </tr>`).join("") : '<tr><td colspan="5" class="empty">Участников нет</td></tr>';
  };
  el.innerHTML = `
    <div class="card">
      <h2>Участники площадки <span class="pill info">${rep.visits.length}</span>
        <span class="muted">баллов выдано от площадки: <b>${rep.visits.reduce((s, v) => s + v.points, 0)}</b></span>
        <span class="sp"></span><button class="secondary sm" id="csv">Скачать CSV</button></h2>
      <p class="hint">${esc(siteLabel(rep.site))}</p>
      <input id="pSearch" placeholder="Поиск по ФИО, учебному заведению, коду" style="margin:0 0 8px">
      <div class="scroll"><table>
        <thead><tr><th>Участник</th><th>Колледж / школа</th><th>Отмечен</th><th>Балл</th><th></th></tr></thead>
        <tbody id="pBody"></tbody>
      </table></div>
    </div>`;
  draw();
  el.querySelector("#pSearch").oninput = draw;
  el.querySelector("#csv").onclick = () => downloadCsv(`участники_${rep.site.name}.csv`,
    ["ФИО", "Колледж/школа", "Код", "Отмечен", "Отметил", "Балл", "Начислил", "Когда начислен"],
    rep.visits.map(v => [v.full_name, v.institution, v.code, fmtTime(v.scanned_at), v.scanned_by_name, v.points, v.awarded_by_name, fmtTime(v.awarded_at)]));
  el.querySelector("#pBody").onclick = guard(async e => {
    const a = e.target.closest("[data-award]"), r = e.target.closest("[data-revoke]");
    if (a) { await api("POST", `/api/visits/${a.dataset.award}/award`); toast("Балл начислен"); }
    else if (r) { if (!confirm("Отменить начисленный балл?")) return; await api("DELETE", `/api/visits/${r.dataset.revoke}/award`); toast("Балл отменён"); }
    else return;
    renderSiteParticipants(el, siteId);
  });
}

/* ================================================================ Управление пользователями (общие кнопки) */

function userActions(u) {
  if (u.id === ME.id) return '<span class="muted">это вы</span>';
  return `<button class="ghost sm" data-pwd="${u.id}">Сбросить пароль</button>
          <button class="ghost sm ${u.is_active ? "danger" : ""}" data-toggle="${u.id}" data-active="${u.is_active}">${u.is_active ? "Отключить" : "Включить"}</button>`;
}

function bindUserActions(el, reload) {
  // onclick, а не addEventListener: контейнер переиспользуется между перерисовками
  el.onclick = guard(async e => {
    const p = e.target.closest("[data-pwd]"), t = e.target.closest("[data-toggle]");
    if (p) {
      const password = prompt("Новый пароль (не короче 6 символов):");
      if (!password) return;
      await api("PATCH", `/api/users/${p.dataset.pwd}`, { password });
      toast("Пароль изменён");
    } else if (t) {
      const active = t.dataset.active === "true";
      if (active && !confirm("Отключить пользователя? Он не сможет войти.")) return;
      await api("PATCH", `/api/users/${t.dataset.toggle}`, { is_active: !active });
      toast(active ? "Пользователь отключён" : "Пользователь включён");
      reload();
    }
  });
}

/* ================================================================ Админ колледжа / системы */

async function collegeFilter() {
  if (ME.role !== "system_admin") return { html: "", value: null, colleges: [] };
  const colleges = await api("GET", "/api/colleges");
  const value = storage("fk_college_filter") || "";
  return {
    colleges,
    value: value ? Number(value) : null,
    html: `<label class="f" style="max-width:320px;margin-bottom:12px">Колледж
      <select id="collegeFilter"><option value="">Все колледжи</option>
      ${colleges.map(c => `<option value="${c.id}" ${String(c.id) === value ? "selected" : ""}>${esc(c.name)}</option>`).join("")}</select></label>`,
  };
}
function bindCollegeFilter(el, tab) {
  const s = el.querySelector("#collegeFilter");
  if (s) s.onchange = () => { storage("fk_college_filter", s.value); openTab(tab); };
}

async function renderOverview(view) {
  const cf = await collegeFilter();
  const q = cf.value ? `?college_id=${cf.value}` : "";
  const [st, rating, sites] = await Promise.all([
    api("GET", "/api/stats" + q), api("GET", "/api/rating" + q), api("GET", "/api/sites" + q),
  ]);
  view.innerHTML = `
    ${cf.html}
    <div class="tiles">
      <div class="tile"><div class="l">Площадок</div><div class="v">${st.sites}</div></div>
      <div class="tile"><div class="l">Админов площадок</div><div class="v">${st.site_admins}</div></div>
      <div class="tile"><div class="l">Специалистов МК</div><div class="v">${st.specialists}</div></div>
      <div class="tile"><div class="l">Участников</div><div class="v">${st.participants}</div></div>
      <div class="tile"><div class="l">Посещений</div><div class="v">${st.visits}</div></div>
      <div class="tile"><div class="l">Баллов выдано</div><div class="v">${st.points}</div></div>
    </div>
    <div class="grid2">
      <div class="card"><h2>Топ-10 участников</h2>${ratingTable(rating.slice(0, 10), false)}</div>
      <div class="card"><h2>Площадки</h2>
        ${sites.length ? `<table><thead><tr><th>Площадка</th><th class="num">Посещений</th><th class="num">Баллов</th></tr></thead><tbody>
          ${sites.map(s => `<tr class="click" data-site="${s.id}"><td><b>${esc(s.name)}</b><div class="muted">${esc([s.floor && "этаж " + s.floor, s.room && "каб. " + s.room].filter(Boolean).join(" · "))}${ME.role === "system_admin" ? " · " + esc(s.college_name) : ""}</div></td><td class="num">${s.visits}</td><td class="num">${s.points}</td></tr>`).join("")}
        </tbody></table>` : '<div class="empty">Площадок пока нет</div>'}
      </div>
    </div>`;
  bindCollegeFilter(view, "overview");
  view.querySelectorAll("[data-site]").forEach(r => r.onclick = () => openTab("site", Number(r.dataset.site)));
}

function ratingTable(list, full) {
  if (!list.length) return '<div class="empty">Пока нет участников</div>';
  return `<div class="scroll"><table>
    <thead><tr><th>Место</th><th>Участник</th>${full ? "<th>Код</th>" : ""}<th class="num">Площадок</th><th class="num">Баллы</th></tr></thead>
    <tbody>${list.map(r => `<tr>
      <td><b>${r.place <= 3 && r.points > 0 ? ["🥇", "🥈", "🥉"][r.place - 1] : r.place}</b></td>
      <td><b>${esc(nameOr(r.full_name))}</b><div class="muted">${esc(r.institution || "—")}</div></td>
      ${full ? `<td class="muted">${esc(r.code)}</td>` : ""}
      <td class="num">${r.sites_visited}</td><td class="num"><b>${r.points}</b></td></tr>`).join("")}
    </tbody></table></div>`;
}

async function renderRating(view) {
  const cf = await collegeFilter();
  const list = await api("GET", "/api/rating" + (cf.value ? `?college_id=${cf.value}` : ""));
  view.innerHTML = `${cf.html}
    <div class="card">
      <h2>Рейтинг участников <span class="pill info">${list.length}</span><span class="sp"></span>
        <button class="secondary sm" id="csv">Скачать CSV</button></h2>
      <p class="hint">Отсортирован по количеству набранных баллов. При равенстве выше тот, кто набрал баллы раньше.</p>
      <input id="rSearch" placeholder="Поиск по ФИО, учебному заведению, коду" style="margin:0 0 8px">
      <div id="rTable"></div>
    </div>`;
  const draw = () => {
    const q = view.querySelector("#rSearch").value.trim().toLowerCase();
    view.querySelector("#rTable").innerHTML = ratingTable(list.filter(r => !q || [r.full_name, r.institution, r.code].join(" ").toLowerCase().includes(q)), true);
  };
  draw();
  view.querySelector("#rSearch").oninput = draw;
  view.querySelector("#csv").onclick = () => downloadCsv("рейтинг_участников.csv",
    ["Место", "ФИО", "Колледж/школа", "Код", "Площадок посещено", "Баллы"],
    list.map(r => [r.place, r.full_name, r.institution, r.code, r.sites_visited, r.points]));
  bindCollegeFilter(view, "rating");
}

async function renderColleges(view) {
  const colleges = await api("GET", "/api/colleges");
  view.innerHTML = `
    <div class="grid2">
      <form class="card" id="newCollege">
        <h2>Новый колледж</h2>
        <div class="row"><label class="f">Название<input name="name" required maxlength="200"></label><button>Создать</button></div>
      </form>
      <form class="card" id="newCAdmin">
        <h2>Новый администратор колледжа</h2>
        <div class="stack">
          <label class="f">Колледж<select name="college_id" required>${colleges.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join("")}</select></label>
          <div class="row">
            <label class="f">ФИО<input name="full_name" required maxlength="200"></label>
            <label class="f">Логин<input name="login" required minlength="3" pattern="[A-Za-z0-9_.\\-]+" autocomplete="off"></label>
            <label class="f">Пароль<input name="password" required minlength="6" autocomplete="new-password"></label>
          </div>
          <button ${colleges.length ? "" : "disabled"}>Создать</button>
        </div>
      </form>
    </div>
    <div class="card">
      <h2>Колледжи</h2>
      ${colleges.length ? `<table><thead><tr><th>Название</th><th class="num">Площадок</th><th class="num">Админов</th><th></th></tr></thead><tbody>
        ${colleges.map(c => `<tr><td><b>${esc(c.name)}</b></td><td class="num">${c.sites}</td><td class="num">${c.admins}</td>
          <td class="num"><button class="ghost sm" data-rename="${c.id}" data-name="${esc(c.name)}">Переименовать</button></td></tr>`).join("")}
      </tbody></table>` : '<div class="empty">Колледжей пока нет — создайте первый</div>'}
    </div>`;
  view.querySelector("#newCollege").onsubmit = guard(async e => {
    e.preventDefault();
    await api("POST", "/api/colleges", formData(e.target));
    toast("Колледж создан");
    openTab("colleges");
  });
  view.querySelector("#newCAdmin").onsubmit = guard(async e => {
    e.preventDefault();
    const d = formData(e.target);
    await api("POST", "/api/users", { ...d, role: "college_admin", college_id: Number(d.college_id) });
    toast("Администратор колледжа создан");
    openTab("colleges");
  });
  view.querySelectorAll("[data-rename]").forEach(b => b.onclick = guard(async () => {
    const name = prompt("Новое название:", b.dataset.name);
    if (!name) return;
    await api("PATCH", `/api/colleges/${b.dataset.rename}`, { name });
    openTab("colleges");
  }));
}

async function renderSites(view) {
  const cf = await collegeFilter();
  const sites = await api("GET", "/api/sites" + (cf.value ? `?college_id=${cf.value}` : ""));
  const isSys = ME.role === "system_admin";
  view.innerHTML = `${cf.html}
    <form class="card" id="newSite">
      <h2>Новая площадка (мастер-класс)</h2>
      <div class="row">
        ${isSys ? `<label class="f">Колледж<select name="college_id" required>${cf.colleges.map(c => `<option value="${c.id}" ${c.id === cf.value ? "selected" : ""}>${esc(c.name)}</option>`).join("")}</select></label>` : ""}
        <label class="f" style="flex-grow:3">Название МК<input name="name" required maxlength="200"></label>
        <label class="f">Этаж<input name="floor" maxlength="50"></label>
        <label class="f">Кабинет<input name="room" maxlength="50"></label>
        <button ${isSys && !cf.colleges.length ? "disabled" : ""}>Создать</button>
      </div>
      ${isSys && !cf.colleges.length ? '<p class="hint" style="margin:8px 0 0">Сначала создайте колледж во вкладке «Колледжи»</p>' : ""}
    </form>
    <div class="card">
      <h2>Площадки <span class="pill info">${sites.length}</span></h2>
      <p class="hint">Нажмите на площадку, чтобы увидеть её специалистов, администраторов, участников и баллы.</p>
      ${sites.length ? `<div class="scroll"><table>
        <thead><tr><th>Название МК</th><th>Этаж</th><th>Кабинет</th>${isSys ? "<th>Колледж</th>" : ""}<th class="num">Админов</th><th class="num">Специалистов</th><th class="num">Посещений</th><th class="num">Баллов</th></tr></thead>
        <tbody>${sites.map(s => `<tr class="click" data-site="${s.id}">
          <td><b>${esc(s.name)}</b></td><td>${esc(s.floor)}</td><td>${esc(s.room)}</td>${isSys ? `<td>${esc(s.college_name)}</td>` : ""}
          <td class="num">${s.admins}</td><td class="num">${s.specialists}</td><td class="num">${s.visits}</td><td class="num"><b>${s.points}</b></td></tr>`).join("")}
        </tbody></table></div>` : '<div class="empty">Площадок пока нет</div>'}
    </div>`;
  bindCollegeFilter(view, "sites");
  view.querySelector("#newSite").onsubmit = guard(async e => {
    e.preventDefault();
    const d = formData(e.target);
    if (d.college_id) d.college_id = Number(d.college_id);
    const s = await api("POST", "/api/sites", d);
    toast("Площадка создана");
    openTab("site", s.id);
  });
  view.querySelectorAll("[data-site]").forEach(r => r.onclick = () => openTab("site", Number(r.dataset.site)));
}

async function renderSiteDetail(view, siteId) {
  document.querySelectorAll("#tabs button").forEach(b => b.classList.toggle("active", b.dataset.tab === "sites"));
  const s = await api("GET", `/api/sites/${siteId}`);
  view.innerHTML = `
    <button class="ghost" id="back" style="padding-left:0">← Все площадки</button>
    <form class="card" id="editSite">
      <h2>${esc(s.name)} <span class="muted">${esc(s.college_name)}</span></h2>
      <div class="row">
        <label class="f" style="flex-grow:3">Название МК<input name="name" value="${esc(s.name)}" required maxlength="200"></label>
        <label class="f">Этаж<input name="floor" value="${esc(s.floor)}" maxlength="50"></label>
        <label class="f">Кабинет<input name="room" value="${esc(s.room)}" maxlength="50"></label>
        <button class="secondary">Сохранить</button>
        <button type="button" class="ghost danger" id="delSite">Удалить</button>
      </div>
    </form>
    <div id="staffBox"></div>
    <div id="partBox"></div>`;
  view.querySelector("#back").onclick = () => openTab("sites");
  view.querySelector("#editSite").onsubmit = guard(async e => {
    e.preventDefault();
    await api("PATCH", `/api/sites/${siteId}`, formData(e.target));
    toast("Площадка сохранена");
  });
  view.querySelector("#delSite").onclick = guard(async () => {
    if (!confirm("Удалить площадку вместе с её сотрудниками?")) return;
    await api("DELETE", `/api/sites/${siteId}`);
    toast("Площадка удалена");
    openTab("sites");
  });
  await Promise.all([renderSiteStaff(view.querySelector("#staffBox"), siteId), renderSiteParticipants(view.querySelector("#partBox"), siteId)]);
}

async function renderUsers(view) {
  const isSys = ME.role === "system_admin";
  const cf = await collegeFilter();
  const roleFilter = storage("fk_role_filter") || "";
  const params = new URLSearchParams();
  if (cf.value) params.set("college_id", cf.value);
  if (roleFilter) params.set("role", roleFilter);
  const [users, sites] = await Promise.all([api("GET", "/api/users?" + params), api("GET", "/api/sites" + (cf.value ? `?college_id=${cf.value}` : ""))]);
  const roles = isSys ? ["site_admin", "specialist", "college_admin", "system_admin"] : ["site_admin", "specialist"];

  view.innerHTML = `
    <div class="row">${cf.html}
      <label class="f" style="max-width:320px;margin-bottom:12px">Роль
        <select id="roleFilter"><option value="">Все роли</option>${Object.entries(ROLE_NAMES).filter(([k]) => isSys || k !== "system_admin").map(([k, v]) => `<option value="${k}" ${k === roleFilter ? "selected" : ""}>${v}</option>`).join("")}</select></label>
    </div>
    <form class="card" id="newUser">
      <h2>Новый пользователь</h2>
      <div class="row">
        <label class="f">Роль<select name="role" id="nuRole">${roles.map(r => `<option value="${r}">${ROLE_NAMES[r]}</option>`).join("")}</select></label>
        <label class="f" id="nuSite">Площадка<select name="site_id">${sites.map(s => `<option value="${s.id}">${esc(siteLabel(s))}${isSys ? " — " + esc(s.college_name) : ""}</option>`).join("")}</select></label>
        ${isSys ? `<label class="f" id="nuCollege" hidden>Колледж<select name="college_id">${cf.colleges.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join("")}</select></label>` : ""}
      </div>
      <div class="row" style="margin-top:8px">
        <label class="f">ФИО<input name="full_name" required maxlength="200"></label>
        <label class="f">Логин<input name="login" required minlength="3" pattern="[A-Za-z0-9_.\\-]+" title="Латиница, цифры, точка, дефис, подчёркивание" autocomplete="off"></label>
        <label class="f">Пароль<input name="password" required minlength="6" autocomplete="new-password"></label>
        <button>Создать</button>
      </div>
    </form>
    <div class="card">
      <h2>Пользователи <span class="pill info">${users.length}</span></h2>
      <div class="scroll"><table>
        <thead><tr><th>ФИО</th><th>Логин</th><th>Роль</th><th>Колледж / площадка</th><th class="num">Баллов начислено</th><th></th></tr></thead>
        <tbody>${users.map(u => `<tr>
          <td><b>${esc(nameOr(u.full_name, u.login))}</b>${u.is_active ? "" : ' <span class="pill bad">отключён</span>'}</td>
          <td>${esc(u.login)}</td><td>${esc(ROLE_NAMES[u.role])}</td>
          <td>${esc(u.site_name || "")}${u.site_name && isSys ? `<div class="muted">${esc(u.college_name)}</div>` : u.site_name ? "" : esc(u.college_name || "—")}</td>
          <td class="num">${u.role === "specialist" || u.points_awarded ? u.points_awarded : ""}</td>
          <td class="num">${userActions(u)}</td></tr>`).join("") || '<tr><td colspan="6" class="empty">Нет пользователей</td></tr>'}
        </tbody>
      </table></div>
    </div>`;

  bindCollegeFilter(view, "users");
  view.querySelector("#roleFilter").onchange = e => { storage("fk_role_filter", e.target.value); openTab("users"); };
  const roleSel = view.querySelector("#nuRole");
  const syncRole = () => {
    const r = roleSel.value;
    view.querySelector("#nuSite").hidden = !(r === "site_admin" || r === "specialist");
    const c = view.querySelector("#nuCollege");
    if (c) c.hidden = r !== "college_admin";
  };
  roleSel.onchange = syncRole;
  syncRole();
  view.querySelector("#newUser").onsubmit = guard(async e => {
    e.preventDefault();
    const d = formData(e.target);
    const body = { login: d.login, password: d.password, full_name: d.full_name, role: d.role };
    if (d.role === "site_admin" || d.role === "specialist") body.site_id = Number(d.site_id) || null;
    if (d.role === "college_admin") body.college_id = Number(d.college_id) || null;
    await api("POST", "/api/users", body);
    toast("Пользователь создан");
    openTab("users");
  });
  bindUserActions(view, () => openTab("users"));
}

// Ссылку восстановления могут открыть во вкладке, где приложение уже запущено
window.addEventListener("hashchange", () => { if (/p=/.test(location.hash)) location.reload(); });

boot();
