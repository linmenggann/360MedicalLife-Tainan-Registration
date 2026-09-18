/**
 * 360°醫學人生｜走進臺南，走進生活 — 報名後端 (Google Apps Script)
 *
 * 試算表：https://docs.google.com/spreadsheets/d/1vyVq2XwPbz8fI2JZrdNKhxQciLyYH2AzH-Pu_kX3iyI/edit
 * 分頁：
 *   - 活動報名資料（總表）：所有報名資料
 *   - 第一梯次／第二梯次／第三梯次：各梯次的報名資料（同時寫入）
 *
 * 部署步驟：
 * 1. 開啟上述試算表 → 擴充功能 → Apps Script，刪除預設內容後貼上本檔。
 * 2. 在編輯器上方選擇函式「setupSheets」→ 執行，授權後會自動建立四個分頁與表頭。
 *    （也可以之後在試算表選單「報名系統 → 初始化分頁與表頭」執行）
 * 3. 部署 → 新增部署作業 → 類型「網頁應用程式」
 *      執行身分：我　　誰可以存取：所有人
 * 4. 複製「網頁應用程式網址」，貼到 index.html 與 dashboard.html 的 CONFIG.API_URL。
 * 5. 之後若修改程式，需「管理部署作業 → 編輯 → 版本：新版本 → 部署」。
 *
 * 效能設計：
 *   - 讀取（doGet、儀表板）只取得工作表、不做任何格式設定；格式設定只在 setupSheets 執行。
 *   - 名額與儀表板結果以 CacheService 快取 CACHE_SECONDS 秒，成功報名後立即清除快取。
 *
 * 統計試算表備援（選配）：
 *   - 執行「setupStatsPublishing」會建立一個只含統計數字（不含姓名與任何個資）的獨立試算表，
 *     設為「知道連結的任何人可檢視」（供 GViz 端點即時讀取），並安裝每 5 分鐘更新一次的觸發器；
 *     成功報名後也會立即更新。試算表 ID 會隨名額 API 回傳給儀表板。
 *   - 若還要有「發布到網路」的 CSV 備援：在該試算表「檔案 → 共用 → 發布到網路」，
 *     選擇「統計」分頁、格式 CSV，把產生的網址貼到 dashboard.html 的 CONFIG.STATS_CSV_URL。
 */

const SPREADSHEET_ID = '1vyVq2XwPbz8fI2JZrdNKhxQciLyYH2AzH-Pu_kX3iyI';
const MASTER_SHEET = '活動報名資料';
const SESSIONS = ['第一梯次', '第二梯次', '第三梯次'];
const SESSION_DATES = {
  '第一梯次': '115/10/17–10/18',
  '第二梯次': '115/11/14–11/15',
  '第三梯次': '115/11/21–11/22'
};
const LIMITS = {
  '西醫UGY': 8,
  '西醫PGY': 10,
  '醫事職類PGY': 9,
  '臨床教師': 8
};
// "session"：各梯次分別計算名額；"total"：三梯次共用名額（需與 index.html 的 CONFIG.QUOTA_SCOPE 一致）
const QUOTA_SCOPE = 'session';

// 儀表板（dashboard.html）存取金鑰：需與 dashboard.html 的 CONFIG.DASHBOARD_KEY 相同；兩者皆留空則不檢查
const DASHBOARD_KEY = 'chimei360';

// 快取秒數（名額與儀表板資料）
const CACHE_SECONDS = 20;

// 表頭（總表與各梯次分頁相同）
const HEADERS = ['報名時間', '梯次', '身分', '單位', '姓名', '人事號', '職稱', '手機簡碼/分機', 'E-mail', '出生日期', '身分證號', '餐食', '通知寄送時間'];
const COL = {}; HEADERS.forEach((h, i) => COL[h] = i + 1);   // 1-based 欄位索引
const TEXT_COLS = ['人事號', '手機簡碼/分機', '出生日期', '身分證號'];   // 以純文字儲存，避免 0 開頭或日期被自動轉換
const COL_WIDTHS = [150, 90, 110, 140, 90, 90, 120, 130, 220, 110, 120, 70, 150];

// 公開統計試算表（由 setupStatsPublishing 建立，ID 存於指令碼屬性）
const STATS_PROP = 'STATS_SPREADSHEET_ID';
const STATS_SHEET = '統計';
const STATS_TITLE = '360°醫學人生 報名統計（公開，不含個資）';

