/*
 * 活動滿意度調查 — survey-1.html／survey-2.html／survey-3.html 共用。
 * 各頁以 <body data-session="第一梯次"> 指定梯次；題目、版面與送出流程三梯次完全相同。
 * 後端：apps-script/Code.gs 的 surveyLookup_／surveyStatus_／submitSurvey_，
 * 照片上傳：surveyUploadUrl_（申請 Drive 可續傳上傳網址）／surveyUploadStatus_／surveyUploadChunk_（代傳備援）。
 */
(function () {
"use strict";

const CONFIG = {
  API_URL: "https://script.google.com/macros/s/AKfycbzF7cY4JwKRJhmY_6AQ6i5smlcbtUwHmD6I_LBKAIyE4gzxDNL9Bcltu5pRIjy7iYYNZQ/exec",
  LOOKUP_TIMEOUT_MS: 25000,
  SUBMIT_TIMEOUT_MS: 60000,      // 送出問卷（照片已上傳，只帶檔案 ID）
  STORY_MIN: 20,                 // 與 Code.gs 的 SURVEY_STORY_MIN 相同
  STORY_MAX: 1000,
  // 照片：原檔、不限大小，直接以 Google Drive API 可續傳上傳（分塊續傳）
  CHUNK_BYTES: 8 * 1024 * 1024,  // 分塊大小（Drive 規定為 256 KB 的倍數）
  CHUNK_TIMEOUT_MS: 10 * 60 * 1000,
  MAX_RETRIES: 8,                // 連續失敗幾次後暫停（約 2～3 分鐘）；再按送出會從中斷處續傳
  DIRECT_FAILS_BEFORE_PROXY: 2   // 直接上傳連續失敗幾次（後端仍連得上）後，改由後端代傳分塊
};

const SESSIONS = {
  "第一梯次": { date: "115/10/17（六）–10/18（日）", page: "survey-1.html" },
  "第二梯次": { date: "115/11/14（六）–11/15（日）", page: "survey-2.html" },
  "第三梯次": { date: "115/11/21（六）–11/22（日）", page: "survey-3.html" }
};
const SESSION = document.body.dataset.session;
const SESS = SESSIONS[SESSION];

// html：窄螢幕只在 <wbr> 處換行（非常／同意），不會切成「非常同／意」
// 由左到右 1 → 5（非常同意在最右邊）；分數值不變，試算表一樣記 1～5
const SCALE = [
  { v: 1, label: "非常不同意", html: "非常<wbr>不同意" },
  { v: 2, label: "不同意", html: "不同意" },
  { v: 3, label: "普通", html: "普通" },
  { v: 4, label: "同意", html: "同意" },
  { v: 5, label: "非常同意", html: "非常<wbr>同意" }
];

const ICONS = {
  food: '<svg viewBox="0 0 64 64" aria-hidden="true"><g stroke="#b4432f" stroke-width="2.5" fill="none" stroke-linecap="round"><path d="M24 24 c-3 -4 3 -6 0 -10"/><path d="M32 22 c-3 -4 3 -6 0 -10"/><path d="M40 24 c-3 -4 3 -6 0 -10"/></g><path d="M8 30 h48 c0 14 -10 24 -24 24 s-24 -10 -24 -24z" fill="#f7efdd" stroke="#b4432f" stroke-width="3"/><path d="M14 30 c6 -6 30 -6 36 0" fill="none" stroke="#d9a441" stroke-width="3"/><rect x="22" y="54" width="20" height="4" rx="2" fill="#b4432f"/></svg>',
  care: '<svg viewBox="0 0 64 64" aria-hidden="true"><path d="M12 36 c6 -8 14 -8 20 -2 l8 6 c3 2 1 6 -2 6 l-10 -1" fill="#f7efdd" stroke="#3e7c59" stroke-width="3" stroke-linejoin="round"/><path d="M52 36 c-6 -8 -14 -8 -20 -2" fill="none" stroke="#3e7c59" stroke-width="3"/><path d="M8 44 l14 6 c6 2 12 2 18 0 l16 -8" fill="none" stroke="#3e7c59" stroke-width="3" stroke-linecap="round"/><path d="M32 14 c-4 -6 -12 -4 -12 3 c0 6 12 12 12 12 s12 -6 12 -12 c0 -7 -8 -9 -12 -3z" fill="#e4572e"/></svg>',
  self: '<svg viewBox="0 0 64 64" aria-hidden="true"><circle cx="32" cy="28" r="18" fill="#f1dfae"/><circle cx="32" cy="28" r="10" fill="#d9a441"/><g stroke="#d9a441" stroke-width="3" stroke-linecap="round"><path d="M32 6 v6 M32 44 v6 M10 28 h6 M48 28 h6 M16.5 12.5 l4 4 M43.5 43.5 l4 4 M16.5 43.5 l4 -4 M43.5 12.5 l-4 4"/></g><path d="M14 56 q18 -10 36 0" fill="none" stroke="#3e7c59" stroke-width="3" stroke-linecap="round"/></svg>',
  overall: '<svg viewBox="0 0 64 64" aria-hidden="true"><path d="M32 8 l7.4 15 16.6 2.4 -12 11.7 2.8 16.5 -14.8 -7.8 -14.8 7.8 2.8 -16.5 -12 -11.7 16.6 -2.4z" fill="#d3e2e8" stroke="#2f5f72" stroke-width="3" stroke-linejoin="round"/></svg>',
  camera: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>',
  phone: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="2" width="14" height="20" rx="2.5"/><path d="M9 7h6M9 11h6M9 15h3"/></svg>',
  gift: '<svg viewBox="0 0 64 64" aria-hidden="true"><rect x="10" y="26" width="44" height="30" rx="4" fill="#e4572e"/><rect x="6" y="18" width="52" height="12" rx="3" fill="#c8352b"/><rect x="28" y="18" width="8" height="38" fill="#d9a441"/><path d="M32 18 c-6 -10 -18 -10 -16 -2 c1 4 10 4 16 2z M32 18 c6 -10 18 -10 16 -2 c-1 4 -10 4 -16 2z" fill="#d9a441"/></svg>',
  search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/></svg>',
  home: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 11l9-8 9 8"/><path d="M5 10v10h14V10"/></svg>'
};

// 10 題：三面向（飲食文化、社區照護、自我覺察）＋整體滿意度。順序與 Code.gs 的 SURVEY_QUESTIONS 相同
const GROUPS = [
  {
    key: "飲食文化", no: "01", icon: ICONS.food, desc: "走讀街巷、市場與聚落，從在地飲食認識生活型態",
    ink: "#b4432f", bg: "#fdf3ee", line: "#f2d6cb",
    questions: [
      "透過府城小吃、府城食府與俗女餐桌等在地飲食體驗，我更認識臺南的飲食文化與生活樣貌。",
      "我更能理解飲食習慣、家庭與文化背景，如何影響民眾的健康與疾病。",
      "未來在衛教或照護時，我會更留意病人的飲食文化與生活習慣。"
    ]
  },
  {
    key: "社區照護", no: "02", icon: ICONS.care, desc: "連結生活情境與連續性照護，培養全人照護與跨職類合作",
    ink: "#3e7c59", bg: "#f1f6ea", line: "#d6e4c6",
    questions: [
      "走讀老城巷弄、廟宇、老街與農村聚落，讓我更了解病人在醫院之外的生活情境。",
      "我更能體會家庭、鄰里與社區資源，對民眾健康及連續性照護的重要性。",
      "活動中與不同職類夥伴的交流，有助於我日後的跨職類團隊合作。"
    ]
  },
  {
    key: "自我覺察", no: "03", icon: ICONS.self, desc: "透過正念練習與人生反思，探索專業、職涯、價值與使命",
    ink: "#9a6a12", bg: "#fdf7e6", line: "#f0e0b4",
    questions: [
      "活動讓我有機會放慢腳步，覺察自己當下的情緒與身心狀態。",
      "活動促使我反思自己的專業價值、職涯方向與投入醫療的初衷。",
      "我願意把這兩天的體會帶回日常工作，調整與病人、同儕相處的方式。"
    ]
  },
  {
    key: "整體滿意度", no: "04", icon: ICONS.overall, desc: "行程安排、導覽解說、交通與餐食",
    ink: "#2f5f72", bg: "#eef5f8", line: "#cfe0e7",
    questions: [
      "整體而言，我對本次活動（行程安排、導覽解說、交通與餐食）感到滿意。"
    ]
  }
];
const QUESTION_COUNT = GROUPS.reduce((n, g) => n + g.questions.length, 0);

const STORY_EXAMPLES = [
  "在菁寮親手揉紅龜粿時，才知道一顆粿要花這麼多工夫，也包著對家人的祝福。<em>這讓我覺察到</em>，我在病房常只盯著檢驗數字，忘了每位病人背後都有一個掛念他的家；之後我想多花一分鐘，聽病人說說他的生活。",
  "俗女餐桌上，大家圍著在地媽媽們煮的家常菜邊吃邊聊。<em>那一刻我才發現</em>，自己已經很久沒有好好坐下來吃一頓飯；照顧別人之前，我也需要先照顧好自己。",
  "坐在竹筏上穿過四草綠色隧道，四周安靜得只剩下水聲。<em>我察覺到</em>自己平時總是急著把事情做完，很少停下來感受當下；回到工作崗位後，我想試著放慢一點，陪病人多待一會兒。"
];

/* ---------- 工具 ---------- */
const $ = s => document.querySelector(s);
const $$ = s => Array.from(document.querySelectorAll(s));
const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const fmtSize = b => b >= 1048576 ? (b / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(b / 1024)) + " KB";

/** 人事號正規化：與 index.html、Code.gs 完全相同 */
function normalizeId(v) {
  return String(v == null ? '' : v)
    .normalize('NFKC')                      // 全形轉半形：８６０７Ｅ７、＇
    .replace(/[​-‍﻿]/g, '')  // 移除零寬字元（複製貼上常夾帶）
    .trim()
    .replace(/^['‘’]+/, '')                 // 移除開頭撇號，含 iPhone 智慧型標點的彎撇號
    .trim()
    .toUpperCase();
}

function newId() {
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
  return "s" + Date.now().toString(36) + Math.random().toString(36).slice(2, 12);
}

function fetchWithTimeout(url, opts, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, Object.assign({ signal: ctrl.signal, cache: "no-store" }, opts || {})).finally(() => clearTimeout(timer));
}
async function getJson(params) {
  const q = new URLSearchParams(Object.assign({}, params, { t: Date.now() }));
  const res = await fetchWithTimeout(CONFIG.API_URL + "?" + q.toString(), {}, CONFIG.LOOKUP_TIMEOUT_MS);
  return res.json();
}
async function postJson(body, ms) {
  // text/plain 避免 CORS preflight（Apps Script 不處理 OPTIONS）
  const res = await fetchWithTimeout(CONFIG.API_URL, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify(body)
  }, ms || CONFIG.SUBMIT_TIMEOUT_MS);
  return res.json();
}

/* ---------- 草稿（僅存在本機瀏覽器）：作答、送出代碼與照片的上傳網址；照片檔案本身無法保存，需重新選取 ---------- */
const DRAFT_KEY = "tainan360_survey_draft_" + SESSION;
function saveDraft() {
  try {
    const answers = {};
    for (let i = 1; i <= QUESTION_COUNT; i++) { const c = $(`input[name=q${i}]:checked`); if (c) answers[i] = c.value; }
    localStorage.setItem(DRAFT_KEY, JSON.stringify({ empId: $("#empId").value, answers, story: $("#story").value, sid: state.submissionId, uploads: state.uploads }));
  } catch (e) {}
}
function loadDraft() {
  try { return JSON.parse(localStorage.getItem(DRAFT_KEY) || "null"); } catch (e) { return null; }
}
function clearDraft() { try { localStorage.removeItem(DRAFT_KEY); } catch (e) {} }

/* ---------- 版面 ---------- */
function render() {
  document.title = `${SESSION}活動滿意度調查｜360°醫學人生｜走進臺南，走進生活`;
  let qn = 0;
  const groupsHtml = GROUPS.map(g => `
    <section class="group" style="--g-ink:${g.ink};--g-bg:${g.bg};--g-line:${g.line}">
      <div class="group-head">
        <div class="group-icon">${g.icon}</div>
        <div><h3><small>${g.no}</small>${g.key}</h3><p>${g.desc}</p></div>
      </div>
      ${g.questions.map(text => {
        qn++;
        return `
        <div class="q" id="qbox${qn}">
          <fieldset>
            <legend><span class="qn">${qn}.</span><span>${esc(text)}</span></legend>
            <div class="likert">
              ${SCALE.map(s => `<input type="radio" name="q${qn}" id="q${qn}_${s.v}" value="${s.v}"><label for="q${qn}_${s.v}"><b>${s.v}</b><span>${s.html}</span></label>`).join("")}
            </div>
          </fieldset>
        </div>`;
      }).join("")}
    </section>`).join("");

  $("#app").innerHTML = `
  <section class="hero">
    <div class="container">
      <span class="kicker">SURVEY</span>
      <h1>活動滿意度調查</h1>
      <p class="sub">360°醫學人生｜走進臺南，走進生活</p>
      <div class="session-chip"><b>${esc(SESSION)}</b><span>${esc(SESS.date)}</span></div>
      <p class="lead">感謝您參加這兩天的臺南走讀！問卷約需 5 分鐘，您的回饋將幫助我們把活動辦得更好。</p>
      <ol class="steps">
        <li><b>1</b>輸入人事號</li>
        <li><b>2</b>滿意度 10 題</li>
        <li><b>3</b>活動照＋最感動的一段話</li>
        <li><b>4</b>選填：社群截圖拿小禮物</li>
      </ol>
    </div>
  </section>

  <div class="container">
    <form id="surveyForm" novalidate>

      <section class="card" id="step1">
        <div class="card-head">
          <span class="step-no">1</span>
          <div><h2>填寫人<span class="tag req">必填</span></h2><p>輸入人事號後按「查詢」，系統會帶出您的報名資料。</p></div>
        </div>
        <div class="field" id="empField">
          <label for="empId">人事號</label>
          <div class="lookup-row">
            <input type="text" id="empId" name="empId" placeholder="例：910632 或 B20715" inputmode="text" autocomplete="off" autocapitalize="characters" autocorrect="off" spellcheck="false">
            <button type="button" class="btn btn-primary" id="lookupBtn">${ICONS.search}查詢</button>
          </div>
          <span class="err">請輸入人事號並按「查詢」。</span>
        </div>
        <div class="profile" id="profile" aria-live="polite"></div>
      </section>

      <section class="card" id="step2">
        <div class="card-head">
          <span class="step-no">2</span>
          <div><h2>活動滿意度<span class="tag req">必填</span></h2><p>請依您的感受，為每一題選擇最符合的分數。</p></div>
        </div>
        <p class="scale-legend">${SCALE.map(s => `<span><b>${s.v}</b> ${s.label}</span>`).join("")}</p>
        ${groupsHtml}
        <p class="q-count">已作答 <b id="answeredCount">0</b> ／ ${QUESTION_COUNT} 題</p>
      </section>

      <section class="card" id="step3">
        <div class="card-head">
          <span class="step-no">3</span>
          <div><h2>活動照＋最感動的一段話<span class="tag req">必填</span></h2><p>上傳一張這兩天的活動照，並寫下最觸動您的時刻。</p></div>
        </div>

        <div class="upload" id="photoUpload">
          <span class="label">活動照</span>
          <input class="sr-only" type="file" id="photoInput" accept="image/*">
          <label class="drop" for="photoInput">
            ${ICONS.camera}
            <strong>點這裡選擇活動照</strong>
            <span>手機可直接拍照或從相簿選取；電腦也可以把照片拖曳到這裡</span>
            <span>JPG、PNG、HEIC、RAW 皆可，原檔上傳、不限檔案大小</span>
            <span>大檔案會分段上傳，網路中斷可從中斷處續傳</span>
          </label>
          <div class="preview"></div>
          <p class="err">請上傳一張活動照。</p>
        </div>

        <div class="field" id="storyField">
          <label for="story">最感動的一段話</label>
          <div class="guide">
            請寫下這兩天<b>最觸動您的一個時刻</b>，以及<b>它讓您對自己有什麼新的覺察</b>——例如：自己的情緒、價值觀、與病人或同儕的關係，或投入醫療的初衷。
            <br><span class="pattern">句型：最讓我感動的是……；這讓我覺察到……</span>
            <details class="examples">
              <summary>看看填寫範例</summary>
              <ol>${STORY_EXAMPLES.map(x => `<li>${x}</li>`).join("")}</ol>
            </details>
          </div>
          <textarea id="story" name="story" maxlength="${CONFIG.STORY_MAX}" placeholder="最讓我感動的是……&#10;這讓我覺察到……"></textarea>
          <div class="counter"><span>至少 ${CONFIG.STORY_MIN} 字，請連結您對自己的覺察</span><span>已輸入 <b id="storyCount">0</b> 字</span></div>
          <span class="err">請至少寫 ${CONFIG.STORY_MIN} 個字，並說說它讓您對自己有什麼覺察。</span>
        </div>
      </section>

      <section class="card" id="step4">
        <div class="card-head">
          <span class="step-no">4</span>
          <div><h2>手拉旗自拍・分享社群<span class="tag opt">選填</span></h2><p>上傳社群媒體截圖，即可獲得精美小禮物一份！</p></div>
        </div>
        <div class="gift">
          ${ICONS.gift}
          <div>
            <h3>拍照分享，送精美小禮物</h3>
            <ol>
              <li>與<b>教學部</b>及<b>奇美醫院手拉旗</b>合影自拍</li>
              <li>分享到您的社群媒體（Facebook、Instagram、Threads 等）</li>
              <li>將貼文<b>截圖</b>上傳到下方，即可獲得<b>精美小禮物一份</b></li>
            </ol>
          </div>
        </div>
        <div class="upload" id="socialUpload" style="--u-line:#a9c7d3;--u-bg:#f3f8fa">
          <span class="label">社群媒體截圖</span>
          <input class="sr-only" type="file" id="socialInput" accept="image/*">
          <label class="drop" for="socialInput">
            ${ICONS.phone}
            <strong>點這裡上傳社群媒體截圖</strong>
            <span>JPG、PNG、HEIC、RAW 皆可，原檔上傳、不限檔案大小</span>
            <span>大檔案會分段上傳，網路中斷可從中斷處續傳</span>
          </label>
          <div class="preview"></div>
        </div>
      </section>

      <section class="card" id="submitCard">
        <div class="form-msg" id="formMsg" role="alert"></div>
        <div class="submit-row">
          <p class="todo" id="todo"></p>
          <button type="submit" class="btn btn-primary" id="submitBtn">送出問卷</button>
        </div>
      </section>
    </form>
  </div>`;
}

/* ---------- 狀態 ---------- */
const state = {
  record: null,            // 查詢到的報名資料
  lookedUp: "",            // 已查詢的人事號（正規化後）
  lookupSeq: 0,
  photo: null,             // { blob（原檔 File）, name, preview, w, h }
  social: null,
  blocked: null,           // 此人事號已填寫過本梯次問卷時的編號（每人限填一次）
  uploads: {},             // 上傳進度：{ photo|social: { url, mode, name, size, lastModified, fileId } }（續傳用）
  submissionId: newId(),   // 同一份問卷重送時沿用，後端據此避免重複寫入
  submitting: false,
  done: false
};

/* ---------- 1. 人事號查詢 ---------- */
function renderProfile() {
  const r = state.record;
  if (!r) return;
  const dl = `
    <dl>
      <div><dt>梯次</dt><dd>${esc(r.session)}</dd></div>
      <div><dt>身分</dt><dd>${esc(r.identity)}</dd></div>
      <div><dt>單位</dt><dd>${esc(r.unit)}</dd></div>
      <div><dt>姓名</dt><dd>${esc(r.name)}</dd></div>
      <div><dt>人事號</dt><dd>${esc(r.empId)}</dd></div>
      <div><dt>職稱</dt><dd>${esc(r.title)}</dd></div>
    </dl>`;
  if (state.blocked) {
    showProfile("error", `
      <div class="profile-title" style="color:#8f2416">您已填寫過${esc(SESSION)}問卷（編號 ${esc(state.blocked)}）</div>
      ${dl}
      <p class="note">每人限填寫一次，無法再次送出。如需修改請洽教學部（分機 57440）。</p>`);
  } else {
    showProfile("ok", `<div class="profile-title">✔ 已找到您的報名資料，請確認</div>${dl}<p class="note">資料有誤請洽教學部（分機 57440）。</p>`);
  }
}

function showProfile(kind, html) {
  const p = $("#profile");
  p.className = "profile show " + kind;
  p.innerHTML = html;
}
function hideProfile() { const p = $("#profile"); p.className = "profile"; p.innerHTML = ""; }

async function lookup(force) {
  const input = $("#empId");
  const id = normalizeId(input.value);
  input.value = id;
  $("#empField").classList.remove("invalid");
  if (!id) { state.record = null; state.blocked = null; state.lookedUp = ""; hideProfile(); updateProgress(); return false; }
  if (!force && state.lookedUp === id && state.record) return true;
  const seq = ++state.lookupSeq;
  state.record = null; state.blocked = null; state.lookedUp = id;
  showProfile("loading", "查詢報名資料中…");
  $("#lookupBtn").disabled = true;
  try {
    const res = await getJson({ action: "surveyLookup", session: SESSION, empId: id });
    if (seq !== state.lookupSeq) return false;
    if (res && res.ok && res.found && res.record) {
      state.record = res.record;
      state.blocked = (res.submittedBefore || [])[0] || null;
      renderProfile();
    } else if (res && res.error === "notfound") {
      const links = (res.otherSessions || []).filter(s => SESSIONS[s])
        .map(s => `<a href="${SESSIONS[s].page}">前往${esc(s)}問卷 →</a>`).join("　");
      showProfile(links ? "warn" : "error", `${esc(res.message || "查無報名資料。")}${links ? "<br>" + links : ""}`);
    } else if (res && res.ok === false) {
      showProfile("error", esc(res.message || "查詢失敗，請再試一次。"));
    } else {
      // 後端尚未部署問卷功能時，GET 會回傳名額資料
      showProfile("error", "問卷系統尚未啟用，請稍後再試，或洽教學部（分機 57440）。");
    }
  } catch (err) {
    if (seq !== state.lookupSeq) return false;
    state.lookedUp = "";
    showProfile("error", "網路連線失敗，請按「查詢」再試一次。");
  } finally {
    if (seq === state.lookupSeq) $("#lookupBtn").disabled = false;
    updateProgress();
  }
  return !!state.record;
}

/* ---------- 3、4. 照片 ---------- */
function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => resolve({ img, url });
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("decode")); };
    img.src = url;
  });
}
const extOf = name => ((String(name).match(/\.([a-z0-9]+)$/i) || [])[1] || "").toLowerCase();
const TYPE_EXT = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif", "image/heic": "heic", "image/heif": "heif", "image/tiff": "tif", "image/bmp": "bmp" };
// 與 Code.gs 的 SURVEY_UPLOAD_EXTS 相同（含 RAW）
const IMAGE_EXTS = ["jpg", "jpeg", "jpe", "png", "webp", "gif", "heic", "heif", "tif", "tiff", "bmp", "dng", "cr2", "cr3", "nef", "arw", "orf", "rw2", "raf"];
function fileExt(file) {
  let e = extOf(file.name);
  if (e === "jpeg" || e === "jpe") e = "jpg";
  if (IMAGE_EXTS.includes(e)) return e;
  return TYPE_EXT[(file.type || "").toLowerCase()] || "jpg";
}

