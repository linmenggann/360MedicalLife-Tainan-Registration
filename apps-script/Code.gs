/**
 * 360°醫學人生｜走進臺南，走進生活 — 報名後端 (Google Apps Script)
 *
 * 試算表：https://docs.google.com/spreadsheets/d/1vyVq2XwPbz8fI2JZrdNKhxQciLyYH2AzH-Pu_kX3iyI/edit
 * 分頁：
 *   - 活動報名資料（總表）：所有報名資料
 *   - 第一梯次／第二梯次／第三梯次：各梯次的報名資料（同時寫入）
 *   - 第一梯次活動滿意度調查／第二梯次…／第三梯次…：活動滿意度調查（survey-1/2/3.html），見檔案最後一節
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
// 身分清單（報名表的身分選項；2026-10-08 起不再分身分限額）
const IDENTITIES = ['西醫UGY/醫事職類UGY', '西醫PGY', '醫事職類PGY', '臨床教師'];
// 各梯次總報名人數上限（2026-10-08 起取消各身分限額，只保留各梯次總人數上限；未達上限時各身分皆可報名）。
// 2026-10-08 起統一 40 人，包含長官及工作人員。index.html 與 dashboard.html 以後端回傳的 sessionCaps 為準
const SESSION_CAPS = { '第一梯次': 40, '第二梯次': 40, '第三梯次': 40 };
// 長官及工作人員：不在報名網頁的身分選單，由選單「匯入長官及工作人員至報名資料」加入；
// 身分欄保留「長官」「工作人員」，統計時合併為「長官/工作人員」並計入各梯次總人數
const STAFF_GROUP = '長官/工作人員';
const STAFF_IDENTITIES = ['長官', '工作人員', STAFF_GROUP];
const COUNT_IDENTITIES = [STAFF_GROUP].concat(IDENTITIES);   // 統計用（含長官及工作人員）
// 舊身分名稱 → 新名稱（2026-10-05「西醫UGY」改為「西醫UGY/醫事職類UGY」）。
// 試算表既有資料、舊版網頁送來的值仍可能是舊名稱：讀取、統計與寫入前一律換成新名稱。
// 既有資料可用選單「身分名稱更新為新名稱」一次改寫。
const IDENTITY_ALIASES = { '西醫UGY': '西醫UGY/醫事職類UGY' };
function canonIdentity_(v) {
  const k = String(v == null ? '' : v).trim();
  return IDENTITY_ALIASES[k] || k;
}
/** 是否為長官或工作人員 */
function isStaff_(v) { return STAFF_IDENTITIES.indexOf(canonIdentity_(v)) !== -1; }
/** 統計用的身分（長官、工作人員 → 長官/工作人員） */
function countIdentity_(v) { return isStaff_(v) ? STAFF_GROUP : canonIdentity_(v); }
/** 某梯次目前已報名總人數（含長官及工作人員） */
function sessionTotal_(counts, session) {
  return COUNT_IDENTITIES.reduce((n, k) => n + ((counts[session] || {})[k] || 0), 0);
}

// 儀表板（dashboard.html）存取金鑰：需與 dashboard.html 的 CONFIG.DASHBOARD_KEY 相同；兩者皆留空則不檢查
const DASHBOARD_KEY = 'chimei360';

// 快取秒數（名額與儀表板資料）
// 報名寫入後會立即以最新資料更新快取；每 5 分鐘的排程（publishStats）也會重建快取，
// 所以快取可以放長。只有「直接在試算表手動修改資料」時，最多延遲這段時間才反映（可用選單「清除快取」立即更新）。
const CACHE_SECONDS = 360;

// 表頭（總表與各梯次分頁相同）
const HEADERS = ['報名時間', '梯次', '身分', '單位', '姓名', '人事號', '職稱', '手機簡碼/分機', 'E-mail', '出生日期', '身分證號', '餐食', '通知寄送時間', '備註'];
const COL = {}; HEADERS.forEach((h, i) => COL[h] = i + 1);   // 1-based 欄位索引
// 以文字儲存的欄位：寫入前先設為純文字格式（見 appendRow_），避免 8607E7 被當成科學記號、0 開頭被去掉、日期被自動轉換
const TEXT_COLS = ['人事號', '手機簡碼/分機', '出生日期', '身分證號'];
const COL_WIDTHS = [150, 90, 110, 140, 90, 90, 120, 130, 220, 110, 120, 70, 150, 220];

// 公開統計試算表（由 setupStatsPublishing 建立，ID 存於指令碼屬性）
const STATS_PROP = 'STATS_SPREADSHEET_ID';
const STATS_SHEET = '統計';
const STATS_TITLE = '360°醫學人生 報名統計與問卷查詢名單（知道連結即可檢視）';

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
    .addItem('身分名稱更新為新名稱（西醫UGY → 西醫UGY/醫事職類UGY）', 'renameLegacyIdentities')
    .addSeparator()
    .addItem('建立公開統計試算表（GViz / CSV 備援）', 'setupStatsPublishing')
    .addItem('立即更新公開統計', 'publishStats')
    .addItem('統計試算表設為連結可檢視', 'shareStatsSpreadsheet')
    .addItem('清除快取', 'clearCache_')
    .addSeparator()
    .addItem('預覽通知信（寄給自己）', 'previewNotificationEmail')
    .addItem('補寄尚未通知的報名者', 'sendPendingNotifications')
    .addItem('預覽長官及工作人員通知信（寄給自己）', 'previewStaffNotificationDialog')
    .addItem('寄送長官及工作人員行前資訊', 'sendStaffNotificationsDialog')
    .addItem('匯入長官及工作人員至報名資料', 'importStaffRegistrationsDialog')
    .addSeparator()
    .addItem('管理者加報梯次（同一人多梯次）', 'adminAddSessionsDialog')
    .addSeparator()
    .addItem('建立活動滿意度調查分頁＋檢查雲端硬碟資料夾', 'setupSurvey')
    .addItem('清除未完成送出的暫存照片（超過 1 天）', 'cleanupSurveyUploads')
    .addSeparator()
    .addItem('驗收測試：人事號不被轉成科學記號', 'testTextColumns')
    .addItem('清除人事號等欄位的前置撇號', 'fixApostrophes')
    .addItem('診斷文字欄內容', 'diagnoseTextColumns')
    .addToUi();
}

/**
 * 把總表與三個梯次分頁「身分」欄的舊名稱改成新名稱（IDENTITY_ALIASES）。
 * 只改「身分」欄、只改需要改的儲存格；可重複執行。改完後更新快取與公開統計。
 */
function renameLegacyIdentities() {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  const changed = [];
  try {
    [MASTER_SHEET].concat(SESSIONS).forEach(name => {
      const sheet = ss_().getSheetByName(name);
      if (!sheet || sheet.getLastRow() < 2) return;
      const range = sheet.getRange(2, COL['身分'], sheet.getLastRow() - 1, 1);
      const vals = range.getValues();
      let n = 0;
      const next = vals.map(r => {
        const v = canonIdentity_(r[0]);
        if (v !== String(r[0]).trim() && String(r[0]).trim() !== '') { n++; return [v]; }
        return [r[0]];
      });
      if (n) { range.setValues(next); changed.push(name + ' ' + n + ' 筆'); }
    });
    SpreadsheetApp.flush();
    refreshCaches_();
  } finally {
    lock.releaseLock();
  }
  try { publishStats(); } catch (e) { /* 尚未建立公開統計時略過 */ }
  SpreadsheetApp.getUi().alert(changed.length
    ? '已將身分名稱更新為新名稱：\n\n' + changed.join('\n')
    : '沒有需要更新的資料（身分欄已全部是新名稱）。');
}

function showCounts() {
  const counts = getCounts_(getSheet_(MASTER_SHEET));
  const lines = SESSIONS.map(s => s + '（' + SESSION_DATES[s] + '）：' +
    sessionTotal_(counts, s) + '/' + SESSION_CAPS[s] + ' 人（' + COUNT_IDENTITIES.map(k => k + ' ' + counts[s][k]).join('、') + '）');
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
  SESSIONS.forEach(s => { c[s] = {}; COUNT_IDENTITIES.forEach(k => c[s][k] = 0); });
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
    const s = String(r[COL['梯次'] - 1]).trim(), k = countIdentity_(r[COL['身分'] - 1]);
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
      identity: canonIdentity_(r[COL['身分'] - 1]),
      unit: String(r[COL['單位'] - 1]).trim(),
      name: String(r[COL['姓名'] - 1]).trim(),
      empId: normalizeId(r[COL['人事號'] - 1]),
      title: String(r[COL['職稱'] - 1]).trim(),
      meal: String(r[COL['餐食'] - 1]).trim()
    };
  });
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function countsPayload_(counts) {
  return {
    ok: true,
    counts: counts,
    identities: IDENTITIES,                    // 報名網頁可選的身分
    countedIdentities: COUNT_IDENTITIES,       // counts 裡的身分（含長官/工作人員）
    sessionCaps: SESSION_CAPS,                 // 各梯次總報名人數上限（不分身分）
    sessions: SESSIONS,
    statsSpreadsheetId: PropertiesService.getScriptProperties().getProperty(STATS_PROP) || '',
    statsSheet: STATS_SHEET,
    ts: new Date().toISOString()
  };
}

/* ------------------------------------------------------------------ */
/* Web App                                                             */
/* ------------------------------------------------------------------ */

/**
 * 由總表資料列一次產生「名額」與「儀表板」兩份回應並寫入快取；rows 省略時自行讀取總表。
 * 報名寫入後、每 5 分鐘排程、背景作業都會呼叫，讓網頁與儀表板的讀取幾乎都直接命中快取。
 */
function refreshCaches_(rows) {
  rows = rows || readMaster_(getSheet_(MASTER_SHEET));
  const counts = countsFromRows_(rows);
  const countsPayload = countsPayload_(counts);
  const dashboardPayload = countsPayload_(counts);
  dashboardPayload.sessionDates = SESSION_DATES;
  dashboardPayload.registrations = registrationsFromRows_(rows);
  cachePut_('counts', countsPayload);
  cachePut_('dashboard', dashboardPayload);
  return { counts: countsPayload, dashboard: dashboardPayload };
}

/**
 * GET：預設回傳各梯次、各身分已報名人數與限額；?action=dashboard&key=… 回傳儀表板資料（含名單）。
 * 儀表板改用 GET：Google 偶爾會把 POST 轉成 GET 後才執行（實測 2026-09-24），用 GET 可避開這個問題。
 */
function doGet(e) {
  const p = (e && e.parameter) || {};
  if (p.action === 'dashboard') return dashboardResponse_(p.key);
  if (p.action === 'surveyLookup') return json_(surveyLookup_(p.session, p.empId));
  if (p.action === 'surveyStatus') return json_(surveyStatus_(p.session, p.id));
  if (p.action === 'surveyUploadUrl') return json_(surveyUploadUrl_(p));
  if (p.action === 'surveyUploadStatus') return json_(surveyUploadStatus_(p));
  const cached = cacheGet_('counts');
  if (cached) { cached.cached = true; return json_(cached); }
  return json_(refreshCaches_().counts);
}