/* ---- 報名成功／行前資訊通知信 ---- */
const NOTIFY_ON_REGISTER = true;                 // 報名成功後立即寄送通知信
const MAIL_SENDER_NAME = '奇美醫院教學部 林盟淦';   // 寄件人顯示名稱
const MAIL_REPLY_TO = '910632@chimei.org.tw';    // 回覆信箱
const MAIL_FROM_ALIAS = '';                      // 若 Gmail 已設定「以此地址寄件」別名（如 910632@chimei.org.tw）可填入；留空則用帳號本身
const MAIL_SUBJECT_PREFIX = '【報名成功／行前資訊】360°醫學人生｜走進臺南，走進生活';
const PDF_ATTACHMENT_NAME = '360°醫學人生｜走進臺南，走進生活行程v4.pdf';
const PDF_DRIVE_FILE_ID = '';                    // 行程 PDF 的 Google 雲端硬碟檔案 ID（優先使用）；留空則由下列網址下載
const PDF_URL = 'https://linmenggann.github.io/360MedicalLife-Tainan-Registration/assets/itinerary.pdf';
const SESSION_LABELS = {
  '第一梯次': '115 年 10 月 17 日(六)～10 月 18 日(日)',
  '第二梯次': '115 年 11 月 14 日(六)～11 月 15 日(日)',
  '第三梯次': '115 年 11 月 21 日(六)～11 月 22 日(日)'
};
const MEETING_TIME = '第一天 08:50～09:00｜第二天 09:20～09:30';
const MEETING_PLACE = '奇美醫院 第一醫療大樓警衛室前方廣場（710 臺南市永康區中華路 901 號）';
const SIGNATURE_LINES = [
  '奇美醫療財團法人奇美醫院',
  '教學部 林盟淦 教學行政管理員',
  '電話：06-2812811分機57440',
  'Email：910632@chimei.org.tw',
  '地址：71004台南市永康區中華路901號'
];

/* ------------------------------------------------------------------ */
/* 試算表工具                                                          */
/* ------------------------------------------------------------------ */
function ss_() {
  return SpreadsheetApp.openById(SPREADSHEET_ID);
}

/** 輕量取得工作表：不做任何格式設定；分頁不存在時才建立 */
function getSheet_(name) {
  const sheet = ss_().getSheetByName(name);
  return sheet || ensureSheet_(name);
}

/** 建立／校正分頁與表頭（只在 setupSheets 或分頁不存在時執行） */
function ensureSheet_(name) {
  const ss = ss_();
  let sheet = ss.getSheetByName(name);
  if (!sheet) sheet = ss.insertSheet(name);

  const headerRange = sheet.getRange(1, 1, 1, HEADERS.length);
  const existing = headerRange.getValues()[0].map(String);
  const same = existing.every((v, i) => v === HEADERS[i]);
  if (!same) headerRange.setValues([HEADERS]);

  headerRange
    .setFontWeight('bold')
    .setBackground('#b4432f')
    .setFontColor('#ffffff')
    .setHorizontalAlignment('center')
    .setVerticalAlignment('middle');
  sheet.setFrozenRows(1);
  sheet.setRowHeight(1, 32);
  COL_WIDTHS.forEach((w, i) => sheet.setColumnWidth(i + 1, w));
  TEXT_COLS.forEach(h => sheet.getRange(2, COL[h], sheet.getMaxRows() - 1, 1).setNumberFormat('@'));
  sheet.getRange(2, COL['報名時間'], sheet.getMaxRows() - 1, 1).setNumberFormat('yyyy/MM/dd HH:mm:ss');
  return sheet;
}

/** 建立／校正總表與三個梯次分頁（可重複執行，不會清除既有資料） */
function setupSheets() {
  const ss = ss_();
  const master = ensureSheet_(MASTER_SHEET);
  SESSIONS.forEach(s => ensureSheet_(s));

  // 分頁排序：總表在最前，三梯次依序排列
  ss.setActiveSheet(master); ss.moveActiveSheet(1);
  SESSIONS.forEach((s, i) => { ss.setActiveSheet(ss.getSheetByName(s)); ss.moveActiveSheet(i + 2); });

  // 若試算表只有預設的空白「工作表1」，將其刪除
  const def = ss.getSheetByName('工作表1') || ss.getSheetByName('Sheet1');
  if (def && def.getLastRow() === 0 && ss.getSheets().length > 4) ss.deleteSheet(def);

  ss.setActiveSheet(master);
  SpreadsheetApp.flush();
  clearCache_();
  Logger.log('分頁與表頭已建立：' + [MASTER_SHEET].concat(SESSIONS).join('、'));
}

/** 試算表選單 */
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('報名系統')
    .addItem('初始化分頁與表頭', 'setupSheets')
    .addItem('顯示各梯次名額統計', 'showCounts')
    .addSeparator()
    .addItem('建立公開統計試算表（GViz / CSV 備援）', 'setupStatsPublishing')
    .addItem('立即更新公開統計', 'publishStats')
    .addItem('統計試算表設為連結可檢視', 'shareStatsSpreadsheet')
    .addItem('清除快取', 'clearCache_')
    .addSeparator()
    .addItem('預覽通知信（寄給自己）', 'previewNotificationEmail')
    .addItem('補寄尚未通知的報名者', 'sendPendingNotifications')
    .addToUi();
}

