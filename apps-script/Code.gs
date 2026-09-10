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
 * 4. 複製「網頁應用程式網址」，貼到 index.html 的 CONFIG.API_URL。
 * 5. 之後若修改程式，需「管理部署作業 → 編輯 → 版本：新版本 → 部署」。
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

// 表頭（總表與各梯次分頁相同）
const HEADERS = ['報名時間', '梯次', '身分', '單位', '姓名', '人事號', '職稱', '手機簡碼/分機', 'E-mail', '出生日期', '身分證號', '餐食'];
const COL = {}; HEADERS.forEach((h, i) => COL[h] = i + 1);   // 1-based 欄位索引
const TEXT_COLS = ['人事號', '手機簡碼/分機', '出生日期', '身分證號'];   // 以純文字儲存，避免 0 開頭或日期被自動轉換
const COL_WIDTHS = [150, 90, 110, 140, 90, 90, 120, 130, 220, 110, 120, 70];

/* ------------------------------------------------------------------ */
/* 試算表工具                                                          */
/* ------------------------------------------------------------------ */
function ss_() {
  return SpreadsheetApp.openById(SPREADSHEET_ID);
}

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
  Logger.log('分頁與表頭已建立：' + [MASTER_SHEET].concat(SESSIONS).join('、'));
}

/** 試算表選單 */
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('報名系統')
    .addItem('初始化分頁與表頭', 'setupSheets')
    .addItem('顯示各梯次名額統計', 'showCounts')
    .addToUi();
}

function showCounts() {
  const counts = getCounts_(ensureSheet_(MASTER_SHEET));
  const lines = SESSIONS.map(s => s + '（' + SESSION_DATES[s] + '）：' +
    Object.keys(LIMITS).map(k => k + ' ' + counts[s][k] + '/' + LIMITS[k]).join('、'));
  SpreadsheetApp.getUi().alert('各梯次已報名人數\n\n' + lines.join('\n'));
}

/* ------------------------------------------------------------------ */
/* 名額統計                                                            */
/* ------------------------------------------------------------------ */
function emptyCounts_() {
  const c = {};
  SESSIONS.forEach(s => { c[s] = {}; Object.keys(LIMITS).forEach(k => c[s][k] = 0); });
  return c;
}

/** 由總表統計各梯次、各身分已報名人數 */
function getCounts_(master) {
  const counts = emptyCounts_();
  const last = master.getLastRow();
  if (last < 2) return counts;
  const rows = master.getRange(2, COL['梯次'], last - 1, 2).getValues();   // 梯次、身分
  rows.forEach(r => {
    const s = String(r[0]).trim(), k = String(r[1]).trim();
    if (counts[s] && counts[s][k] !== undefined) counts[s][k]++;
  });
  return counts;
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

/* ------------------------------------------------------------------ */
/* Web App                                                             */
/* ------------------------------------------------------------------ */

/** GET：回傳各梯次、各身分已報名人數與限額 */
function doGet(e) {
  const master = ensureSheet_(MASTER_SHEET);
  return json_({
    ok: true,
    counts: getCounts_(master),
    limits: LIMITS,
    sessions: SESSIONS,
    quotaScope: QUOTA_SCOPE,
    ts: new Date().toISOString()
  });
}

/** POST：新增一筆報名（body 為 JSON 字串），同時寫入總表與梯次分頁 */
function doPost(e) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    let d;
    try {
      d = JSON.parse(e.postData.contents);
    } catch (err) {
      return json_({ ok: false, error: 'invalid', message: '無法解析資料' });
    }

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

    const master = ensureSheet_(MASTER_SHEET);
    const counts = getCounts_(master);

    // 重複人事號檢查（總表）
    const last = master.getLastRow();
    if (last >= 2) {
      const rows = master.getRange(2, COL['梯次'], last - 1, COL['人事號'] - COL['梯次'] + 1).getValues();
      for (const r of rows) {
        if (String(r[COL['人事號'] - COL['梯次']]).trim() === empId) {
          return json_({
            ok: false, error: 'duplicate', counts: counts,
            message: '此人事號已報名' + String(r[0]).trim() + '，如需修改請聯絡教學部（分機 57440）。'
          });
        }
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
    appendRow_(ensureSheet_(session), row);
    SpreadsheetApp.flush();

    return json_({ ok: true, counts: getCounts_(master) });
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