/** 不壓縮、原檔上傳、不限大小：只檢查是否為圖片，並產生預覽（HEIC、RAW 等瀏覽器無法顯示的格式不顯示預覽，仍上傳原檔） */
async function prepareImage(file) {
  const looksImage = /^image\//.test(file.type) || IMAGE_EXTS.includes(extOf(file.name));
  if (!looksImage) throw new Error("請選擇圖片檔（JPG、PNG、HEIC、RAW 等）。");
  if (!file.size) throw new Error("這個檔案是空的，請改選其他照片。");
  const out = { blob: file, name: file.name, preview: null, w: 0, h: 0 };
  if (file.size <= 80 * 1024 * 1024) {             // 太大的檔案不解碼預覽，避免手機記憶體不足
    try {
      const { img, url } = await loadImage(file);
      Object.assign(out, { preview: url, w: img.naturalWidth, h: img.naturalHeight });
    } catch (e) { /* 無法預覽 */ }
  }
  return out;
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1] || "");
    r.onerror = () => reject(r.error || new Error("read"));
    r.readAsDataURL(blob);
  });
}

const previewers = {};
const refreshPreviews = () => Object.values(previewers).forEach(fn => fn());
function setupUpload(key, boxSel, inputSel) {
  const box = $(boxSel), input = $(inputSel), drop = box.querySelector(".drop"), preview = box.querySelector(".preview");

  async function take(file) {
    if (!file) return;
    box.classList.add("busy");
    const strong = drop.querySelector("strong"), label = strong.textContent;
    strong.textContent = "讀取照片中…";
    try {
      const prepared = await prepareImage(file);
      if (state[key] && state[key].preview) URL.revokeObjectURL(state[key].preview);
      state[key] = prepared;
      box.classList.remove("invalid");
      showPreview();
    } catch (err) {
      alert(err.message || "無法讀取這張照片，請改選其他照片。");
    } finally {
      strong.textContent = label;
      box.classList.remove("busy");
      input.value = "";
      updateProgress();
    }
  }
  function showPreview() {
    const f = state[key];
    if (!f) { box.classList.remove("has-file"); preview.innerHTML = ""; return; }
    const dims = f.w ? `${f.w}×${f.h}・` : "";
    const resume = sameFile(state.uploads[key], f.blob)
      ? `<span class="ok">${state.uploads[key].fileId ? "✔ 這張照片已上傳完成" : "↻ 上次已開始上傳，送出時會從中斷處繼續"}</span>` : "";
    preview.innerHTML = `
      ${f.preview ? `<img src="${f.preview}" alt="已選擇的照片預覽">` : `<div style="width:120px;height:120px;border-radius:12px;background:var(--rice);display:grid;place-items:center;color:var(--ink-soft);font-size:.8rem;flex:none;text-align:center">無法預覽<br>（仍會上傳原檔）</div>`}
      <div class="meta">
        <span class="ok">✔ 已選擇</span>
        <b>${esc(f.name)}</b>
        <span>${dims}${fmtSize(f.blob.size)}・原檔上傳</span>
        ${resume}
        <div class="acts">
          <button type="button" class="btn btn-ghost" data-act="replace">更換照片</button>
          <button type="button" class="btn btn-ghost" data-act="remove">移除</button>
        </div>
      </div>`;
    box.classList.add("has-file");
  }
  preview.addEventListener("click", e => {
    const act = e.target.closest("[data-act]");
    if (!act) return;
    if (act.dataset.act === "replace") input.click();
    if (act.dataset.act === "remove") {
      if (state[key] && state[key].preview) URL.revokeObjectURL(state[key].preview);
      state[key] = null; showPreview(); updateProgress();
    }
  });
  input.addEventListener("change", () => take(input.files && input.files[0]));
  ["dragenter", "dragover"].forEach(t => drop.addEventListener(t, e => { e.preventDefault(); drop.classList.add("drag"); }));
  ["dragleave", "dragend"].forEach(t => drop.addEventListener(t, () => drop.classList.remove("drag")));
  drop.addEventListener("drop", e => {
    e.preventDefault(); drop.classList.remove("drag");
    take(e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]);
  });
  previewers[key] = showPreview;
}