function showCounts() {
  const counts = getCounts_(getSheet_(MASTER_SHEET));
  const lines = SESSIONS.map(s => s + '（' + SESSION_DATES[s] + '）：' +
    Object.keys(LIMITS).map(k => k + ' ' + counts[s][k] + '/' + LIMITS[k]).join('、'));
  SpreadsheetApp.getUi().alert('各梯次已報名人數\n\n' + lines.join('\n'));
}

/* ------------------------------------------------------------------ */
/* 快取                                                                */
/* ------------------------------------------------------------------ */
function cache_() { return CacheService.getScriptCache(); }
function cacheGet_(key) {
  try { const v = cache_().get(key); return v ? JSON.parse(v) : null; } catch (e) { return null; }
}
function cachePut_(key, obj) {
  try { cache_().put(key, JSON.stringify(obj), CACHE_SECONDS); } catch (e) { /* 超過大小限制時略過 */ }
}
function clearCache_() {
  try { cache_().removeAll(['counts', 'dashboard']); } catch (e) {}
}

/* ------------------------------------------------------------------ */
/* 資料讀取與統計                                                      */
/* ------------------------------------------------------------------ */
function emptyCounts_() {
  const c = {};
  SESSIONS.forEach(s => { c[s] = {}; Object.keys(LIMITS).forEach(k => c[s][k] = 0); });
  return c;
}

/** 總表所有資料列（一次讀取） */
function readMaster_(master) {
  const last = master.getLastRow();
  if (last < 2) return [];
  return master.getRange(2, 1, last - 1, HEADERS.length).getValues()
    .filter(r => String(r[COL['姓名'] - 1]).trim() !== '');
}

/** 由資料列統計各梯次、各身分已報名人數 */
function countsFromRows_(rows) {
  const counts = emptyCounts_();
  rows.forEach(r => {
    const s = String(r[COL['梯次'] - 1]).trim(), k = String(r[COL['身分'] - 1]).trim();
    if (counts[s] && counts[s][k] !== undefined) counts[s][k]++;
  });
  return counts;
}

function getCounts_(master) {
  return countsFromRows_(readMaster_(master));
}

/** 儀表板用的報名名單：只回傳非敏感欄位（不含 E-mail、手機、出生日期、身分證號） */
function registrationsFromRows_(rows) {
  return rows.map(r => {
    const t = r[COL['報名時間'] - 1];
    return {
      ts: (t instanceof Date) ? t.toISOString() : String(t),
      session: String(r[COL['梯次'] - 1]).trim(),
      identity: String(r[COL['身分'] - 1]).trim(),
      unit: String(r[COL['單位'] - 1]).trim(),
      name: String(r[COL['姓名'] - 1]).trim(),
      empId: String(r[COL['人事號'] - 1]).trim(),
      title: String(r[COL['職稱'] - 1]).trim(),
      meal: String(r[COL['餐食'] - 1]).trim()
    };
  });
}