/** 儀表板資料（名額＋不含敏感欄位的名單），GET 與 POST 共用 */
function dashboardResponse_(key) {
  if (DASHBOARD_KEY && String(key || '') !== DASHBOARD_KEY) {
    return json_({ ok: false, error: 'unauthorized', message: '金鑰不正確' });
  }
  const cached = cacheGet_('dashboard');
  if (cached) { cached.cached = true; return json_(cached); }
  return json_(refreshCaches_().dashboard);
}

/** POST：新增一筆報名（body 為 JSON 字串），或儀表板資料查詢（action=dashboard） */
function doPost(e) {
  let d;
  try {
    d = JSON.parse(e.postData.contents);
  } catch (err) {
    return json_({ ok: false, error: 'invalid', message: '無法解析資料' });
  }

  // 儀表板資料（不需鎖定；保留 POST 以相容舊版儀表板）
  if (d.action === 'dashboard') return dashboardResponse_(d.key);

  // 活動滿意度調查（照片已由網頁直接上傳雲端硬碟；只有決定編號、寫入一列時才鎖定）
  if (d.action === 'survey') return json_(submitSurvey_(d));
  if (d.action === 'surveyUploadChunk') return json_(surveyUploadChunk_(d));

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
    const identity = canonIdentity_(d.identity);
    const empId = normalizeId(d.empId);
    const nationalId = normalizeId(d.nationalId);

    if (!empId) return json_({ ok: false, error: 'invalid', message: '人事號不可空白' });
    if (SESSIONS.indexOf(session) === -1) return json_({ ok: false, error: 'invalid', message: '梯次不正確' });
    if (IDENTITIES.indexOf(identity) === -1) return json_({ ok: false, error: 'invalid', message: '身分不正確' });
    if (!/^[A-Z][1289]\d{8}$/.test(nationalId)) return json_({ ok: false, error: 'invalid', message: '身分證號格式不正確' });
    if (['葷食', '素食'].indexOf(String(d.meal)) === -1) return json_({ ok: false, error: 'invalid', message: '餐食不正確' });

    const master = getSheet_(MASTER_SHEET);
    const rows = readMaster_(master);
    const counts = countsFromRows_(rows);

    // 重複報名檢查（總表，跨所有梯次）：每人限報名一個梯次
    // 以「人事號」或「身分證號」任一相同即視為同一人
    for (const r of rows) {
      const sameEmp = normalizeId(r[COL['人事號'] - 1]) === empId;
      const sameId = normalizeId(r[COL['身分證號'] - 1]) === nationalId;
      if (sameEmp || sameId) {
        const which = sameEmp ? '此人事號' : '此身分證號';
        return json_({
          ok: false, error: 'duplicate', counts: counts,
          existingSession: String(r[COL['梯次'] - 1]).trim(),
          existingEmpId: normalizeId(r[COL['人事號'] - 1]),
          message: which + '已報名' + String(r[COL['梯次'] - 1]).trim() + '，每人限報名一個梯次；如需更改梯次請聯絡教學部（分機 57440）。'
        });
      }
    }

    // 名額檢查：只看該梯次總人數是否已達上限（不分身分）
    if (sessionTotal_(counts, session) >= SESSION_CAPS[session]) {
      return json_({ ok: false, error: 'full', counts: counts, message: session + '報名人數已額滿，請改選其他梯次或洽教學部詢問候補。' });
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

    // 以「寫入前讀到的資料 + 這一筆」直接更新快取，不必再讀一次試算表
    rows.push(row);
    try { refreshCaches_(rows); } catch (err) { clearCache_(); }

    counts[session][identity]++;

    // 通知信與公開統計改為背景作業（約一分鐘內執行），讓報名立即回覆
    const queued = scheduleBackgroundJob_();

    // registered:true 是「確實寫入」的標記：網頁只有看到它才顯示報名成功
    return json_({ ok: true, registered: true, session: session, empId: empId, counts: counts, queued: queued });
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

  // 寄信用 UserLock，與報名寫入用的 ScriptLock 分開：寄信期間（下載附件、寄出多封）不會擋住新的報名
  const lock = LockService.getUserLock();
  if (!lock.tryLock(30000)) { Logger.log('背景作業：寄信作業忙碌中，稍後再試'); scheduleBackgroundJob_(); return; }
  try {
    if (NOTIFY_ON_REGISTER) {
      try { sendPending_(); } catch (err) { Logger.log('背景寄信失敗：' + err); }
    }
    try { publishStats(); } catch (err) { Logger.log('publishStats 失敗：' + err); }
  } finally {
    lock.releaseLock();
  }
}

/**
 * 識別碼正規化（人事號、身分證號）。前端 index.html 使用完全相同的函式。
 * 寫入與比對一律使用正規化值：8607e7、 8607E7 、８６０７Ｅ７、‘8607E7、 '8607E7 → 8607E7
 */
function normalizeId(v) {
  return String(v == null ? '' : v)
    .normalize('NFKC')                      // 全形轉半形：８６０７Ｅ７、＇
    .replace(/[​-‍﻿]/g, '')  // 移除零寬字元（複製貼上常夾帶）
    .trim()
    .replace(/^['‘’]+/, '')                 // 移除開頭撇號，含 iPhone 智慧型標點的彎撇號
    .trim()
    .toUpperCase();
}

// 屬於識別碼、需要正規化（含轉大寫）的文字欄；其餘文字欄只做「去撇號 + trim」
const ID_COLS = ['人事號', '身分證號'];

/** 讀取其餘文字欄（電話／分機、出生日期）：去掉開頭撇號並去除前後空白，不轉大寫 */
function txt_(v) {
  return String(v == null ? '' : v).replace(/^['‘’]+/, '').trim();
}

/**
 * 寫入文字欄用的值：識別碼欄用 normalizeId；其餘文字欄去撇號與空白，日期物件轉成 yyyy-MM-dd。
 * 不可加前置撇號：Apps Script 以 setValues 寫入時，撇號會被當成字面字元存進儲存格（顯示 'B509A9），
 * 人工閱讀、下載 Excel 或匯入其他系統都會多一個撇號。
 */
function asSheetText_(v, header) {
  if (v instanceof Date) return Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  return ID_COLS.indexOf(header) !== -1 ? normalizeId(v) : txt_(v);
}

/**
 * 寫入一列（報名、管理者加報都走這裡）；回傳列號。
 * 防止 8607E7 被判讀為科學記號的做法：**先把文字欄的儲存格設為純文字格式（@），再寫入值**。
 * 純文字格式下，Google 試算表不會對寫入的字串做任何型別判讀，值也不會多出撇號。
 */
function appendRow_(sheet, row) {
  return writeRowAt_(sheet, sheet.getLastRow() + 1, row, HEADERS, TEXT_COLS, '報名時間');
}

/**
 * 所有含文字欄的寫入共用這個函式（報名分頁、活動滿意度調查分頁）；回傳列號。
 * headers：該分頁的表頭；textCols：以純文字儲存的欄位（先設 @ 再寫入，不加撇號）；timeCol：時間欄。
 * 呼叫端以 getLastRow() + 1 決定列號時，必須在 LockService 鎖定範圍內呼叫。
 */
function writeRowAt_(sheet, r, row, headers, textCols, timeCol) {
  return writeRowsAt_(sheet, r, [row], headers, textCols, timeCol);
}

/** 同 writeRowAt_，一次寫入多列（從第 r 列開始）；文字欄整欄先設 @ 再寫入正規化值 */
function writeRowsAt_(sheet, r, rows, headers, textCols, timeCol) {
  const n = rows.length;
  if (!n) return r;
  const out = rows.map(row => {
    const o = row.slice(0, headers.length);
    while (o.length < headers.length) o.push('');
    return o;
  });
  textCols.forEach(h => {
    const c = headers.indexOf(h);
    if (c === -1) return;
    out.forEach(o => { o[c] = asSheetText_(o[c], h); });
    sheet.getRange(r, c + 1, n, 1).setNumberFormat('@');
  });
  const t = timeCol ? headers.indexOf(timeCol) : -1;
  if (t !== -1) sheet.getRange(r, t + 1, n, 1).setNumberFormat('yyyy/MM/dd HH:mm:ss');
  sheet.getRange(r, 1, n, headers.length).setValues(out);
  return r;
}

/**
 * 修復既有資料：把文字欄（人事號、手機簡碼/分機、出生日期、身分證號）整欄以正規化後的純文字重新寫入。
 * 撇號可能存在「值」裡，也可能是儲存格的文字標記，因此不做判斷，一律先設為純文字 → 重新寫入正規化值。
 * 已經被試算表轉成數字的儲存格（例如 86070000000、掉了開頭 0 的電話）不得自動推算還原：
 * 維持原值不動，列出清單請承辦人對照人事資料人工修正。
 */
function fixApostrophes() {
  let cellsWithMark = 0, rewritten = 0;
  const details = [], numeric = [];
  [MASTER_SHEET].concat(SESSIONS).forEach(name => {
    const sheet = ss_().getSheetByName(name);
    if (!sheet) return;
    const last = sheet.getLastRow();
    if (last < 2) return;
    const rows = last - 1;
    const names = sheet.getRange(2, COL['姓名'], rows, 1).getValues();
    let marked = 0;
    TEXT_COLS.forEach(h => {
      const range = sheet.getRange(2, COL[h], rows, 1);
      const values = range.getValues();
      const formulas = range.getFormulas();        // 文字標記的撇號會出現在這裡
      const out = values.map((row, i) => {
        const v = row[0];
        const f = formulas[i][0];
        if (typeof v === 'number') {               // 已被轉成數字：不推算，保留原值並列入清單
          numeric.push(name + ' 第 ' + (i + 2) + ' 列｜' + String(names[i][0]).trim() + '｜' + h + '＝' + v);
          return [v];
        }
        if ((typeof v === 'string' && /^['‘’]/.test(v)) || (typeof f === 'string' && f.charAt(0) === "'")) marked++;
        return [asSheetText_(v, h)];               // 正規化；日期物件轉 yyyy-MM-dd
      });
      range.clearFormat();                         // 先回到自動格式，避免舊格式影響
      range.setNumberFormat('@');                  // 再設為純文字，寫入時不做型別判讀
      range.setValues(out);
      rewritten += out.length;
    });
    details.push(name + '：' + rows + ' 列');
    cellsWithMark += marked;
  });
  SpreadsheetApp.flush();
  clearCache_();
  let msg = '已以正規化值重新寫入文字欄（人事號、手機簡碼/分機、出生日期、身分證號）\n' +
    details.join('\n') + '\n\n共處理 ' + rewritten + ' 格，其中原本帶撇號 ' + cellsWithMark + ' 格。';
  if (numeric.length) {
    msg += '\n\n以下 ' + numeric.length + ' 格已被轉成數字，系統不自動還原，請對照人事資料人工修正：\n' + numeric.join('\n');
  }
  msg += '\n\n若畫面仍顯示撇號，請重新整理試算表；仍有問題請執行「診斷文字欄內容」並回報結果。';
  Logger.log(msg);
  try { SpreadsheetApp.getUi().alert(msg); } catch (e) {}
  return { marked: cellsWithMark, numeric: numeric };
}

/**
 * 診斷：列出總表前 3 筆資料在文字欄的真實內容（值、顯示值、公式列內容、格式），
 * 用來判斷撇號是存在值裡還是儲存格的文字標記。
 */
function diagnoseTextColumns() {
  const sheet = getSheet_(MASTER_SHEET);
  const last = Math.min(sheet.getLastRow(), 4);
  if (last < 2) { try { SpreadsheetApp.getUi().alert('總表沒有資料'); } catch (e) {} return; }
  const lines = [];
  for (let r = 2; r <= last; r++) {
    TEXT_COLS.forEach(h => {
      const cell = sheet.getRange(r, COL[h]);
      const v = cell.getValue();
      lines.push('列' + r + '｜' + h +
        '｜值=' + JSON.stringify(v) + '（' + (v instanceof Date ? 'Date' : typeof v) + '）' +
        '｜顯示=' + JSON.stringify(cell.getDisplayValue()) +
        '｜公式列=' + JSON.stringify(cell.getFormula()) +
        '｜格式=' + JSON.stringify(cell.getNumberFormat()));
    });
  }
  const msg = lines.join('\n');
  Logger.log(msg);
  try { SpreadsheetApp.getUi().alert('文字欄診斷（前 3 筆）', msg, SpreadsheetApp.getUi().ButtonSet.OK); } catch (e) {}
  return msg;
}

/**
 * 驗收測試：人事號等文字欄不會被轉成科學記號、數字或日期。
 * 在暫存分頁（與正式分頁相同的表頭與欄位格式）走正式的 appendRow_ 寫入，讀回比對後刪除暫存分頁。
 * 測試案例：8607E7（會被誤判為科學記號）、B41242（英數混合對照組）；同列一併驗證 0 開頭手機、出生日期、身分證號。
 */
function testTextColumns() {
  const ss = ss_();
  const name = '_驗收測試_文字欄';
  const old = ss.getSheetByName(name);
  if (old) ss.deleteSheet(old);
  const sheet = ensureSheet_(name);
  // full：四個文字欄都檢查；其餘只檢查人事號是否正規化成 8607E7
  const cases = [
    { empId: '8607E7',    exp: '8607E7', phone: '0912345678', birth: '1985-03-04', nid: 'A123456789', full: true },
    { empId: 'B41242',    exp: 'B41242', phone: '57440',      birth: '1990-12-31', nid: 'B223456789', full: true },
    { empId: '8607e7',    exp: '8607E7' },
    { empId: ' 8607E7 ',  exp: '8607E7' },
    { empId: '８６０７Ｅ７', exp: '8607E7' },
    { empId: '‘8607E7',   exp: '8607E7' },
    { empId: " '8607E7",  exp: '8607E7' }
  ];
  const lines = [];
  try {
    cases.forEach(c => {
      const row = new Array(HEADERS.length).fill('');
      row[COL['報名時間'] - 1] = new Date();
      row[COL['梯次'] - 1] = '第一梯次';
      row[COL['身分'] - 1] = '臨床教師';
      row[COL['姓名'] - 1] = '驗收測試';
      row[COL['人事號'] - 1] = c.empId;
      row[COL['手機簡碼/分機'] - 1] = c.phone || '57440';
      row[COL['出生日期'] - 1] = c.birth || '1985-03-04';
      row[COL['身分證號'] - 1] = c.nid || 'A123456789';
      const r = appendRow_(sheet, row);
      SpreadsheetApp.flush();
      const checks = [['人事號', c.exp]];
      if (c.full) checks.push(['手機簡碼/分機', c.phone], ['出生日期', c.birth], ['身分證號', c.nid]);
      checks.forEach(([h, exp]) => {
        const cell = sheet.getRange(r, COL[h]);
        const v = cell.getValue(), d = cell.getDisplayValue(), f = cell.getFormula(), fmt = cell.getNumberFormat();
        const pass = typeof v === 'string' && v === exp && d === exp && fmt === '@' && String(f).charAt(0) !== "'";
        lines.push((pass ? 'PASS' : 'FAIL') + '｜' + h + '｜輸入 ' + JSON.stringify(h === '人事號' ? c.empId : exp) +
          '｜儲存值 ' + JSON.stringify(v) + '（' + typeof v + '）｜顯示 ' + d + '｜格式 ' + fmt + (f ? '｜編輯列 ' + f : ''));
      });
    });
  } finally {
    ss.deleteSheet(sheet);
  }
  const allPass = lines.every(l => l.indexOf('PASS') === 0);
  const msg = (allPass ? '驗收通過：文字欄沒有被轉換' : '驗收未通過：請將下列結果回報') + '\n\n' + lines.join('\n');
  Logger.log(msg);
  try { SpreadsheetApp.getUi().alert(msg); } catch (e) {}
  return allPass;
}

/* ------------------------------------------------------------------ */
/* 報名成功／行前資訊通知信                                            */
/* ------------------------------------------------------------------ */

/** 試算表資料列 → 通知信所需欄位 */
function rowToReg_(row) {
  return {
    session: String(row[COL['梯次'] - 1]).trim(),
    identity: canonIdentity_(row[COL['身分'] - 1]),
    unit: String(row[COL['單位'] - 1]).trim(),
    name: String(row[COL['姓名'] - 1]).trim(),
    empId: normalizeId(row[COL['人事號'] - 1]),
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
  const lock = LockService.getUserLock();
  let msg;
  if (!lock.tryLock(60000)) {
    msg = '另一個寄信作業正在執行，請稍後再試。';
  } else {
    try { msg = sendPending_().msg; } finally { lock.releaseLock(); }
  }
  Logger.log(msg);
  try { SpreadsheetApp.getUi().alert(msg); } catch (e) {}
}

/** 寄送所有尚未通知的報名者（呼叫端需持有 UserLock）；回傳統計 */
function sendPending_() {
  const master = getSheet_(MASTER_SHEET);
  ensureExtraHeaders_();
  const last = master.getLastRow();
  if (last < 2) return { sent: 0, failed: 0, msg: '沒有報名資料' };
  const values = master.getRange(2, 1, last - 1, HEADERS.length).getValues();
  const pendingRows = values.map((row, i) => ({ row, r: i + 2 }))
    .filter(x => String(x.row[COL['姓名'] - 1]).trim() !== '' && !x.row[COL['通知寄送時間'] - 1]);
  if (!pendingRows.length) return { sent: 0, failed: 0, msg: '沒有待寄的通知信' };
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
  const msg = '通知信寄送完成：成功 ' + sent + ' 封，失敗 ' + failed + ' 封（詳見執行紀錄）';
  Logger.log(msg);
  return { sent: sent, failed: failed, msg: msg };
}

/** 補上後來新增的表頭欄（通知寄送時間、備註），既有資料不動 */
function ensureExtraHeaders_() {
  const extra = ['通知寄送時間', '備註'];
  [MASTER_SHEET].concat(SESSIONS).forEach(name => {
    const sheet = ss_().getSheetByName(name);
    if (!sheet) return;
    const head = sheet.getRange(1, 1, 1, HEADERS.length).getValues()[0].map(String);
    extra.forEach(h => {
      const c = COL[h];
      if (head[c - 1].trim() === h) return;
      sheet.getRange(1, c).setValue(h);
      sheet.getRange(1, 1).copyFormatToRange(sheet, c, c, 1, 1);
      sheet.setColumnWidth(c, COL_WIDTHS[c - 1]);
    });
  });
}

/* ------------------------------------------------------------------ */
/* 管理者加報梯次（例外處理：同一人報名多個梯次）                      */
/* ------------------------------------------------------------------ */

/** 梯次輸入容錯：「2」「二」「第二梯次」都視為第二梯次 */
function parseSessionInput_(text) {
  const map = { '1': '第一梯次', '一': '第一梯次', '2': '第二梯次', '二': '第二梯次', '3': '第三梯次', '三': '第三梯次' };
  return String(text || '').split(/[,，、;；\s]+/).map(s => s.trim()).filter(Boolean).map(s => {
    if (SESSIONS.indexOf(s) !== -1) return s;
    const m = s.replace(/^第/, '').replace(/梯次?$/, '');
    return map[m] || s;
  }).filter((s, i, a) => a.indexOf(s) === i);
}

function sameEmpId_(a, b) {
  return normalizeId(a) === normalizeId(b);
}

/** 試算表選單：輸入人事號與要加報的梯次，確認後寫入並寄出通知信 */
function adminAddSessionsDialog() {
  const ui = SpreadsheetApp.getUi();
  const r1 = ui.prompt('管理者加報梯次', '請輸入已報名者的人事號：', ui.ButtonSet.OK_CANCEL);
  if (r1.getSelectedButton() !== ui.Button.OK) return;
  const empId = normalizeId(r1.getResponseText());
  if (!empId) return;

  const mine = readMaster_(getSheet_(MASTER_SHEET)).filter(r => sameEmpId_(r[COL['人事號'] - 1], empId));
  if (!mine.length) { ui.alert('總表找不到人事號「' + empId + '」的報名資料。\n管理者加報只能針對已報名過的同仁。'); return; }
  const base = rowToReg_(mine[0]);
  const has = mine.map(r => String(r[COL['梯次'] - 1]).trim());

  const r2 = ui.prompt('管理者加報梯次',
    base.name + '（' + base.empId + '／' + base.identity + '）目前已報名：' + has.join('、') +
    '\n\n請輸入要加報的梯次，可輸入多個並以逗號分隔\n例如：第二梯次,第三梯次　或　2,3', ui.ButtonSet.OK_CANCEL);
  if (r2.getSelectedButton() !== ui.Button.OK) return;
  const targets = parseSessionInput_(r2.getResponseText());
  if (!targets.length) return;

  const ok = ui.alert('確認加報',
    '將為 ' + base.name + '（' + base.empId + '／' + base.identity + '）加報：' + targets.join('、') +
    '\n寄送地址：' + base.email +
    '\n\n系統會略過「每人限報名一個梯次」的限制，但仍檢查各梯次名額；' +
    '\n每個加報梯次會各寄一封報名成功／行前資訊通知信（附行程 PDF）。\n\n確定執行？', ui.ButtonSet.YES_NO);
  if (ok !== ui.Button.YES) return;

  const res = adminAddSessions(empId, targets);
  ui.alert('管理者加報結果', res.message, ui.ButtonSet.OK);
}

/**
 * 管理者加報：以總表中該人事號的報名資料為基礎，複製到指定梯次。
 * 略過「每人限報名一個梯次」限制，但仍檢查名額；寫入總表與梯次分頁（備註欄標示管理者加報），
 * 之後立即寄出通知信並更新公開統計。
 */
function adminAddSessions(empId, targetSessions) {
  const added = [], skipped = [];
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  let name = '', shownId = String(empId).trim();
  try {
    const master = getSheet_(MASTER_SHEET);
    const all = readMaster_(master);
    const mine = all.filter(r => sameEmpId_(r[COL['人事號'] - 1], empId));
    if (!mine.length) return { added, skipped, message: '總表找不到人事號「' + empId + '」的報名資料。' };
    const baseRow = mine[0];
    name = String(baseRow[COL['姓名'] - 1]).trim();
    shownId = normalizeId(baseRow[COL['人事號'] - 1]);
    const identity = canonIdentity_(baseRow[COL['身分'] - 1]);
    const original = mine.map(r => String(r[COL['梯次'] - 1]).trim());
    const has = original.slice();
    const counts = countsFromRows_(all);

    ensureExtraHeaders_();
    targetSessions.forEach(s => {
      if (SESSIONS.indexOf(s) === -1) { skipped.push(s + '（梯次名稱不正確）'); return; }
      if (has.indexOf(s) !== -1) { skipped.push(s + '（已報名）'); return; }
      if (sessionTotal_(counts, s) >= SESSION_CAPS[s]) { skipped.push(s + '（報名人數已額滿）'); return; }

      const row = baseRow.slice(0, HEADERS.length);   // 文字欄的撇號與日期轉文字由 appendRow_ 統一處理
      row[COL['報名時間'] - 1] = new Date();
      row[COL['梯次'] - 1] = s;
      row[COL['通知寄送時間'] - 1] = '';
      row[COL['備註'] - 1] = '管理者加報（原報名：' + original.join('、') + '）';

      appendRow_(master, row);
      appendRow_(getSheet_(s), row);
      counts[s][countIdentity_(identity)]++;
      has.push(s);
      added.push(s);
    });
    SpreadsheetApp.flush();
    clearCache_();
  } finally {
    lock.releaseLock();
  }

  let mailMsg = '';
  if (added.length && NOTIFY_ON_REGISTER) {
    const mailLock = LockService.getUserLock();
    if (mailLock.tryLock(60000)) {
      try { mailMsg = sendPending_().msg; } finally { mailLock.releaseLock(); }
    } else {
      scheduleBackgroundJob_();
      mailMsg = '寄信作業忙碌中，已排入背景作業，約一分鐘內寄出。';
    }
  }
  try { publishStats(); } catch (err) { Logger.log('publishStats 失敗：' + err); }

  const lines = [];
  lines.push(name + '（' + shownId + '）');
  lines.push(added.length ? '已加報：' + added.join('、') : '沒有新增任何梯次。');
  if (skipped.length) lines.push('略過：' + skipped.join('、'));
  if (mailMsg) lines.push(mailMsg);
  const message = lines.join('\n');
  Logger.log(message);
  return { added, skipped, message };
}

/** 在梯次分頁找到同一人事號的列，標記通知寄送時間 */
function markSessionNotified_(reg, stamp) {
  const sheet = ss_().getSheetByName(reg.session);
  if (!sheet) return;
  const last = sheet.getLastRow();
  if (last < 2) return;
  const ids = sheet.getRange(2, COL['人事號'], last - 1, 1).getValues();
  for (let i = 0; i < ids.length; i++) {
    if (sameEmpId_(ids[i][0], reg.empId)) {
      sheet.getRange(i + 2, COL['通知寄送時間']).setValue(stamp).setNumberFormat('yyyy/MM/dd HH:mm:ss');
      return;
    }
  }
}

/* ------------------------------------------------------------------ */
/* 長官及工作人員：寄送報名成功／行前資訊                              */
/* 名單放在「另一份」Google 試算表（第一梯次／第二梯次／第三梯次分頁），  */
/* 不寫入報名試算表、不計入名額；寄送時間只記在名單試算表。             */
/* ------------------------------------------------------------------ */
const STAFF_PROP = 'STAFF_SPREADSHEET_ID';

/** 從網址或 ID 取出試算表 ID */
function spreadsheetIdFrom_(text) {
  const t = String(text || '').trim();
  const m = t.match(/\/d\/([a-zA-Z0-9_-]{20,})/);
  return m ? m[1] : t;
}

/** 讀取名單試算表三個梯次分頁；回傳每位收件人與其所在列 */
function readStaffList_(staffSs) {
  const list = [];
  SESSIONS.forEach(session => {
    const sh = staffSs.getSheetByName(session);
    if (!sh) return;
    const last = sh.getLastRow();
    if (last < 2) return;
    let lastCol = sh.getLastColumn();
    const head = sh.getRange(1, 1, 1, lastCol).getValues()[0].map(h => String(h).trim());
    const col = h => head.indexOf(h);
    if (col('姓名') < 0 || col('E-mail') < 0) throw new Error('「' + session + '」分頁缺少「姓名」或「E-mail」欄位');
    let sentIdx = col('通知寄送時間');
    if (sentIdx < 0) {                                   // 沒有寄送時間欄就在最後補一欄
      lastCol += 1; sentIdx = lastCol - 1;
      sh.getRange(1, lastCol).setValue('通知寄送時間').setFontWeight('bold');
    }
    const rows = sh.getRange(2, 1, last - 1, lastCol).getValues();
    const get = (r, h) => col(h) >= 0 ? String(r[col(h)] == null ? '' : r[col(h)]).trim() : '';
    rows.forEach((r, i) => {
      const name = get(r, '姓名'), email = get(r, 'E-mail');
      if (!name && !email) return;
      list.push({
        sheet: sh, row: i + 2, sentCol: sentIdx + 1, sent: !!r[sentIdx],
        reg: {
          session: get(r, '梯次') || session, identity: get(r, '身分'), unit: get(r, '單位'), name: name,
          empId: normalizeId(get(r, '人事號')), title: get(r, '職稱'), email: email, meal: get(r, '餐食') || '葷食'
        }
      });
    });
  });
  return list;
}

/** 開啟名單試算表：先用上次記住的 ID，沒有就請使用者貼網址 */
function openStaffSpreadsheet_(ui, askAlways) {
  const props = PropertiesService.getScriptProperties();
  let id = props.getProperty(STAFF_PROP) || '';
  if (!id || askAlways) {
    const r = ui.prompt('長官及工作人員名單',
      '請貼上名單 Google 試算表的網址（需含「第一梯次」「第二梯次」「第三梯次」分頁）' + (id ? '\n留空則沿用上次的名單試算表。' : ''),
      ui.ButtonSet.OK_CANCEL);
    if (r.getSelectedButton() !== ui.Button.OK) return null;
    const input = spreadsheetIdFrom_(r.getResponseText());
    if (input) id = input;
  }
  if (!id) return null;
  if (id === SPREADSHEET_ID) {
    ui.alert('這是報名試算表。長官及工作人員名單請放在另一份試算表，避免混入報名資料。');
    return null;
  }
  const staffSs = SpreadsheetApp.openById(id);
  props.setProperty(STAFF_PROP, id);
  return staffSs;
}

/* ------------------------------------------------------------------ */
/* 長官及工作人員：匯入報名資料                                         */
/* ------------------------------------------------------------------ */
/**
 * 選單：把長官及工作人員名單試算表（「第一梯次」「第二梯次」「第三梯次」分頁，欄位同報名表）
 * 加入報名試算表的「活動報名資料」與各梯次分頁。
 * - 身分保留「長官」「工作人員」；統計時合併為「長官/工作人員」，計入各梯次總人數上限。
 * - 「通知寄送時間」填入匯入時間：報名成功／行前資訊已另行寄送，背景作業不會再寄。
 * - 同梯次已有相同人事號或身分證號的資料會略過，可以重複執行。
 * - 不放進公開的問卷查詢名單，也不能填寫活動滿意度調查。
 * - 名單試算表的「活動報名資料」分頁只用來核對（與三個梯次分頁的人是否一致），不另外匯入，避免重複。
 */
function importStaffRegistrationsDialog() {
  const ui = SpreadsheetApp.getUi();
  const staffSs = openStaffSpreadsheet_(ui, true);
  if (!staffSs) return;
  const plan = planStaffImport_(staffSs);
  if (plan.error) { ui.alert(plan.error); return; }
  const notes = plan.skipped.length ? '\n\n略過 ' + plan.skipped.length + ' 筆：\n' + plan.skipped.join('\n') : '';
  const warns = plan.warnings.length ? '\n\n⚠️ 請確認：\n' + plan.warnings.join('\n') : '';
  if (!plan.add.length) { ui.alert('沒有需要匯入的資料。' + notes + warns); return; }
  const lines = SESSIONS.map(s => {
    const xs = plan.add.filter(x => x.session === s);
    return xs.length ? s + ' ' + xs.length + ' 位：' + xs.map(x => x.name + '（' + x.identity + '）').join('、') : '';
  }).filter(Boolean);
  const ok = ui.alert('匯入長官及工作人員',
    '將加入「活動報名資料」與各梯次分頁，共 ' + plan.add.length + ' 位：\n\n' + lines.join('\n') +
    '\n\n不會寄送報名成功／行前資訊 E-mail（通知寄送時間會填入匯入時間）。' + notes + warns + '\n\n確定匯入？',
    ui.ButtonSet.YES_NO);
  if (ok !== ui.Button.YES) return;
  const n = importStaffRows_(plan.add);
  ui.alert('已匯入 ' + n + ' 位長官及工作人員。\n儀表板與報名網頁約 1 分鐘內更新（各梯次總人數已包含長官及工作人員）。');
}

/** 讀取名單並決定要匯入哪些人（不寫入） */
function planStaffImport_(staffSs) {
  const master = getSheet_(MASTER_SHEET);
  const existing = readMaster_(master);
  const key = (s, id) => s + '|' + id;
  const seen = {};
  existing.forEach(r => {
    const s = String(r[COL['梯次'] - 1]).trim();
    const e = normalizeId(r[COL['人事號'] - 1]), n = normalizeId(r[COL['身分證號'] - 1]);
    if (e) seen[key(s, 'E' + e)] = true;
    if (n) seen[key(s, 'N' + n)] = true;
  });
  const add = [], skipped = [], warnings = [];
  let tabs = 0;
  SESSIONS.forEach(session => {
    const sh = staffSs.getSheetByName(session);
    if (!sh || sh.getLastRow() < 2) return;
    tabs++;
    const head = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(h => String(h).trim());
    const values = sh.getRange(2, 1, sh.getLastRow() - 1, head.length).getValues();
    values.forEach(v => {
      const get = h => head.indexOf(h) === -1 ? '' : v[head.indexOf(h)];
      const name = String(get('姓名')).trim();
      if (!name) return;
      const identity = canonIdentity_(get('身分'));
      const empId = normalizeId(get('人事號')), nid = normalizeId(get('身分證號'));
      const label = session + '｜' + name;
      if (!isStaff_(identity)) { skipped.push(label + '：身分「' + (identity || '空白') + '」不是長官或工作人員'); return; }
      const rowSession = String(get('梯次')).trim();
      if (rowSession && rowSession !== session) warnings.push(label + '：「梯次」欄寫的是 ' + rowSession + '，以分頁「' + session + '」為準');
      if ((empId && seen[key(session, 'E' + empId)]) || (nid && seen[key(session, 'N' + nid)])) { skipped.push(label + '：已在報名資料中'); return; }
      if (empId) seen[key(session, 'E' + empId)] = true;
      if (nid) seen[key(session, 'N' + nid)] = true;
      const row = HEADERS.map(h => {
        const x = get(h);
        return x === null || x === undefined ? '' : x;
      });
      row[COL['梯次'] - 1] = session;
      row[COL['身分'] - 1] = identity;
      add.push({ session: session, name: name, identity: identity, empId: empId, row: row });
    });
  });
  if (!tabs) return { error: '名單試算表找不到有資料的「第一梯次」「第二梯次」「第三梯次」分頁。' };

  // 與名單的「活動報名資料」分頁核對（只提醒，不匯入）
  const all = staffSs.getSheetByName(MASTER_SHEET);
  if (all && all.getLastRow() >= 2) {
    const head = all.getRange(1, 1, 1, all.getLastColumn()).getValues()[0].map(h => String(h).trim());
    const cS = head.indexOf('梯次'), cN = head.indexOf('姓名');
    if (cS !== -1 && cN !== -1) {
      const inAll = all.getRange(2, 1, all.getLastRow() - 1, head.length).getValues()
        .filter(r => String(r[cN]).trim()).map(r => String(r[cS]).trim() + '｜' + String(r[cN]).trim());
      const inTabs = add.map(x => x.session + '｜' + x.name).concat(skipped.map(t => t.split('：')[0]));
      inAll.filter(x => inTabs.indexOf(x) === -1).forEach(x => warnings.push(x + '：只在名單的「活動報名資料」分頁，梯次分頁沒有（未匯入）'));
    }
  }
  return { add: add, skipped: skipped, warnings: warnings };
}

/** 寫入（鎖定期間）；回傳匯入人數 */
function importStaffRows_(items) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const master = getSheet_(MASTER_SHEET);
    const now = new Date();
    ensureExtraHeaders_();
    items.forEach(x => {
      const row = x.row.slice();
      row[COL['通知寄送時間'] - 1] = now;               // 已另行寄送，背景作業不會再寄
      row[COL['備註'] - 1] = [String(row[COL['備註'] - 1] || '').trim(), '長官/工作人員匯入（報名成功及行前資訊已另行寄送）'].filter(Boolean).join('；');
      appendRow_(master, row);
      appendRow_(getSheet_(x.session), row);
    });
    SpreadsheetApp.flush();
    try { refreshCaches_(); } catch (e) { clearCache_(); }
  } finally {
    lock.releaseLock();
  }
  try { publishStats(); } catch (e) { Logger.log('publishStats 失敗：' + e); }
  return items.length;
}

/** 選單：寄送長官及工作人員的報名成功／行前資訊（已寄過的會略過） */
function sendStaffNotificationsDialog() {
  const ui = SpreadsheetApp.getUi();
  const staffSs = openStaffSpreadsheet_(ui, true);
  if (!staffSs) return;
  const list = readStaffList_(staffSs);
  const bad = list.filter(x => !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(x.reg.email));
  const pending = list.filter(x => !x.sent && bad.indexOf(x) === -1);
  if (!pending.length) {
    ui.alert('沒有需要寄送的對象。\n名單共 ' + list.length + ' 位，已寄過 ' + list.filter(x => x.sent).length + ' 位' +
      (bad.length ? '，E-mail 格式有誤 ' + bad.length + ' 位' : '') + '。');
    return;
  }
  const lines = pending.map(x => x.reg.session + '｜' + (x.reg.identity || '－') + '｜' + x.reg.name + '｜' + x.reg.email);
  const ok = ui.alert('確認寄送（名單：' + staffSs.getName() + '）',
    '將寄出 ' + pending.length + ' 封「報名成功／行前資訊」通知信，附行程 PDF：\n\n' + lines.join('\n') +
    (list.length - pending.length ? '\n\n已寄過而略過：' + list.filter(x => x.sent).length + ' 位' : '') +
    (bad.length ? '\nE-mail 格式有誤而略過：' + bad.map(x => x.reg.name).join('、') : '') +
    '\n\n這些資料不會寫入報名試算表，也不計入名額。確定寄送？', ui.ButtonSet.YES_NO);
  if (ok !== ui.Button.YES) return;

  const lock = LockService.getUserLock();
  if (!lock.tryLock(60000)) { ui.alert('另一個寄信作業正在執行，請稍後再試。'); return; }
  let sent = 0;
  const failed = [];
  try {
    const pdfBlob = getItineraryPdfBlob_();   // 附件只下載一次
    pending.forEach(x => {
      try {
        sendNotificationEmail_(x.reg, null, pdfBlob);
        x.sheet.getRange(x.row, x.sentCol).setValue(new Date()).setNumberFormat('yyyy/MM/dd HH:mm:ss');
        sent++;
      } catch (err) {
        failed.push(x.reg.name + '（' + err + '）');
        Logger.log('長官及工作人員寄送失敗 ' + x.reg.name + ' <' + x.reg.email + '>：' + err);
      }
    });
    SpreadsheetApp.flush();
  } finally {
    lock.releaseLock();
  }
  ui.alert('寄送完成：成功 ' + sent + ' 封' + (failed.length ? '，失敗 ' + failed.length + ' 封：\n' + failed.join('\n') : '') +
    '\n寄送時間已記錄在名單試算表的「通知寄送時間」欄。');
}

/** 選單：用名單中第一位尚未寄送者的資料，寄一封預覽到自己的信箱 */
function previewStaffNotificationDialog() {
  const ui = SpreadsheetApp.getUi();
  const staffSs = openStaffSpreadsheet_(ui, false);
  if (!staffSs) return;
  const list = readStaffList_(staffSs);
  const target = list.filter(x => !x.sent)[0] || list[0];
  if (!target) { ui.alert('名單試算表沒有資料。'); return; }
  const me = Session.getActiveUser().getEmail() || Session.getEffectiveUser().getEmail();
  sendNotificationEmail_(target.reg, me);
  ui.alert('預覽信已寄到 ' + me + '（內容為：' + target.reg.name + '／' + target.reg.session + '）。\n此動作不會標記寄送時間。');
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
  // 每 5 分鐘的排程順便重建快取，讓網頁與儀表板的讀取維持在快取命中（回應較快、較不受冷啟動影響）
  const rows = readMaster_(getSheet_(MASTER_SHEET));
  try { refreshCaches_(rows); } catch (err) { Logger.log('refreshCaches_ 失敗：' + err); }

  const id = PropertiesService.getScriptProperties().getProperty(STATS_PROP);
  if (!id) return;   // 尚未執行 setupStatsPublishing
  let stats;
  try { stats = SpreadsheetApp.openById(id); } catch (e) { return; }
  let sheet = stats.getSheetByName(STATS_SHEET) || stats.insertSheet(STATS_SHEET);

  const counts = countsFromRows_(rows);
  const tz = Session.getScriptTimeZone();
  const now = Utilities.formatDate(new Date(), tz, 'yyyy/MM/dd HH:mm:ss');
  const out = [['類型', '鍵1', '鍵2', '數值', '更新時間']];

  SESSIONS.forEach(s => out.push(['梯次上限', s, '', SESSION_CAPS[s], now]));
  SESSIONS.forEach(s => COUNT_IDENTITIES.forEach(k => out.push(['名額', s, k, counts[s][k], now])));

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

  try { publishSurveyLookup_(stats, rows, now); } catch (err) { Logger.log('publishSurveyLookup_ 失敗：' + err); }
}

/*
 * 活動滿意度調查的人事號查詢名單：寫在公開統計試算表的「問卷查詢」分頁，問卷網頁以 GViz 讀取
 * （Apps Script 回應常常很慢，GViz 快且穩定）。
 * ⚠️ 此分頁任何拿到連結的人都能讀取：使用者 2026-10-07 同意公開人事號、梯次、身分、單位、姓名、職稱
 *    與「已填寫編號」；E-mail、手機、出生日期、身分證號、餐食一律不放。
 * 隨 publishStats 更新（每 5 分鐘、每筆報名與每份問卷送出後約 1 分鐘內）。
 */
const SURVEY_LOOKUP_SHEET = '問卷查詢';
const SURVEY_LOOKUP_HEADERS = ['人事號', '梯次', '身分', '單位', '姓名', '職稱', '已填寫編號', '更新時間'];
function publishSurveyLookup_(stats, rows, now) {
  // 舊標題寫著「不含個資」，加入此名單後已不正確：改成現在的標題，避免有人誤以為可以公開轉貼
  try { if (/不含個資/.test(stats.getName())) stats.rename(STATS_TITLE); } catch (e) {}
  const sheet = stats.getSheetByName(SURVEY_LOOKUP_SHEET) || stats.insertSheet(SURVEY_LOOKUP_SHEET);
  const done = {};                                     // 梯次|人事號 → 已填寫的問卷編號
  SESSIONS.forEach(s => {
    const sh = ss_().getSheetByName(SURVEY_SHEETS[s]);
    if (sh) surveyEntries_(sh).forEach(x => { if (x.empId && !done[s + '|' + x.empId]) done[s + '|' + x.empId] = x.no || '已填寫'; });
  });
  const out = registrationsFromRows_(rows).filter(r => !isStaff_(r.identity)).map(r => [   // 長官及工作人員不放進公開名單
    r.empId, r.session, canonIdentity_(r.identity), r.unit, r.name, r.title, done[r.session + '|' + r.empId] || '', now
  ]);
  sheet.clearContents();
  writeRowsAt_(sheet, 1, [SURVEY_LOOKUP_HEADERS].concat(out), SURVEY_LOOKUP_HEADERS, ['人事號', '單位', '姓名', '職稱'], null);
}

/* ------------------------------------------------------------------ */
/* 活動滿意度調查（survey-1.html／survey-2.html／survey-3.html）        */
/* ------------------------------------------------------------------ */
/*
 * 流程：
 *   1. 網頁輸入人事號 → GET ?action=surveyLookup 由總表帶出梯次、身分、單位、姓名、職稱。
 *   2. 照片：網頁向後端申請 Drive API 可續傳上傳網址，直接把原檔分塊上傳到該梯次的雲端硬碟資料夾（暫時檔名），
 *      不限檔案大小，中斷可續傳（見下方「照片上傳」一節）。
 *   3. 送出 → POST action=survey（只帶檔案 ID）：
 *      a. 以人事號重新查總表（不採信網頁送來的姓名等資料）；確認檔案是這份問卷上傳的。
 *      b. 鎖定 → 決定「編號」（該分頁現有最大編號 + 1，從 1 開始）→ 檔案改名為「編號-梯次-姓名.副檔名」→ 寫入一列 → 解鎖。
 *   4. 每次送出帶一組送出代碼：Google 把 POST 轉成 GET、或網路中斷後網頁重送時，
 *      同一組代碼不會重複寫入，直接回覆原本的編號。
 *   每人每梯次限填寫一次（使用者 2026-10-06 要求）：同一梯次分頁已有此人事號就不再寫入。
 *   （管理者加報而參加兩個梯次的人，兩個梯次的問卷各可填一次。）
 */
const SURVEY_SHEETS = {
  '第一梯次': '第一梯次活動滿意度調查',
  '第二梯次': '第二梯次活動滿意度調查',
  '第三梯次': '第三梯次活動滿意度調查'
};
// 雲端硬碟資料夾 ID：photo＝活動照、social＝社群媒體截圖
const SURVEY_FOLDERS = {
  '第一梯次': { photo: '1G1GoZ-_st3ScsuhskrUet2ef-ANVz4Ty', social: '16ASsU_J_i3KH_UsULzJLxC0lPFZ9rbtw' },
  '第二梯次': { photo: '1aC8l40vsFAe4vrnueEqMl2aXxqn-7lP3', social: '1Kww_-QJIifSE5aMXjnx3GyJOC1yof1s6' },
  '第三梯次': { photo: '1WkAgXSNxdHmQo6XMEpFBk7msDMiLTQN2', social: '1XTnAUDv8Dl2qJpNeZ603N-4rDH3IXs1O' }
};
// 10 題的表頭（順序與 assets/survey.js 的 QUESTIONS 相同；完整題目見該檔）
const SURVEY_QUESTIONS = [
  'Q1 飲食文化｜認識臺南飲食文化與生活',
  'Q2 飲食文化｜理解飲食與健康的關聯',
  'Q3 飲食文化｜照護時留意病人飲食習慣',
  'Q4 社區照護｜了解病人在醫院外的生活',
  'Q5 社區照護｜家庭與社區資源的重要性',
  'Q6 社區照護｜跨職類交流與合作',
  'Q7 自我覺察｜覺察自己的情緒與身心',
  'Q8 自我覺察｜反思專業價值與初衷',
  'Q9 自我覺察｜把體會帶回日常工作',
  'Q10 整體滿意度'
];
const SURVEY_HEADERS = ['編號', '填寫時間', '梯次', '身分', '單位', '姓名', '人事號', '職稱']
  .concat(SURVEY_QUESTIONS)
  .concat(['其他建議或回饋', '最感動的一段話', '活動照', '社群媒體截圖', '送出代碼']);   // 其他建議或回饋：選填（2026-10-08 新增）
const SURVEY_TEXT_COLS = ['人事號', '單位', '姓名', '職稱', '其他建議或回饋', '最感動的一段話'];
const SURVEY_SUGGEST_MAX = 1000;
const SURVEY_STORY_MIN = 20;                 // 最感動的一段話至少字數（與 survey.js 相同）
const SURVEY_STORY_MAX = 1000;

/** 取得（必要時建立）某梯次的活動滿意度調查分頁 */
function surveySheet_(session) {
  const name = SURVEY_SHEETS[session];
  const sheet = ss_().getSheetByName(name);
  return sheet || ensureSurveySheet_(session);
}

/** 建立／校正活動滿意度調查分頁：補齊缺少的表頭（不清除、不搬動既有資料），設定格式 */
function ensureSurveySheet_(session) {
  const ss = ss_();
  const name = SURVEY_SHEETS[session];
  let sheet = ss.getSheetByName(name);
  if (!sheet) sheet = ss.insertSheet(name);
  const headers = surveyHeaders_(sheet);
  sheet.getRange(1, 1, 1, headers.length)
    .setFontWeight('bold').setBackground('#3e7c59').setFontColor('#ffffff')
    .setHorizontalAlignment('center').setVerticalAlignment('middle');
  sheet.setFrozenRows(1);
  sheet.setRowHeight(1, 32);
  const widths = { '編號': 60, '填寫時間': 150, '梯次': 80, '身分': 140, '單位': 130, '姓名': 90, '人事號': 90, '職稱': 110,
    '其他建議或回饋': 300, '最感動的一段話': 360, '活動照': 150, '社群媒體截圖': 150, '送出代碼': 120 };
  headers.forEach((h, i) => sheet.setColumnWidth(i + 1, widths[h] || 120));
  const rows = sheet.getMaxRows() - 1;
  if (rows > 0) {
    SURVEY_TEXT_COLS.forEach(h => sheet.getRange(2, headers.indexOf(h) + 1, rows, 1).setNumberFormat('@'));
    sheet.getRange(2, headers.indexOf('填寫時間') + 1, rows, 1).setNumberFormat('yyyy/MM/dd HH:mm:ss');
  }
  return sheet;
}

/**
 * 讀取表頭；缺少的欄位插在 SURVEY_HEADERS 裡前一個欄位的右邊（例如新增的「其他建議或回饋」插在 Q10 之後），
 * 找不到前一個欄位才補在最後。承辦人調整過欄位順序也能依表頭名稱寫入。
 */
function surveyHeaders_(sheet) {
  const lastCol = Math.max(sheet.getLastColumn(), 1);
  const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(h => String(h).trim());
  while (headers.length && headers[headers.length - 1] === '') headers.pop();
  if (!headers.length) {                                   // 新分頁：直接寫入整列表頭
    sheet.getRange(1, 1, 1, SURVEY_HEADERS.length).setValues([SURVEY_HEADERS]);
    return SURVEY_HEADERS.slice();
  }
  SURVEY_HEADERS.forEach((h, i) => {
    if (headers.indexOf(h) !== -1) return;
    let after = -1;
    for (let k = i - 1; k >= 0 && after === -1; k--) after = headers.indexOf(SURVEY_HEADERS[k]);
    if (after === -1 || after === headers.length - 1) {
      sheet.getRange(1, headers.length + 1).setValue(h);
      headers.push(h);
    } else {
      sheet.insertColumnAfter(after + 1);                  // 既有資料一併右移
      sheet.getRange(1, after + 2).setValue(h);
      headers.splice(after + 1, 0, h);
    }
  });
  return headers;
}

/** 由總表找此人事號在指定梯次的報名資料；找不到時回傳他實際報名的梯次 */
function findRegistration_(session, empId, rows) {
  const id = normalizeId(empId);
  const mine = rows.filter(r => normalizeId(r.empId) === id);
  const record = mine.find(r => r.session === session) || null;
  const otherSessions = mine.map(r => r.session).filter((s, i, a) => s !== session && a.indexOf(s) === i);
  return { record: record, otherSessions: otherSessions };
}

/** 問卷用的報名名單（同儀表板名單格式，不含長官及工作人員）；優先用快取，沒有快取才讀試算表 */
function registrationList_(fresh) {
  let list = null;
  if (!fresh) {
    const cached = cacheGet_('dashboard');
    if (cached && Array.isArray(cached.registrations)) list = cached.registrations;
  }
  if (!list) list = registrationsFromRows_(readMaster_(getSheet_(MASTER_SHEET)));
  return list.filter(r => !isStaff_(r.identity));
}

/** 此分頁已有的填寫紀錄：[{ no, empId, id, row }] */
function surveyEntries_(sheet) {
  const last = sheet.getLastRow();
  if (last < 2) return [];
  const headers = sheet.getRange(1, 1, 1, Math.max(sheet.getLastColumn(), 1)).getValues()[0].map(h => String(h).trim());
  const cNo = headers.indexOf('編號'), cEmp = headers.indexOf('人事號'), cId = headers.indexOf('送出代碼');
  return sheet.getRange(2, 1, last - 1, headers.length).getValues().map((r, i) => ({
    no: cNo === -1 ? 0 : Number(r[cNo]) || 0,
    empId: cEmp === -1 ? '' : normalizeId(r[cEmp]),
    id: cId === -1 ? '' : String(r[cId]).trim(),
    row: i + 2
  }));
}

const surveyRecord_ = r => ({ session: r.session, identity: canonIdentity_(r.identity), unit: r.unit, name: r.name, empId: r.empId, title: r.title });

/** GET ?action=surveyLookup&session=…&empId=… */
function surveyLookup_(session, empId) {
  session = String(session || '').trim();
  if (!SURVEY_SHEETS[session]) return { ok: false, error: 'invalid', message: '梯次不正確' };
  const id = normalizeId(empId);
  if (!id) return { ok: false, error: 'invalid', message: '請填寫人事號' };
  let found = findRegistration_(session, id, registrationList_(false));
  if (!found.record) found = findRegistration_(session, id, registrationList_(true));   // 快取可能還沒更新
  if (!found.record) {
    return {
      ok: false, error: 'notfound', otherSessions: found.otherSessions,
      message: found.otherSessions.length
        ? '您報名的是' + found.otherSessions.join('、') + '，請填寫該梯次的問卷。'
        : '查無此人事號的' + session + '報名資料，請確認人事號，或洽教學部（分機 57440）。'
    };
  }
  const sheet = ss_().getSheetByName(SURVEY_SHEETS[session]);
  const before = sheet ? surveyEntries_(sheet).filter(x => x.empId === id).map(x => x.no) : [];
  return { ok: true, found: true, record: surveyRecord_(found.record), submittedBefore: before };
}

/** 此人事號已填寫過本梯次問卷 */
function surveyDuplicate_(session, prior) {
  return {
    ok: false, error: 'duplicate', no: prior.no,
    message: '您已填寫過' + session + '問卷（編號 ' + prior.no + '），每人限填寫一次；如需修改請洽教學部（分機 57440）。'
  };
}

/** GET ?action=surveyStatus&session=…&id=…：此送出代碼是否已寫入（網頁重送前確認用） */
function surveyStatus_(session, id) {
  session = String(session || '').trim();
  id = String(id || '').trim();
  if (!SURVEY_SHEETS[session] || !id) return { ok: false, error: 'invalid' };
  const sheet = ss_().getSheetByName(SURVEY_SHEETS[session]);
  const hit = sheet ? surveyEntries_(sheet).find(x => x.id === id) : null;
  return hit ? { ok: true, found: true, no: hit.no } : { ok: true, found: false };
}

/* ---- 照片上傳：Google Drive API 可續傳上傳（Resumable Upload）＋分塊續傳 ----
 *
 * 1. 網頁 GET ?action=surveyUploadUrl → 後端以 Apps Script 擁有者的權杖向 Drive API 申請「可續傳的上傳網址」
 *    （暫時檔名「上傳中-送出代碼-活動照.副檔名」、放在該梯次的資料夾），並帶入網頁的 Origin，
 *    讓瀏覽器可以直接對這個網址上傳。權杖不會傳到網頁，網頁只拿到這一個檔案專用的上傳網址。
 * 2. 網頁把檔案切成 8 MB 分塊，直接 PUT 到上傳網址（Content-Range）；中斷時查詢已收到的位元組數，從中斷處續傳。
 * 3. 若瀏覽器無法直接連線上傳網址（例如網路或 CORS 限制），網頁改由後端代傳分塊
 *    （POST action=surveyUploadChunk），續傳查詢一律由後端代查（GET ?action=surveyUploadStatus）。
 * 4. 送出問卷時只傳檔案 ID；後端確認檔案確實是這份問卷上傳的，再改名為「編號-梯次-姓名.副檔名」。
 * 不限檔案大小（受 Apps Script 擁有者的雲端硬碟空間限制）。
 */
const SURVEY_KINDS = { photo: '活動照', social: '社群媒體截圖' };
const SURVEY_UPLOAD_EXTS = ['jpg', 'png', 'webp', 'gif', 'heic', 'heif', 'tif', 'tiff', 'bmp', 'dng', 'cr2', 'cr3', 'nef', 'arw', 'orf', 'rw2', 'raf'];
// 允許直接上傳的網頁來源（上傳網址只對這些 Origin 開放 CORS）
const SURVEY_UPLOAD_ORIGINS = [/^https:\/\/linmenggann\.github\.io$/, /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/];
const SURVEY_TEMP_PREFIX = '上傳中-';
const DRIVE_UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&supportsAllDrives=true&fields=id,name';

/** 檔名只用「編號-梯次-姓名」（例：1-第一梯次-王小明.jpg）：去掉雲端硬碟與作業系統不允許的字元 */
function safeFileName_(s) {
  const v = String(s || '').replace(/[\\/:*?"<>|\u0000-\u001F]/g, '').replace(/\s+/g, ' ').trim();
  return v || '未具名';
}

const surveyTempName_ = (sid, kind, ext) => SURVEY_TEMP_PREFIX + sid + '-' + SURVEY_KINDS[kind] + '.' + ext;
const validSid_ = sid => /^[A-Za-z0-9-]{8,64}$/.test(sid);
const isDriveUploadUrl_ = u => /^https:\/\/www\.googleapis\.com\/upload\/drive\/v3\/files\?[^\s#]*\bupload_id=[\w-]+/.test(String(u || ''));

/** 副檔名：小寫、jpeg → jpg，必須是允許的圖片格式 */
function surveyExt_(ext) {
  let e = String(ext || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (e === 'jpeg' || e === 'jpe') e = 'jpg';
  return SURVEY_UPLOAD_EXTS.indexOf(e) === -1 ? '' : e;
}

/** 取 HTTP 回應標頭（不分大小寫） */
function header_(res, name) {
  const h = res.getAllHeaders ? res.getAllHeaders() : res.getHeaders();
  const key = Object.keys(h).find(k => k.toLowerCase() === name.toLowerCase());
  const v = key ? h[key] : '';
  return Array.isArray(v) ? v[0] : v;
}

/** Drive 可續傳上傳的回應 → { status, next（下一個要傳的位元組）, done, fileId, expired } */
function driveUploadResult_(res) {
  const code = res.getResponseCode();
  if (code === 200 || code === 201) {
    let id = '';
    try { id = JSON.parse(res.getContentText()).id || ''; } catch (e) {}
    return { ok: true, status: code, done: true, fileId: id };
  }
  if (code === 308) {
    const range = String(header_(res, 'Range') || '');
    const m = range.match(/bytes=0-(\d+)/);
    return { ok: true, status: 308, next: m ? Number(m[1]) + 1 : 0 };
  }
  if (code === 404 || code === 410) return { ok: true, status: code, expired: true };
  let message = '上傳失敗（HTTP ' + code + '）';
  if (code === 403 && /storageQuotaExceeded|quota/i.test(res.getContentText())) message = '雲端硬碟空間已滿，請洽教學部（分機 57440）。';
  return { ok: false, status: code, error: 'upload', message: message };
}

/** 檢查上傳相關請求的共同參數；回傳 { session, sid, kind } 或 { error } */
function surveyUploadArgs_(p) {
  const session = String(p.session || '').trim();
  const sid = String(p.submissionId || p.id || '').trim();
  const kind = String(p.kind || '').trim();
  if (!SURVEY_SHEETS[session]) return { error: { ok: false, error: 'invalid', message: '梯次不正確' } };
  if (!validSid_(sid)) return { error: { ok: false, error: 'invalid', message: '送出代碼不正確，請重新整理頁面。' } };
  if (!SURVEY_KINDS[kind]) return { error: { ok: false, error: 'invalid', message: '上傳類別不正確' } };
  return { session: session, sid: sid, kind: kind };
}

/** GET ?action=surveyUploadUrl：申請可續傳的上傳網址 */
function surveyUploadUrl_(p) {
  const a = surveyUploadArgs_(p);
  if (a.error) return a.error;
  const size = Number(p.size);
  if (!(size > 0) || Math.floor(size) !== size) return { ok: false, error: 'invalid', message: '檔案大小不正確' };
  const ext = surveyExt_(p.ext);
  if (!ext) return { ok: false, error: 'invalid', message: '只能上傳圖片檔（JPG、PNG、HEIC、RAW 等）。' };
  let type = String(p.type || '').toLowerCase().trim();
  if (type && type.indexOf('image/') !== 0) type = '';           // 例如 application/octet-stream：交給雲端硬碟判斷
  const origin = String(p.origin || '').trim();
  if (!SURVEY_UPLOAD_ORIGINS.some(re => re.test(origin))) return { ok: false, error: 'invalid', message: '不允許的網頁來源' };

  // 必須是此梯次的報名者、且尚未填寫過
  const empId = normalizeId(p.empId);
  let found = findRegistration_(a.session, empId, registrationList_(false));
  if (!found.record) found = findRegistration_(a.session, empId, registrationList_(true));
  if (!empId || !found.record) return { ok: false, error: 'notfound', message: '查無此人事號的' + a.session + '報名資料。' };
  const sheet = ss_().getSheetByName(SURVEY_SHEETS[a.session]);
  if (sheet) {
    const entries = surveyEntries_(sheet);
    const done = entries.find(x => x.id === a.sid);
    if (done) return { ok: false, error: 'submitted', no: done.no, message: '這份問卷已送出（編號 ' + done.no + '）。' };
    const prior = entries.find(x => x.empId === found.record.empId);
    if (prior) return surveyDuplicate_(a.session, prior);
  }

  const meta = { name: surveyTempName_(a.sid, a.kind, ext), parents: [SURVEY_FOLDERS[a.session][a.kind]] };
  if (type) meta.mimeType = type;
  const res = UrlFetchApp.fetch(DRIVE_UPLOAD_API, {
    method: 'post',
    contentType: 'application/json; charset=UTF-8',
    payload: JSON.stringify(meta),
    headers: {
      Authorization: 'Bearer ' + ScriptApp.getOAuthToken(),
      'X-Upload-Content-Length': String(size),
      'X-Upload-Content-Type': type || 'application/octet-stream',
      Origin: origin                                   // 讓瀏覽器（此 Origin）可以直接上傳到這個網址
    },
    muteHttpExceptions: true
  });
  const code = res.getResponseCode();
  const url = code === 200 ? String(header_(res, 'Location') || '') : '';
  if (!isDriveUploadUrl_(url)) {
    Logger.log('申請上傳網址失敗：' + code + ' ' + res.getContentText().slice(0, 500));
    return { ok: false, error: 'server', message: '無法建立上傳連線（HTTP ' + code + '），請稍後再試，或洽教學部（分機 57440）。' };
  }
  return { ok: true, uploadUrl: url, name: meta.name };
}

/** GET ?action=surveyUploadStatus：由後端查詢上傳進度（續傳用） */
function surveyUploadStatus_(p) {
  const a = surveyUploadArgs_(p);
  if (a.error) return a.error;
  const url = String(p.url || '');
  const total = Number(p.total);
  if (!isDriveUploadUrl_(url) || !(total > 0)) return { ok: false, error: 'invalid', message: '上傳網址不正確' };
  const res = UrlFetchApp.fetch(url, {
    method: 'put', headers: { 'Content-Range': 'bytes */' + total },
    muteHttpExceptions: true, followRedirects: false
  });
  const out = driveUploadResult_(res);
  out.uploadStatus = true;
  return out;
}

/** POST action=surveyUploadChunk：瀏覽器無法直接連線上傳網址時，由後端代傳一個分塊 */
function surveyUploadChunk_(d) {
  const a = surveyUploadArgs_(d);
  if (a.error) return a.error;
  const url = String(d.url || '');
  const start = Number(d.start), total = Number(d.total);
  if (!isDriveUploadUrl_(url) || !(start >= 0) || !(total > 0)) return { ok: false, error: 'invalid', message: '上傳參數不正確' };
  const bytes = Utilities.base64Decode(String(d.data || ''));
  if (!bytes.length || start + bytes.length > total) return { ok: false, error: 'invalid', message: '分塊大小不正確' };
  const end = start + bytes.length - 1;
  const res = UrlFetchApp.fetch(url, {
    method: 'put',
    payload: Utilities.newBlob(bytes, 'application/octet-stream'),
    headers: { 'Content-Range': 'bytes ' + start + '-' + end + '/' + total },
    muteHttpExceptions: true, followRedirects: false
  });
  const out = driveUploadResult_(res);
  out.chunk = true;
  return out;
}

/** 確認檔案確實是這份問卷（送出代碼）上傳到正確資料夾的暫存檔；回傳 { file, ext } */
function surveyUploadedFile_(id, session, kind, sid) {
  const label = SURVEY_KINDS[kind];
  let file;
  try { file = DriveApp.getFileById(String(id)); } catch (e) { file = null; }
  const prefix = SURVEY_TEMP_PREFIX + sid + '-' + label + '.';
  if (!file || file.isTrashed() || file.getName().indexOf(prefix) !== 0) {
    const err = new Error(label + '找不到或已失效，請重新選擇照片後再送出一次。');
    err.reupload = kind;
    throw err;
  }
  const folderId = SURVEY_FOLDERS[session][kind];
  const parents = file.getParents();
  let inFolder = false;
  while (parents.hasNext()) if (parents.next().getId() === folderId) inFolder = true;
  if (!inFolder) {
    const err = new Error(label + '不在正確的資料夾，請重新選擇照片後再送出一次。');
    err.reupload = kind;
    throw err;
  }
  return { file: file, ext: surveyExt_(file.getName().slice(prefix.length)) || 'jpg' };
}

/** 把這份問卷沒有用到的暫存檔丟到垃圾桶（例如上傳後又換了一張照片） */
function trashSurveyTemps_(session, sid, keepIds) {
  Object.keys(SURVEY_KINDS).forEach(kind => {
    try {
      const it = DriveApp.getFolderById(SURVEY_FOLDERS[session][kind]).searchFiles('title contains "' + SURVEY_TEMP_PREFIX + sid + '" and trashed = false');
      while (it.hasNext()) {
        const f = it.next();
        if (keepIds.indexOf(f.getId()) === -1 && f.getName().indexOf(SURVEY_TEMP_PREFIX + sid + '-') === 0) f.setTrashed(true);
      }
    } catch (e) { Logger.log('清除暫存檔失敗：' + e); }
  });
}

/** POST action=survey：寫入問卷（照片已由網頁上傳到雲端硬碟，這裡只收檔案 ID） */
function submitSurvey_(d) {
  const session = String(d.session || '').trim();
  if (!SURVEY_SHEETS[session]) return { ok: false, error: 'invalid', message: '梯次不正確' };
  const submissionId = String(d.submissionId || '').trim();
  if (!validSid_(submissionId)) return { ok: false, error: 'invalid', message: '送出代碼不正確，請重新整理頁面後再送出。' };
  const empId = normalizeId(d.empId);
  if (!empId) return { ok: false, error: 'invalid', message: '請填寫人事號' };
  const answers = Array.isArray(d.answers) ? d.answers.map(Number) : [];
  if (answers.length !== SURVEY_QUESTIONS.length || answers.some(a => !(a >= 1 && a <= 5 && Math.floor(a) === a))) {
    return { ok: false, error: 'invalid', message: '請完成全部 ' + SURVEY_QUESTIONS.length + ' 題（每題 1～5 分）。' };
  }
  const story = txt_(d.story);
  if (story.length < SURVEY_STORY_MIN) return { ok: false, error: 'invalid', message: '最感動的一段話請至少寫 ' + SURVEY_STORY_MIN + ' 個字。' };
  if (story.length > SURVEY_STORY_MAX) return { ok: false, error: 'invalid', message: '最感動的一段話請在 ' + SURVEY_STORY_MAX + ' 字以內。' };
  const suggestion = txt_(d.suggestion);                   // 選填
  if (suggestion.length > SURVEY_SUGGEST_MAX) return { ok: false, error: 'invalid', message: '其他建議或回饋請在 ' + SURVEY_SUGGEST_MAX + ' 字以內。' };
  const photoId = String(d.photoFileId || '').trim();
  const socialId = String(d.socialFileId || '').trim();
  if (!photoId) return { ok: false, error: 'invalid', message: '請上傳活動照。' };

  // 以人事號重新查總表（不採信網頁送來的姓名、單位等）
  const found = findRegistration_(session, empId, registrationList_(true));
  if (!found.record) {
    return {
      ok: false, error: 'notfound', otherSessions: found.otherSessions,
      message: found.otherSessions.length
        ? '您報名的是' + found.otherSessions.join('、') + '，請填寫該梯次的問卷。'
        : '查無此人事號的' + session + '報名資料，請確認人事號，或洽教學部（分機 57440）。'
    };
  }
  const reg = found.record;

  const sheet = surveySheet_(session);
  const entries0 = surveyEntries_(sheet);
  const done = entries0.find(x => x.id === submissionId);
  if (done) return { ok: true, submitted: true, no: done.no, name: reg.name, social: !!socialId, repeated: true };
  const prior = entries0.find(x => x.empId === reg.empId);
  if (prior) { trashSurveyTemps_(session, submissionId, []); return surveyDuplicate_(session, prior); }

  let photo, social = null;
  try {
    photo = surveyUploadedFile_(photoId, session, 'photo', submissionId);
    if (socialId) social = surveyUploadedFile_(socialId, session, 'social', submissionId);
  } catch (err) {
    return { ok: false, error: 'reupload', kind: err.reupload || 'photo', message: err.message };
  }

  try {
    // 鎖定：決定編號 → 檔案改名 → 寫入一列（照片已在雲端硬碟，鎖定時間很短）
    const lock = LockService.getScriptLock();
    if (!lock.tryLock(30000)) return { ok: false, error: 'busy', message: '目前填寫人數較多，系統忙碌中，請稍候再送出一次。' };
    let no, photoName, socialName = '';
    try {
      const entries = surveyEntries_(sheet);
      const again = entries.find(x => x.id === submissionId);
      if (again) return { ok: true, submitted: true, no: again.no, name: reg.name, social: !!social, repeated: true };
      // 同一人幾乎同時送出兩份（例如兩支手機）：鎖定內再檢查一次
      const priorNow = entries.find(x => x.empId === reg.empId);
      if (priorNow) {
        [photo, social].forEach(f => { if (f) try { f.file.setTrashed(true); } catch (e) {} });
        return surveyDuplicate_(session, priorNow);
      }
      no = entries.reduce((m, x) => Math.max(m, x.no), 0) + 1;
      const base = no + '-' + session + '-' + safeFileName_(reg.name);
      photoName = base + '.' + photo.ext;
      photo.file.setName(photoName);
      if (social) { socialName = base + '.' + social.ext; social.file.setName(socialName); }

      const headers = surveyHeaders_(sheet);
      const values = {
        '編號': no, '填寫時間': new Date(), '梯次': session, '身分': reg.identity, '單位': reg.unit,
        '姓名': reg.name, '人事號': reg.empId, '職稱': reg.title,
        '其他建議或回饋': '', '最感動的一段話': '', '活動照': '', '社群媒體截圖': '', '送出代碼': submissionId
      };
      SURVEY_QUESTIONS.forEach((q, i) => { values[q] = answers[i]; });
      const r = sheet.getLastRow() + 1;
      writeRowAt_(sheet, r, headers.map(h => values[h] === undefined ? '' : values[h]), headers, SURVEY_TEXT_COLS, '填寫時間');
      // 文字與連結以 RichText 寫入：內容不會被當成公式（例如以「=」開頭），連結欄顯示檔名、點了開啟檔案
      const rich = (text, url) => {
        const b = SpreadsheetApp.newRichTextValue().setText(text);
        return (url ? b.setLinkUrl(url) : b).build();
      };
      sheet.getRange(r, headers.indexOf('最感動的一段話') + 1).setRichTextValue(rich(story));
      if (suggestion) sheet.getRange(r, headers.indexOf('其他建議或回饋') + 1).setRichTextValue(rich(suggestion));
      sheet.getRange(r, headers.indexOf('活動照') + 1).setRichTextValue(rich(photoName, photo.file.getUrl()));
      if (social) sheet.getRange(r, headers.indexOf('社群媒體截圖') + 1).setRichTextValue(rich(socialName, social.file.getUrl()));
      SpreadsheetApp.flush();
    } finally {
      lock.releaseLock();
    }
    trashSurveyTemps_(session, submissionId, [photoId, socialId].filter(Boolean));
    scheduleBackgroundJob_();                          // 約 1 分鐘內更新公開名單的「已填寫編號」
    return { ok: true, submitted: true, no: no, name: reg.name, social: !!social };
  } catch (err) {
    // 不刪除已上傳的照片：網頁重送時會沿用同一組檔案 ID
    return { ok: false, error: 'server', message: '送出失敗，請稍後再試一次（' + (err && err.message ? err.message : err) + '）。' };
  }
}

/** 選單：建立三個活動滿意度調查分頁，檢查六個雲端硬碟資料夾，並實際測試一次可續傳上傳 */
function setupSurvey() {
  const lines = [];
  SESSIONS.forEach(s => {
    ensureSurveySheet_(s);
    lines.push('✔ 分頁「' + SURVEY_SHEETS[s] + '」');
    Object.keys(SURVEY_KINDS).forEach(k => {
      try {
        const folder = DriveApp.getFolderById(SURVEY_FOLDERS[s][k]);
        lines.push('　✔ ' + s + SURVEY_KINDS[k] + '資料夾：' + folder.getName());
      } catch (err) {
        lines.push('　✘ ' + s + SURVEY_KINDS[k] + '資料夾無法存取（' + SURVEY_FOLDERS[s][k] + '）：請確認執行 Apps Script 的帳號有此資料夾的編輯權限');
      }
    });
  });
  lines.push('');
  lines.push(testResumableUpload_());
  SpreadsheetApp.flush();
  SpreadsheetApp.getUi().alert('活動滿意度調查設定\n\n' + lines.join('\n'));
}

/** 以 Drive API 可續傳上傳一個 2 個分塊的小測試檔到第一梯次活動照資料夾，成功後丟到垃圾桶 */
function testResumableUpload_() {
  try {
    const total = 512 * 1024 + 10;                    // 第一塊 512 KB（256 KB 的倍數）＋ 第二塊 10 bytes
    const init = UrlFetchApp.fetch(DRIVE_UPLOAD_API, {
      method: 'post', contentType: 'application/json; charset=UTF-8',
      payload: JSON.stringify({ name: '上傳測試（可刪除）.bin', parents: [SURVEY_FOLDERS[SESSIONS[0]].photo] }),
      headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken(), 'X-Upload-Content-Length': String(total) },
      muteHttpExceptions: true
    });
    if (init.getResponseCode() !== 200) {
      const body = init.getContentText();
      const hint = /has not been used|is disabled|accessNotConfigured/i.test(body)
        ? '請在 Apps Script 編輯器左側「服務」按 ＋ 加入「Drive API」後再試一次。' : body.slice(0, 200);
      return '✘ 可續傳上傳測試失敗（申請上傳網址 HTTP ' + init.getResponseCode() + '）：' + hint;
    }
    const url = String(header_(init, 'Location'));
    const bytes = new Array(total).fill(65);
    const put = (from, to) => UrlFetchApp.fetch(url, {
      method: 'put', payload: Utilities.newBlob(bytes.slice(from, to + 1), 'application/octet-stream'),
      headers: { 'Content-Range': 'bytes ' + from + '-' + to + '/' + total }, muteHttpExceptions: true, followRedirects: false
    });
    const r1 = driveUploadResult_(put(0, 512 * 1024 - 1));
    if (r1.status !== 308 || r1.next !== 512 * 1024) return '✘ 可續傳上傳測試失敗（第一個分塊回應 ' + r1.status + '）';
    const r2 = driveUploadResult_(put(512 * 1024, total - 1));
    if (!r2.done || !r2.fileId) return '✘ 可續傳上傳測試失敗（最後一個分塊回應 ' + r2.status + '）';
    DriveApp.getFileById(r2.fileId).setTrashed(true);
    return '✔ Drive API 可續傳上傳（分塊）測試成功';
  } catch (err) {
    return '✘ 可續傳上傳測試失敗：' + (err && err.message ? err.message : err);
  }
}

/** 選單：清除超過 1 天、沒有完成送出的暫存照片（檔名「上傳中-」開頭） */
function cleanupSurveyUploads() {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  let n = 0;
  SESSIONS.forEach(s => Object.keys(SURVEY_KINDS).forEach(k => {
    try {
      const it = DriveApp.getFolderById(SURVEY_FOLDERS[s][k]).searchFiles('title contains "' + SURVEY_TEMP_PREFIX + '" and trashed = false');
      while (it.hasNext()) {
        const f = it.next();
        if (f.getName().indexOf(SURVEY_TEMP_PREFIX) === 0 && f.getDateCreated().getTime() < cutoff) { f.setTrashed(true); n++; }
      }
    } catch (e) { Logger.log(s + SURVEY_KINDS[k] + '：' + e); }
  }));
  SpreadsheetApp.getUi().alert('已將 ' + n + ' 個超過 1 天未完成送出的暫存照片移到垃圾桶。');
}