/* ---------- 照片上傳：Google Drive API 可續傳上傳（Resumable Upload）＋分塊續傳 ----------
 * 1. 向後端申請此檔案專用的「可續傳上傳網址」（後端以 Drive API 建立，權杖不會傳到網頁）。
 * 2. 把原檔切成 8 MB 分塊，直接 PUT 到上傳網址（Content-Range），由瀏覽器直接推送到 Google 雲端硬碟。
 * 3. 分塊失敗（網路中斷、手機切到背景等）→ 等待後向後端查詢雲端已收到多少位元組 → 從中斷處續傳。
 *    上傳網址記在本機草稿，重新整理頁面後再選同一張照片，也會從中斷處繼續。
 * 4. 直接上傳連續失敗、但後端連得上（例如網路或 CORS 限制）→ 改由後端代傳分塊。
 */
class UploadError extends Error {}
const OFFLINE_MSG = "網路連線不穩，照片尚未上傳完成。請確認網路後再按一次「送出問卷」，會從中斷處繼續上傳，已上傳的部分不用重傳。";
const sameFile = (u, f) => !!(u && f && u.name === f.name && u.size === f.size && u.lastModified === f.lastModified);
function rememberUpload(kind, info) { state.uploads[kind] = info; saveDraft(); }
function forgetUpload(kind) { delete state.uploads[kind]; saveDraft(); }