function usedCount_(counts, session, identity) {
  if (QUOTA_SCOPE === 'total') {
    return SESSIONS.reduce((n, s) => n + counts[s][identity], 0);
  }
  return counts[session][identity];
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function countsPayload_(counts) {
  return {
    ok: true,
    counts: counts,
    limits: LIMITS,
    sessions: SESSIONS,
    quotaScope: QUOTA_SCOPE,
    statsSpreadsheetId: PropertiesService.getScriptProperties().getProperty(STATS_PROP) || '',
    statsSheet: STATS_SHEET,
    ts: new Date().toISOString()
  };
}

/* ------------------------------------------------------------------ */
/* Web App                                                             */
/* ------------------------------------------------------------------ */

/** GET：回傳各梯次、各身分已報名人數與限額（有快取） */
function doGet(e) {
  const cached = cacheGet_('counts');
  if (cached) { cached.cached = true; return json_(cached); }
  const payload = countsPayload_(getCounts_(getSheet_(MASTER_SHEET)));
  cachePut_('counts', payload);
  return json_(payload);
}

/** POST：新增一筆報名（body 為 JSON 字串），或儀表板資料查詢（action=dashboard） */
function doPost(e) {
  let d;
  try {
    d = JSON.parse(e.postData.contents);
  } catch (err) {
    return json_({ ok: false, error: 'invalid', message: '無法解析資料' });
  }

  // 儀表板資料（不需鎖定）
  if (d.action === 'dashboard') {
    if (DASHBOARD_KEY && String(d.key || '') !== DASHBOARD_KEY) {
      return json_({ ok: false, error: 'unauthorized', message: '金鑰不正確' });
    }
    const cached = cacheGet_('dashboard');
    if (cached) { cached.cached = true; return json_(cached); }
    const rows = readMaster_(getSheet_(MASTER_SHEET));
    const payload = countsPayload_(countsFromRows_(rows));
    payload.sessionDates = SESSION_DATES;
    payload.registrations = registrationsFromRows_(rows);
    cachePut_('dashboard', payload);
    return json_(payload);
  }

  // 報名寫入（需鎖定避免同時報名超額）
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const required = ['session', 'identity', 'unit', 'name', 'empId', 'title', 'phone', 'email', 'birth', 'nationalId', 'meal'];
    for (const k of required) {
      if (d[k] === undefined || d[k] === null || String(d[k]).trim() === '') {
        return json_({ ok: false, error: 'invalid', message: '缺少欄位：' + k });
      }
    }
    const session = String(d.session).trim();
    const identity = String(d.identity).trim();
    const empId = String(d.empId).trim();
    const nationalId = String(d.nationalId).trim().toUpperCase();

    if (SESSIONS.indexOf(session) === -1) return json_({ ok: false, error: 'invalid', message: '梯次不正確' });
    if (LIMITS[identity] === undefined) return json_({ ok: false, error: 'invalid', message: '身分不正確' });
    if (!/^[A-Z][1289]\d{8}$/.test(nationalId)) return json_({ ok: false, error: 'invalid', message: '身分證號格式不正確' });
    if (['葷食', '素食'].indexOf(String(d.meal)) === -1) return json_({ ok: false, error: 'invalid', message: '餐食不正確' });

    const master = getSheet_(MASTER_SHEET);
    const rows = readMaster_(master);
    const counts = countsFromRows_(rows);

    // 重複報名檢查（總表，跨所有梯次）：每人限報名一個梯次
    // 以「人事號」或「身分證號」任一相同即視為同一人
    for (const r of rows) {
      const sameEmp = String(r[COL['人事號'] - 1]).trim().toUpperCase() === empId.toUpperCase();
      const sameId = String(r[COL['身分證號'] - 1]).trim().toUpperCase() === nationalId;
      if (sameEmp || sameId) {
        const which = sameEmp ? '此人事號' : '此身分證號';
        return json_({
          ok: false, error: 'duplicate', counts: counts,
          message: which + '已報名' + String(r[COL['梯次'] - 1]).trim() + '，每人限報名一個梯次；如需更改梯次請聯絡教學部（分機 57440）。'
        });
      }
    }

    // 名額檢查
    if (usedCount_(counts, session, identity) >= LIMITS[identity]) {
      return json_({ ok: false, error: 'full', counts: counts, message: session + '的「' + identity + '」名額已額滿，請改選其他梯次或洽教學部詢問候補。' });
    }

    const row = [
      new Date(),
      session,
      identity,
      String(d.unit).trim(),
      String(d.name).trim(),
      empId,
      String(d.title).trim(),
      String(d.phone).trim(),
      String(d.email).trim(),
      String(d.birth).trim(),
      nationalId,
      String(d.meal).trim()
    ];
    const sessionSheet = getSheet_(session);
    const masterRow = appendRow_(master, row);
    const sessionRow = appendRow_(sessionSheet, row);
    SpreadsheetApp.flush();
    clearCache_();

    counts[session][identity]++;

    // 通知信與公開統計改為背景作業（約一分鐘內執行），讓報名立即回覆
    const queued = scheduleBackgroundJob_();

    return json_({ ok: true, counts: counts, queued: queued });
  } finally {
    lock.releaseLock();
  }
}

/* ------------------------------------------------------------------ */
/* 背景作業：寄通知信、更新公開統計                                    */
/* ------------------------------------------------------------------ */
const BACKGROUND_JOB = 'processRegistrationQueue';

/** 建立一次性的時間觸發器（若已有待執行的就不重複建立） */
function scheduleBackgroundJob_() {
  try {
    const pending = ScriptApp.getProjectTriggers().some(t => t.getHandlerFunction() === BACKGROUND_JOB);
    if (!pending) ScriptApp.newTrigger(BACKGROUND_JOB).timeBased().after(1000).create();
    return true;
  } catch (err) {
    Logger.log('無法建立背景作業觸發器：' + err);
    return false;
  }
}

/** 背景作業本體：刪除自己的一次性觸發器 → 補寄通知信 → 更新公開統計 */
function processRegistrationQueue() {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === BACKGROUND_JOB)
    .forEach(t => { try { ScriptApp.deleteTrigger(t); } catch (e) {} });

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) { Logger.log('背景作業：取得鎖定逾時，下次再試'); scheduleBackgroundJob_(); return; }
  try {
    if (NOTIFY_ON_REGISTER) {
      try { sendPendingNotifications(); } catch (err) { Logger.log('背景寄信失敗：' + err); }
    }
    try { publishStats(); } catch (err) { Logger.log('publishStats 失敗：' + err); }
  } finally {
    lock.releaseLock();
  }
}

