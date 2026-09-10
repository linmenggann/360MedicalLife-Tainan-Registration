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
  '第二梯次': '115/11/21–11/22',
  '第三梯次': '115/12/5–12/6'
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
const HEADERS = ['報名時間', '梯次', '身分', '單位', '姓名', '人事號', '職稱', '手機簡碼/分機', 'E-mail', '出生日期', '身分證號', '餐食'];
const COL = {}; HEADERS.forEach((h, i) => COL[h] = i + 1);   // 1-based 欄位索引
const TEXT_COLS = ['人事號', '手機簡碼/分機', '出生日期', '身分證號'];   // 以純文字儲存，避免 0 開頭或日期被自動轉換
const COL_WIDTHS = [150, 90, 110, 140, 90, 90, 120, 130, 220, 110, 120, 70];

// 公開統計試算表（由 setupStatsPublishing 建立，ID 存於指令碼屬性）
const STATS_PROP = 'STATS_SPREADSHEET_ID';
const STATS_SHEET = '統計';
const STATS_TITLE = '360°醫學人生 報名統計（公開，不含個資）';

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

    // 重複人事號檢查（總表）
    for (const r of rows) {
      if (String(r[COL['人事號'] - 1]).trim() === empId) {
        return json_({
          ok: false, error: 'duplicate', counts: counts,
          message: '此人事號已報名' + String(r[COL['梯次'] - 1]).trim() + '，如需修改請聯絡教學部（分機 57440）。'
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
    appendRow_(master, row);
    appendRow_(getSheet_(session), row);
    SpreadsheetApp.flush();
    clearCache_();

    counts[session][identity]++;
    // 更新公開統計（若已設定；失敗不影響報名）
    try { publishStats(); } catch (err) { Logger.log('publishStats 失敗：' + err); }

    return json_({ ok: true, counts: counts });
  } finally {
    lock.releaseLock();
  }
}

/** 寫入一列，文字欄位先設為純文字格式，避免自動轉換 */
function appendRow_(sheet, row) {
  const r = sheet.getLastRow() + 1;
  TEXT_COLS.forEach(h => sheet.getRange(r, COL[h]).setNumberFormat('@'));
  sheet.getRange(r, COL['報名時間']).setNumberFormat('yyyy/MM/dd HH:mm:ss');
  sheet.getRange(r, 1, 1, row.length).setValues([row]);
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