/** 等待重試：最長 30 秒；網路恢復或頁面回到前景時提早繼續 */
function waitRetry(n) {
  const ms = Math.min(30000, 1000 * Math.pow(2, n));
  return new Promise(resolve => {
    let done = false;
    const finish = () => { if (done) return; done = true; clearTimeout(t); window.removeEventListener("online", finish); document.removeEventListener("visibilitychange", onVis); resolve(); };
    const onVis = () => { if (document.visibilityState === "visible") setTimeout(finish, 500); };
    const t = setTimeout(finish, ms);
    window.addEventListener("online", finish);
    document.addEventListener("visibilitychange", onVis);
  });
}

/** 直接把一個分塊 PUT 到上傳網址（用 XHR 才能回報上傳進度） */
function putDirect(url, blob, start, total, onBytes) {
  return new Promise(resolve => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url, true);
    xhr.timeout = CONFIG.CHUNK_TIMEOUT_MS;
    xhr.setRequestHeader("Content-Range", `bytes ${start}-${start + blob.size - 1}/${total}`);
    xhr.upload.onprogress = e => onBytes(e.loaded);
    xhr.onload = () => {
      let fileId = "";
      if (xhr.status === 200 || xhr.status === 201) { try { fileId = JSON.parse(xhr.responseText).id || ""; } catch (e) {} }
      const m = String(xhr.getResponseHeader("Range") || "").match(/bytes=0-(\d+)/);
      // 308 但讀不到 Range 標頭時，先假設整個分塊已收到；若不正確，下一個分塊失敗時會向後端查詢正確位置
      resolve({ status: xhr.status, next: m ? Number(m[1]) + 1 : start + blob.size, fileId });
    };
    xhr.onerror = xhr.ontimeout = xhr.onabort = () => resolve({ status: 0 });
    xhr.send(blob);
  });
}