/** 寫入一列，文字欄位先設為純文字格式，避免自動轉換；回傳列號 */
function appendRow_(sheet, row) {
  const r = sheet.getLastRow() + 1;
  TEXT_COLS.forEach(h => sheet.getRange(r, COL[h]).setNumberFormat('@'));
  sheet.getRange(r, COL['報名時間']).setNumberFormat('yyyy/MM/dd HH:mm:ss');
  sheet.getRange(r, 1, 1, row.length).setValues([row]);
  return r;
}

/* ------------------------------------------------------------------ */
/* 報名成功／行前資訊通知信                                            */
/* ------------------------------------------------------------------ */

/** 試算表資料列 → 通知信所需欄位 */
function rowToReg_(row) {
  return {
    session: String(row[COL['梯次'] - 1]).trim(),
    identity: String(row[COL['身分'] - 1]).trim(),
    unit: String(row[COL['單位'] - 1]).trim(),
    name: String(row[COL['姓名'] - 1]).trim(),
    empId: String(row[COL['人事號'] - 1]).trim(),
    title: String(row[COL['職稱'] - 1]).trim(),
    email: String(row[COL['E-mail'] - 1]).trim(),
    meal: String(row[COL['餐食'] - 1]).trim()
  };
}

function esc_(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** 產生通知信的主旨、純文字與 HTML 內容 */
function buildNotificationEmail_(reg) {
  const sessionLabel = SESSION_LABELS[reg.session] || reg.session;
  const subject = MAIL_SUBJECT_PREFIX + '（' + reg.session + '）';

  const day1 = [
    ['08:50–09:00', '集合'],
    ['09:30–11:00', '城市經典｜老派台南的神級日常 × 散步導覽（含導覽點心）'],
    ['11:30–12:40', '午宴：府城食府 新仁店'],
    ['13:30–14:30', '四草綠色隧道巡河之旅（遊船）'],
    ['15:00–16:00', '安平徒步導覽'],
    ['16:00–17:00', '賦歸']
  ];
  const day2 = [
    ['09:20–09:30', '集合'],
    ['10:30–12:30', '菁寮老街百年聚落導覽＆手作傳統米食（手作紅龜粿）'],
    ['12:30–13:30', '午宴：俗女餐桌'],
    ['14:30–17:00', '大崎聚落散策＋村落特色 DIY 二擇一'],
    ['17:00–18:00', '賦歸']
  ];
  const notes = [
    '請依集合時間準時報到上車，逾時不候。',
    '行程含旅行責任保險、午宴、遊船與 DIY 體驗，餐食依報名資料安排（' + reg.meal + '）。',
    '建議穿著輕便服裝與好走的鞋，並自備水壺、帽子、防曬及雨具。',
    '若您因故無法參加，敬請提前致電教學部林盟淦（分機 57440），以利候補同仁遞補參與，謝謝。',
    '完整行程請見附件「' + PDF_ATTACHMENT_NAME + '」。'
  ];

  // ---- 純文字 ----
  const t = [];
  t.push(reg.name + ' 您好，');
  t.push('');
  t.push('恭喜您已成功報名「360°醫學人生｜走進臺南，走進生活」' + reg.session + '，活動相關資訊如下，敬請預留時間準時出席：');
  t.push('');
  t.push('【報名資料】');
  t.push('梯次：' + reg.session + '（' + sessionLabel + '）');
  t.push('身分：' + reg.identity);
  t.push('單位／職稱：' + reg.unit + '／' + reg.title);
  t.push('餐食：' + reg.meal);
  t.push('');
  t.push('【活動資訊】');
  t.push('日期：' + sessionLabel);
  t.push('集合時間：' + MEETING_TIME);
  t.push('集合地點：' + MEETING_PLACE);
  t.push('');
  t.push('【兩日行程】');
  t.push('Day 1｜台南老城・安平');
  day1.forEach(x => t.push('  ' + x[0] + '｜' + x[1]));
  t.push('Day 2｜台南後壁菁寮・官田大崎');
  day2.forEach(x => t.push('  ' + x[0] + '｜' + x[1]));
  t.push('');
  t.push('【注意事項】');
  notes.forEach(n => t.push('・' + n));
  t.push('');
  t.push('');
  t.push('＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝');
  SIGNATURE_LINES.forEach(l => t.push(l));
  t.push('＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝');
  const text = t.join('\n');

  // ---- HTML ----
  const li = arr => arr.map(x => '<tr><td style="padding:3px 10px 3px 0;white-space:nowrap;color:#8a2f22;font-weight:bold">' + esc_(x[0]) + '</td><td style="padding:3px 0">' + esc_(x[1]) + '</td></tr>').join('');
  const html =
    '<div style="font-family:微軟正黑體,Microsoft JhengHei,PingFang TC,sans-serif;font-size:15px;line-height:1.7;color:#2b2a28;max-width:720px">' +
    '<div style="border-left:6px solid #b4432f;padding:6px 14px;margin-bottom:16px;background:#fbf7ee">' +
    '<div style="font-size:14px;color:#8a2f22;letter-spacing:.1em">奇美醫院教學部</div>' +
    '<div style="font-size:24px;font-weight:bold;color:#1f3a3d">360°醫學人生｜走進臺南，走進生活</div>' +
    '<div style="font-size:16px;color:#b4432f;font-weight:bold">報名成功通知 &amp; 行前資訊 &#x1F4E2;</div>' +
    '</div>' +
    '<p><b>' + esc_(reg.name) + '</b> 您好，</p>' +
    '<p>恭喜您已成功報名「<b>360°醫學人生｜走進臺南，走進生活</b>」<b style="color:#b4432f">' + esc_(reg.session) + '</b>，活動相關資訊如下，敬請預留時間準時出席：</p>' +
    '<h3 style="font-size:16px;color:#1f3a3d;border-bottom:2px solid #d9a441;padding-bottom:4px;margin:20px 0 8px">【報名資料】</h3>' +
    '<table style="border-collapse:collapse;font-size:15px">' +
    '<tr><td style="padding:3px 12px 3px 0;color:#5f5a53">梯次</td><td style="padding:3px 0"><b>' + esc_(reg.session) + '</b>（' + esc_(sessionLabel) + '）</td></tr>' +
    '<tr><td style="padding:3px 12px 3px 0;color:#5f5a53">身分</td><td style="padding:3px 0">' + esc_(reg.identity) + '</td></tr>' +
    '<tr><td style="padding:3px 12px 3px 0;color:#5f5a53">單位／職稱</td><td style="padding:3px 0">' + esc_(reg.unit) + '／' + esc_(reg.title) + '</td></tr>' +
    '<tr><td style="padding:3px 12px 3px 0;color:#5f5a53">餐食</td><td style="padding:3px 0">' + esc_(reg.meal) + '</td></tr>' +
    '</table>' +
    '<h3 style="font-size:16px;color:#1f3a3d;border-bottom:2px solid #d9a441;padding-bottom:4px;margin:20px 0 8px">【活動資訊】</h3>' +
    '<ul style="margin:0;padding-left:20px">' +
    '<li><b>日期：</b><span style="color:#b4432f;font-weight:bold">' + esc_(sessionLabel) + '</span></li>' +
    '<li><b>集合時間：</b>' + esc_(MEETING_TIME) + '</li>' +
    '<li><b>集合地點：</b>' + esc_(MEETING_PLACE) + '</li>' +
    '</ul>' +
    '<h3 style="font-size:16px;color:#1f3a3d;border-bottom:2px solid #d9a441;padding-bottom:4px;margin:20px 0 8px">【兩日行程】</h3>' +
    '<p style="margin:6px 0 2px"><b>Day 1｜台南老城・安平</b></p><table style="border-collapse:collapse;font-size:14px">' + li(day1) + '</table>' +
    '<p style="margin:12px 0 2px"><b>Day 2｜台南後壁菁寮・官田大崎</b></p><table style="border-collapse:collapse;font-size:14px">' + li(day2) + '</table>' +
    '<h3 style="font-size:16px;color:#1f3a3d;border-bottom:2px solid #d9a441;padding-bottom:4px;margin:20px 0 8px">【注意事項】</h3>' +
    '<ul style="margin:0;padding-left:20px">' + notes.map(n => '<li>' + esc_(n) + '</li>').join('') + '</ul>' +
    '<br><br>' +
    '<div style="font-size:13px;color:#5f5a53;line-height:1.6">' +
    '＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝<br>' +
    SIGNATURE_LINES.map(esc_).join('<br>') + '<br>' +
    '＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝' +
    '</div></div>';

  return { subject: subject, text: text, html: html };
}

/** 取得行程 PDF 附件（優先雲端硬碟檔案，否則由網址下載） */
function getItineraryPdfBlob_() {
  let blob;
  if (PDF_DRIVE_FILE_ID) {
    blob = DriveApp.getFileById(PDF_DRIVE_FILE_ID).getBlob();
  } else {
    const res = UrlFetchApp.fetch(PDF_URL, { muteHttpExceptions: true });
    if (res.getResponseCode() !== 200) throw new Error('無法下載行程 PDF：HTTP ' + res.getResponseCode());
    blob = res.getBlob();
  }
  return blob.setName(PDF_ATTACHMENT_NAME).setContentType('application/pdf');
}

/** 寄出一封通知信（pdfBlob 可預先取得後重複使用，避免每封信都重新下載附件） */
function sendNotificationEmail_(reg, overrideTo, pdfBlob) {
  const to = overrideTo || reg.email;
  if (!to || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) throw new Error('E-mail 格式不正確：' + to);
  const mail = buildNotificationEmail_(reg);
  const opts = {
    name: MAIL_SENDER_NAME,
    replyTo: MAIL_REPLY_TO,
    htmlBody: mail.html,
    attachments: [pdfBlob || getItineraryPdfBlob_()]
  };
  if (MAIL_FROM_ALIAS) opts.from = MAIL_FROM_ALIAS;
  GmailApp.sendEmail(to, mail.subject, mail.text, opts);
}

/**
 * 預覽：把通知信寄到「自己的信箱」（執行者的 Google 帳號），內容用總表第一筆報名資料；
 * 若尚無報名資料則用範例資料。不會寄給報名者，也不會標記寄送時間。
 */
function previewNotificationEmail() {
  const rows = readMaster_(getSheet_(MASTER_SHEET));
  const reg = rows.length ? rowToReg_(rows[0]) : {
    session: '第一梯次', identity: '西醫PGY', unit: '內科部', name: '王小明', empId: '000000',
    title: '住院醫師', email: 'sample@chimei.org.tw', meal: '葷食'
  };
  const me = Session.getActiveUser().getEmail() || Session.getEffectiveUser().getEmail();
  sendNotificationEmail_(reg, me);
  const msg = '預覽信已寄到 ' + me + '（內容為：' + reg.name + '／' + reg.session + '）';
  Logger.log(msg);
  try { SpreadsheetApp.getUi().alert(msg); } catch (e) {}
}

/**
 * 補寄：對總表中「通知寄送時間」為空的報名者寄送通知信，並在總表與梯次分頁標記時間。
 * 可重複執行，已寄過的不會再寄。
 */
function sendPendingNotifications() {
  const master = getSheet_(MASTER_SHEET);
  const last = master.getLastRow();
  if (last < 2) { Logger.log('沒有報名資料'); return; }
  const values = master.getRange(2, 1, last - 1, HEADERS.length).getValues();
  const pendingRows = values.map((row, i) => ({ row, r: i + 2 }))
    .filter(x => String(x.row[COL['姓名'] - 1]).trim() !== '' && !x.row[COL['通知寄送時間'] - 1]);
  if (!pendingRows.length) { Logger.log('沒有待寄的通知信'); return; }
  let sent = 0, failed = 0;
  const pdfBlob = getItineraryPdfBlob_();   // 附件只下載一次，所有信件共用
  pendingRows.forEach(({ row, r }) => {
    const reg = rowToReg_(row);
    try {
      sendNotificationEmail_(reg, null, pdfBlob);
      const stamp = new Date();
      master.getRange(r, COL['通知寄送時間']).setValue(stamp).setNumberFormat('yyyy/MM/dd HH:mm:ss');
      markSessionNotified_(reg, stamp);
      sent++;
    } catch (err) {
      failed++;
      Logger.log('寄送失敗 ' + reg.name + ' <' + reg.email + '>：' + err);
    }
  });
  const msg = '通知信補寄完成：成功 ' + sent + ' 封，失敗 ' + failed + ' 封（詳見執行紀錄）';
  Logger.log(msg);
  try { SpreadsheetApp.getUi().alert(msg); } catch (e) {}
}

/** 在梯次分頁找到同一人事號的列，標記通知寄送時間 */
function markSessionNotified_(reg, stamp) {
  const sheet = ss_().getSheetByName(reg.session);
  if (!sheet) return;
  const last = sheet.getLastRow();
  if (last < 2) return;
  const ids = sheet.getRange(2, COL['人事號'], last - 1, 1).getValues();
  for (let i = 0; i < ids.length; i++) {
    if (String(ids[i][0]).trim().toUpperCase() === String(reg.empId).trim().toUpperCase()) {
      sheet.getRange(i + 2, COL['通知寄送時間']).setValue(stamp).setNumberFormat('yyyy/MM/dd HH:mm:ss');
      return;
    }
  }
}

/* ------------------------------------------------------------------ */
/* 公開統計試算表（CSV 備援）                                          */
/* ------------------------------------------------------------------ */

/**
 * 一次性設定：建立公開統計試算表、安裝每 5 分鐘的更新觸發器、立即寫入一次。
 * 執行後請到 Logger（執行紀錄）複製試算表網址，並依說明「發布到網路」。
 */
function setupStatsPublishing() {
  const props = PropertiesService.getScriptProperties();
  let id = props.getProperty(STATS_PROP);
  let stats = null;
  if (id) { try { stats = SpreadsheetApp.openById(id); } catch (e) { stats = null; } }
  if (!stats) {
    stats = SpreadsheetApp.create(STATS_TITLE);
    props.setProperty(STATS_PROP, stats.getId());
    const first = stats.getSheets()[0];
    first.setName(STATS_SHEET);
  }
  // 觸發器（每 5 分鐘）
  const has = ScriptApp.getProjectTriggers().some(t => t.getHandlerFunction() === 'publishStats');
  if (!has) ScriptApp.newTrigger('publishStats').timeBased().everyMinutes(5).create();

  // 設為「知道連結的任何人可檢視」，GViz 端點才讀得到（此試算表不含個資）
  shareStatsSpreadsheet();

  publishStats();
  clearCache_();
  const url = stats.getUrl();
  const gviz = gvizUrl_(stats.getId());
  Logger.log('公開統計試算表：' + url);
  Logger.log('GViz 端點（即時）：' + gviz);
  Logger.log('若也要發布 CSV 備援：開啟該試算表 → 檔案 → 共用 → 發布到網路 → 選擇「' + STATS_SHEET + '」分頁、格式「逗號分隔值 (.csv)」→ 發布，再把網址貼到 dashboard.html 的 CONFIG.STATS_CSV_URL。');
  try {
    SpreadsheetApp.getUi().alert('公開統計試算表已建立並設為「知道連結者可檢視」：\n' + url + '\n\nGViz 端點：\n' + gviz + '\n\n儀表板會自動從後端取得此試算表 ID；若要在後端無回應時也能讀取，請把 ID 填到 dashboard.html 的 CONFIG.STATS_SPREADSHEET_ID。');
  } catch (e) { /* 非 UI 環境 */ }
  return url;
}

/** 把公開統計試算表設為「知道連結的任何人可檢視」（GViz 端點需要；試算表不含個資） */
function shareStatsSpreadsheet() {
  const id = PropertiesService.getScriptProperties().getProperty(STATS_PROP);
  if (!id) throw new Error('請先執行 setupStatsPublishing');
  DriveApp.getFileById(id).setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  Logger.log('已設定共用：知道連結的任何人可檢視（' + id + '）');
}

function gvizUrl_(id) {
  return 'https://docs.google.com/spreadsheets/d/' + id + '/gviz/tq?tqx=out:csv&headers=1&sheet=' + encodeURIComponent(STATS_SHEET);
}

/**
 * 把「不含個資」的統計結果寫到公開統計試算表（長格式）：
 *   類型 | 鍵1 | 鍵2 | 數值 | 更新時間
 *   名額 | 梯次 | 身分 | 已報名
 *   限額 | 身分 |      | 限額
 *   餐食 | 梯次 | 葷食/素食 | 人數
 *   每日 | 日期(yyyy-MM-dd) |  | 人數
 *   單位 | 單位 |      | 人數
 *   設定 | quotaScope | | session/total
 */
function publishStats() {
  const id = PropertiesService.getScriptProperties().getProperty(STATS_PROP);
  if (!id) return;   // 尚未執行 setupStatsPublishing
  let stats;
  try { stats = SpreadsheetApp.openById(id); } catch (e) { return; }
  let sheet = stats.getSheetByName(STATS_SHEET) || stats.insertSheet(STATS_SHEET);

  const rows = readMaster_(getSheet_(MASTER_SHEET));
  const counts = countsFromRows_(rows);
  const tz = Session.getScriptTimeZone();
  const now = Utilities.formatDate(new Date(), tz, 'yyyy/MM/dd HH:mm:ss');
  const out = [['類型', '鍵1', '鍵2', '數值', '更新時間']];

  out.push(['設定', 'quotaScope', '', QUOTA_SCOPE, now]);
  Object.keys(LIMITS).forEach(k => out.push(['限額', k, '', LIMITS[k], now]));
  SESSIONS.forEach(s => Object.keys(LIMITS).forEach(k => out.push(['名額', s, k, counts[s][k], now])));

  const meals = {}, daily = {}, units = {};
  SESSIONS.forEach(s => meals[s] = { '葷食': 0, '素食': 0 });
  rows.forEach(r => {
    const s = String(r[COL['梯次'] - 1]).trim();
    const m = String(r[COL['餐食'] - 1]).trim();
    if (meals[s] && meals[s][m] !== undefined) meals[s][m]++;
    const t = r[COL['報名時間'] - 1];
    if (t instanceof Date) { const d = Utilities.formatDate(t, tz, 'yyyy-MM-dd'); daily[d] = (daily[d] || 0) + 1; }
    const u = String(r[COL['單位'] - 1]).trim() || '（未填）';
    units[u] = (units[u] || 0) + 1;
  });
  SESSIONS.forEach(s => ['葷食', '素食'].forEach(m => out.push(['餐食', s, m, meals[s][m], now])));
  Object.keys(daily).sort().forEach(d => out.push(['每日', d, '', daily[d], now]));
  Object.keys(units).sort((a, b) => units[b] - units[a]).forEach(u => out.push(['單位', u, '', units[u], now]));

  sheet.clearContents();
  sheet.getRange(1, 1, out.length, 5).setValues(out);
}
