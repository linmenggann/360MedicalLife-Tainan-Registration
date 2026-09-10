/**
 * 360°醫學人生｜走進臺南，走進生活 — 報名後端 (Google Apps Script)
 *
 * 部署步驟：
 * 1. 建立一個 Google 試算表，開啟「擴充功能 → Apps Script」，貼上本檔內容。
 * 2. 點「部署 → 新增部署作業」，類型選「網頁應用程式」：
 *    - 執行身分：我
 *    - 誰可以存取：所有人
 * 3. 複製「網頁應用程式網址」，貼到 index.html 的 CONFIG.API_URL。
 * 4. 之後若修改程式，需「管理部署作業 → 編輯 → 新版本」重新部署。
 */

const SHEET_NAME = '報名資料';
const LIMITS = {
  '西醫UGY': 8,
  '西醫PGY': 10,
  '醫事職類PGY': 9,
  '臨床教師': 8
};
const HEADERS = ['報名時間', '身分', '單位', '姓名', '人事號', '職稱', '手機簡碼/分機', 'E-mail', '出生日期', '身分證號', '餐食', 'User-Agent'];

function getSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAME);
  }
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(HEADERS);
    sheet.getRange(1, 1, 1, HEADERS.length).setFontWeight('bold');
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function getCounts_(sheet) {
  const counts = {};
  Object.keys(LIMITS).forEach(k => counts[k] = 0);
  const last = sheet.getLastRow();
  if (last < 2) return counts;
  const values = sheet.getRange(2, 2, last - 1, 1).getValues();
  values.forEach(row => {
    const k = String(row[0]).trim();
    if (counts[k] !== undefined) counts[k]++;
  });
  return counts;
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/** GET：回傳各身分已報名人數與限額 */
function doGet(e) {
  const sheet = getSheet_();
  return json_({ ok: true, counts: getCounts_(sheet), limits: LIMITS, ts: new Date().toISOString() });
}

/** POST：新增一筆報名 (body 為 JSON 字串) */
function doPost(e) {
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    let data;
    try {
      data = JSON.parse(e.postData.contents);
    } catch (err) {
      return json_({ ok: false, error: 'invalid', message: '無法解析資料' });
    }

    const required = ['identity', 'unit', 'name', 'empId', 'title', 'phone', 'email', 'birth', 'nationalId', 'meal'];
    for (const k of required) {
      if (!data[k] || String(data[k]).trim() === '') {
        return json_({ ok: false, error: 'invalid', message: '缺少欄位：' + k });
      }
    }
    if (LIMITS[data.identity] === undefined) {
      return json_({ ok: false, error: 'invalid', message: '身分不正確' });
    }
    if (!/^[A-Z][1289]\d{8}$/.test(String(data.nationalId).toUpperCase())) {
      return json_({ ok: false, error: 'invalid', message: '身分證號格式不正確' });
    }

    const sheet = getSheet_();
    const counts = getCounts_(sheet);

    // 重複人事號檢查
    const last = sheet.getLastRow();
    if (last >= 2) {
      const ids = sheet.getRange(2, 5, last - 1, 1).getValues().map(r => String(r[0]).trim());
      if (ids.indexOf(String(data.empId).trim()) !== -1) {
        return json_({ ok: false, error: 'duplicate', counts: counts });
      }
    }

    // 名額檢查
    if (counts[data.identity] >= LIMITS[data.identity]) {
      return json_({ ok: false, error: 'full', counts: counts });
    }

    sheet.appendRow([
      new Date(),
      data.identity,
      data.unit,
      data.name,
      "'" + String(data.empId).trim(),
      data.title,
      "'" + String(data.phone).trim(),
      data.email,
      data.birth,
      String(data.nationalId).toUpperCase(),
      data.meal,
      data.userAgent || ''
    ]);

    return json_({ ok: true, counts: getCounts_(sheet) });
  } finally {
    lock.releaseLock();
  }
}