/** 由後端代傳一個分塊（備援） */
async function putProxy(up, kind, blob, start, total) {
  let res;
  try {
    const data = await blobToBase64(blob);
    res = await postJson({ action: "surveyUploadChunk", session: SESSION, submissionId: state.submissionId, kind, url: up.url, start, total, data }, CONFIG.CHUNK_TIMEOUT_MS);
  } catch (e) { return { status: 0 }; }
  if (!res || !res.chunk) return { status: res && res.ok === false && res.error !== "upload" ? 400 : 0, message: res && res.message };
  if (res.done) return { status: 200, fileId: res.fileId };
  if (res.expired) return { status: 404 };
  if (res.status === 308) return { status: 308, next: res.next };
  return { status: res.status || 0, message: res.message };
}

/** 向後端查詢上傳進度 → { done, fileId } | { status: 308, next } | { expired } | null（連不到後端） */
async function uploadStatus(up, kind, total) {
  try {
    const r = await getJson({ action: "surveyUploadStatus", session: SESSION, submissionId: state.submissionId, kind, url: up.url, total });
    return r && r.uploadStatus ? r : (r && r.ok === false ? r : null);
  } catch (e) { return null; }
}

/** 向後端申請可續傳上傳網址 */
async function newUploadSession(kind, file) {
  for (let i = 1; ; i++) {
    let r = null;
    try {
      r = await getJson({
        action: "surveyUploadUrl", session: SESSION, submissionId: state.submissionId, kind,
        empId: state.record.empId, type: file.type || "", ext: fileExt(file), size: file.size, origin: location.origin
      });
    } catch (e) { r = null; }
    if (r && r.ok && r.uploadUrl) {
      const up = { url: r.uploadUrl, mode: "direct", name: file.name, size: file.size, lastModified: file.lastModified, fileId: "" };
      rememberUpload(kind, up);
      return up;
    }
    if (r && r.ok === false && r.error !== "server") {
      const err = new UploadError(r.message || "無法建立上傳連線。");
      err.code = r.error; err.no = r.no;
      throw err;
    }
    if (i >= CONFIG.MAX_RETRIES) throw new UploadError(r && r.message ? r.message : OFFLINE_MSG);
    uploadNote("連線中斷，正在重新連線…");
    await waitRetry(i);
  }
}

/** 上傳一個檔案（分塊、可續傳），回傳雲端硬碟檔案 ID */
async function uploadFile(kind, file, report) {
  const total = file.size;
  let up = sameFile(state.uploads[kind], file) ? state.uploads[kind] : null;
  if (up && up.fileId) { report(total); return up.fileId; }
  let offset = up ? null : 0;           // null＝先查詢雲端已收到多少（續傳）
  let failures = 0, directFails = 0, restarts = 0;
  if (!up) up = await newUploadSession(kind, file);
  const finish = id => { up.fileId = id; rememberUpload(kind, up); report(total); return id; };
  const restart = async () => {
    if (++restarts > 2) throw new UploadError("上傳連線已失效，請重新整理頁面後再試一次。");
    forgetUpload(kind);
    up = await newUploadSession(kind, file);
    offset = 0;
  };

  for (;;) {
    if (offset === null) {
      const st = await uploadStatus(up, kind, total);
      if (st && st.done && st.fileId) return finish(st.fileId);
      if (st && st.expired) { await restart(); continue; }
      if (st && st.status === 308) {
        offset = st.next;
        report(offset);
        // 直接上傳連續失敗、但後端連得上：改由後端代傳
        if (up.mode === "direct" && directFails >= CONFIG.DIRECT_FAILS_BEFORE_PROXY) { up.mode = "proxy"; rememberUpload(kind, up); }
      } else if (st && st.ok === false) {
        throw new UploadError(st.message || "上傳失敗，請稍後再試。");
      } else {
        if (++failures > CONFIG.MAX_RETRIES) throw new UploadError(OFFLINE_MSG);
        uploadNote("網路連線中斷，恢復後會自動從中斷處繼續上傳…");
        await waitRetry(failures);
        continue;
      }
    }
    if (offset >= total) { offset = null; continue; }   // 已全部送出但沒收到完成回應：查詢結果

    const blob = file.slice(offset, Math.min(offset + CONFIG.CHUNK_BYTES, total));
    const start = offset;
    const res = up.mode === "direct"
      ? await putDirect(up.url, blob, start, total, n => report(start + n))
      : await putProxy(up, kind, blob, start, total);

    if (res.status === 200 || res.status === 201) {
      if (res.fileId) return finish(res.fileId);
      offset = null; continue;
    }
    if (res.status === 308) {
      offset = res.next; failures = 0; directFails = 0;
      report(offset);
      uploadNote("");
      continue;
    }
    if (res.status === 404 || res.status === 410) { await restart(); continue; }
    if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429) {
      throw new UploadError(res.message || `照片上傳失敗（HTTP ${res.status}），請稍後再試，或洽教學部（分機 57440）。`);
    }
    // 0（網路中斷）、5xx、408、429：等待後查詢進度，從中斷處續傳
    if (up.mode === "direct" && res.status === 0) directFails++;
    if (++failures > CONFIG.MAX_RETRIES) throw new UploadError(OFFLINE_MSG);
    uploadNote("網路不穩，稍後會自動從中斷處繼續上傳…");
    await waitRetry(failures);
    offset = null;
  }
}

function uploadNote(text) { const n = $("#overlayNote"); if (n) n.textContent = text; }

/* ---------- 進度與檢查 ---------- */
function answers() {
  const out = [];
  for (let i = 1; i <= QUESTION_COUNT; i++) { const c = $(`input[name=q${i}]:checked`); out.push(c ? Number(c.value) : 0); }
  return out;
}
const storyLength = () => Array.from($("#story").value.trim()).length;

function missing() {
  const m = [];
  if (state.blocked) m.push({ text: "此人事號已填寫過本梯次問卷", el: "#step1" });
  else if (!state.record) m.push({ text: "人事號查詢", el: "#step1" });
  const unanswered = answers().map((v, i) => v ? 0 : i + 1).filter(Boolean);
  if (unanswered.length) m.push({ text: `第 ${unanswered.join("、")} 題`, el: "#qbox" + unanswered[0] });
  if (!state.photo) m.push({ text: "活動照", el: "#photoUpload" });
  if (storyLength() < CONFIG.STORY_MIN) m.push({ text: "最感動的一段話", el: "#storyField" });
  return m;
}

function updateProgress() {
  const a = answers().filter(Boolean).length;
  $("#answeredCount").textContent = a;
  const n = storyLength();
  const sc = $("#storyCount");
  sc.textContent = n;
  sc.className = n >= CONFIG.STORY_MIN ? "enough" : n ? "short" : "";
  const done = (state.record ? 1 : 0) + a * 0.5 + (state.photo ? 1 : 0) + (n >= CONFIG.STORY_MIN ? 1 : 0);
  const total = 1 + QUESTION_COUNT * 0.5 + 1 + 1;
  $("#progressBar").style.width = Math.round(done / total * 100) + "%";
  const m = missing();
  $("#todo").innerHTML = state.blocked
    ? `<b>您已填寫過${esc(SESSION)}問卷（編號 ${esc(state.blocked)}），每人限填寫一次。</b>`
    : m.length ? `尚未完成：<b>${m.map(x => esc(x.text)).join("、")}</b>` : "✔ 全部完成，可以送出了！";
  if (!state.submitting) $("#submitBtn").disabled = state.done || !!state.blocked;
}

function markInvalid() {
  $("#empField").classList.toggle("invalid", !state.record && !normalizeId($("#empId").value));
  answers().forEach((v, i) => $("#qbox" + (i + 1)).classList.toggle("invalid", !v));
  $("#photoUpload").classList.toggle("invalid", !state.photo);
  $("#storyField").classList.toggle("invalid", storyLength() < CONFIG.STORY_MIN);
}

/* ---------- 送出 ---------- */
function overlay(on, title, text, bar) {
  const o = $("#overlay");
  o.classList.toggle("open", !!on);
  if (title) $("#overlayTitle").textContent = title;
  if (text != null) $("#overlayText").textContent = text;
  if (bar != null) { $("#overlayBarWrap").classList.toggle("show", !!bar); if (bar) $("#overlayBar").style.width = "0%"; }
  if (!on || title) uploadNote("");
}
function showMsg(text) {
  const m = $("#formMsg");
  if (!text) { m.className = "form-msg"; m.textContent = ""; return; }
  m.className = "form-msg error";
  m.textContent = text;
}

/**
 * 送出並確保「確實寫入」：
 * 回應不明確（Google 把 POST 轉成 GET 執行、網路中斷、系統忙碌）時，先以送出代碼查詢是否已寫入，
 * 已寫入就直接視為成功；沒有才重送（最多 3 次）。後端也會以送出代碼擋掉重複寫入。
 */
async function sendSurvey(payload) {
  let last = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    if (attempt > 1) {
      overlay(true, "重新傳送中…", `第 ${attempt} 次嘗試，請勿關閉頁面。`);
      await sleep(1500 * attempt + Math.random() * 1500);
    }
    let res = null;
    try { res = await postJson(payload); } catch (e) { res = null; }
    if (res && res.ok && res.submitted) return res;
    if (res && res.ok === false && res.error !== "busy" && res.error !== "server") return res;   // 資料問題：不重送
    if (res && res.ok === false) last = res;
    overlay(true, "確認中…", "正在確認問卷是否已送達。");
    try {
      const st = await getJson({ action: "surveyStatus", session: SESSION, id: payload.submissionId });
      if (st && st.found) return { ok: true, submitted: true, no: st.no, name: state.record && state.record.name, social: !!payload.socialFileId };
    } catch (e) {}
  }
  return last || { ok: false, error: "network", message: "網路連線不穩定，問卷沒有送出。請確認網路後再按一次「送出問卷」，已填寫的內容與照片都還在。" };
}

async function onSubmit(e) {
  e.preventDefault();
  if (state.submitting || state.done) return;
  showMsg("");
  const btn = $("#submitBtn");
  btn.disabled = true;
  btn.textContent = "檢查中…";
  try {
    if (normalizeId($("#empId").value) && (!state.record || state.lookedUp !== normalizeId($("#empId").value))) await lookup(true);
    if (state.blocked) {
      showMsg(`您已填寫過${SESSION}問卷（編號 ${state.blocked}），每人限填寫一次；如需修改請洽教學部（分機 57440）。`);
      $("#step1").scrollIntoView({ behavior: "smooth", block: "center" });
      return;
    }
    const m = missing();
    if (m.length) {
      markInvalid();
      showMsg("尚未完成：" + m.map(x => x.text).join("、") + "。");
      const first = $(m[0].el);
      if (first) first.scrollIntoView({ behavior: "smooth", block: "center" });
      return;
    }
    state.submitting = true;

    // 1) 照片：直接分塊上傳到 Google 雲端硬碟（可續傳）
    const jobs = [["photo", state.photo, "活動照"], ["social", state.social, "社群媒體截圖"]].filter(j => j[1]);
    const totalBytes = jobs.reduce((n, j) => n + j[1].blob.size, 0);
    const ids = {};
    let base = 0;
    overlay(true, "上傳照片中…", "", true);
    for (const [kind, f, label] of jobs) {
      const offsetBase = base;
      ids[kind] = await uploadFile(kind, f.blob, n => {
        const sent = offsetBase + n;
        $("#overlayBar").style.width = Math.min(100, sent / totalBytes * 100).toFixed(1) + "%";
        $("#overlayText").textContent = `${label}：${fmtSize(Math.min(n, f.blob.size))}／${fmtSize(f.blob.size)}（全部 ${Math.floor(sent / totalBytes * 100)}%）`;
      });
      base += f.blob.size;
    }

    // 2) 問卷：只送檔案 ID
    overlay(true, "送出問卷中…", "照片已上傳完成，正在寫入問卷。", false);
    const payload = {
      action: "survey",
      session: SESSION,
      submissionId: state.submissionId,
      empId: state.record.empId,
      answers: answers(),
      story: $("#story").value.trim(),
      photoFileId: ids.photo,
      socialFileId: ids.social || ""
    };
    const res = await sendSurvey(payload);
    if (res && res.ok && res.submitted) {
      showDone(res, !!payload.socialFileId);
    } else {
      if (res && res.error === "duplicate") { state.blocked = res.no || "?"; renderProfile(); }
      if (res && res.error === "reupload") { forgetUpload(res.kind || "photo"); refreshPreviews(); }
      showMsg((res && res.message) || "送出失敗，請稍後再試，或洽教學部（分機 57440）。");
      $("#submitCard").scrollIntoView({ behavior: "smooth", block: "center" });
    }
  } catch (err) {
    if (err && err.code === "duplicate") { state.blocked = err.no || "?"; renderProfile(); }
    showMsg(err instanceof UploadError ? err.message : "送出失敗：" + (err && err.message ? err.message : err) + "。請再按一次「送出問卷」，已填寫的內容都還在。");
    $("#submitCard").scrollIntoView({ behavior: "smooth", block: "center" });
  } finally {
    state.submitting = false;
    overlay(false);
    btn.textContent = "送出問卷";
    refreshPreviews();
    updateProgress();
  }
}

function showDone(res, social) {
  state.done = true;
  state.uploads = {};
  clearDraft();
  const r = state.record || {};
  $("#doneSummary").innerHTML = `
    <div><span>問卷編號</span><b>${esc(res.no)}</b></div>
    <div><span>梯次</span><b>${esc(SESSION)}</b></div>
    <div><span>姓名</span><b>${esc(res.name || r.name || "")}</b></div>`;
  $("#doneGift").style.display = social || res.social ? "block" : "none";
  $("#doneModal").classList.add("open");
  $("#doneOk").focus();
}
function closeDone() {
  $("#doneModal").classList.remove("open");
  $("#surveyForm").outerHTML = `
    <section class="card done">
      <div class="seal" style="margin:0 auto">感謝</div>
      <h2>問卷已送出，謝謝您！</h2>
      <p>期待在下一次的活動再見到您。</p>
      <p style="margin-top:1.2rem"><a class="btn btn-outline" href="index.html">${ICONS.home}回活動網頁</a></p>
    </section>`;
  window.scrollTo({ top: 0, behavior: "smooth" });
}

/* ---------- 啟動 ---------- */
function init() {
  if (!SESS) { document.getElementById("app").textContent = "頁面設定錯誤：找不到梯次。"; return; }
  render();
  setupUpload("photo", "#photoUpload", "#photoInput");
  setupUpload("social", "#socialUpload", "#socialInput");

  const emp = $("#empId");
  $("#lookupBtn").addEventListener("click", () => lookup(true));
  emp.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); lookup(true); } });
  emp.addEventListener("blur", () => { if (normalizeId(emp.value) && normalizeId(emp.value) !== state.lookedUp) lookup(false); });
  emp.addEventListener("input", () => {
    if (normalizeId(emp.value) !== state.lookedUp) { state.record = null; state.blocked = null; hideProfile(); }
    updateProgress(); saveDraft();
  });

  $("#surveyForm").addEventListener("change", e => {
    const q = e.target.name && /^q\d+$/.test(e.target.name) ? $("#qbox" + e.target.name.slice(1)) : null;
    if (q) q.classList.remove("invalid");
    updateProgress(); saveDraft();
  });
  $("#story").addEventListener("input", () => {
    if (storyLength() >= CONFIG.STORY_MIN) $("#storyField").classList.remove("invalid");
    updateProgress(); saveDraft();
  });
  $("#surveyForm").addEventListener("submit", onSubmit);
  $("#doneOk").addEventListener("click", closeDone);

  // 還原草稿（人事號、10 題、最感動的一段話、送出代碼與上傳進度；照片需重新選取，選同一張會從中斷處續傳）
  const d = loadDraft();
  if (d) {
    if (d.sid && /^[A-Za-z0-9-]{8,64}$/.test(d.sid)) state.submissionId = d.sid;
    if (d.uploads && typeof d.uploads === "object") state.uploads = d.uploads;
    if (d.empId) emp.value = d.empId;
    Object.keys(d.answers || {}).forEach(i => { const el = $(`#q${i}_${d.answers[i]}`); if (el) el.checked = true; });
    if (d.story) $("#story").value = d.story;
    if (normalizeId(emp.value)) lookup(true);
  }
  updateProgress();

  // 已選照片（照片檔案無法存草稿）或上傳中時，離開頁面前提醒；文字與作答已存在草稿裡
  window.addEventListener("beforeunload", e => {
    if (state.done) return;
    if (state.photo || state.social || state.submitting) { e.preventDefault(); e.returnValue = ""; }
  });
}

init();
})();
