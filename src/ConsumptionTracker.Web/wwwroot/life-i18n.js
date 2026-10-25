/* 界面语言（中文默认，可切到 English）与导入反馈的中英文文案。
 * 本文件不含任何网络调用，也不碰 DOM：只提供「语言状态 + 纯函数」，由 app.js 负责渲染（测试在 scripts/js-tests/i18n.test.js）。
 * 逐条原因的中英文对照 REASONS 与 shared-vectors/reasons.json 逐项一致（CI 里校验），其中 Core 产生的原因同时由 C# 测试覆盖。
 * 服务端（云端模式）的逐条原因自带 reasonEn/labelEn，优先使用；本地模式的原因由本字典翻译；查不到时退回中文原文。 */
(function (root) {
  'use strict';
  var KEY = 'life.lang';
  var MAX_SHOW = 8;

  var REASONS = {
    "记录内容无效（不是对象）": "Invalid record (not an object)",
    "记录内容无效": "Invalid record",
    "商品名不能为空": "Name is required",
    "价格不能为负数": "Price cannot be negative",
    "价格为空": "Price is empty",
    "价格过大": "Price too large (max 1,000,000,000 yuan)",
    "价格过大（最多 10 亿元）": "Price too large (max 1,000,000,000 yuan)",
    "价格无效（需为不小于 0 的数字，小数请用小数点，如 12.50）": "Invalid price (a number not less than 0; use a decimal point, e.g. 12.50)",
    "缺少有效的价格（priceCents 或 price）": "Missing or invalid price (priceCents or price)",
    "数量为空": "Quantity is empty",
    "数量必须大于 0": "Quantity must be greater than 0",
    "数量过大": "Quantity too large (max 1,000,000)",
    "数量过大（最多 1000000）": "Quantity too large (max 1,000,000)",
    "数量最多 6 位小数": "Quantity allows at most 6 decimal places",
    "数量无效（需大于 0，最多 6 位小数，不超过 1000000）": "Invalid quantity (greater than 0, at most 6 decimal places, not more than 1000000)",
    "缺少有效的数量": "Missing or invalid quantity",
    "日期格式应为 YYYY-MM-DD": "Date must be YYYY-MM-DD",
    "记录 ID 过长": "Record ID too long (max 64 characters)",
    "编码过长": "Barcode too long (max 64 characters)",
    "名称过长（最多 100 字）": "Name too long (max 100 characters)",
    "分类过长": "Category too long (max 30 characters)",
    "备注过长（最多 1000 字）": "Note too long (max 1000 characters)",
    "批次名过长": "Batch name too long (max 60 characters)",
    "用药人过长": "Patient too long (max 40 characters)",
    "剂量/规格过长": "Dosage/spec too long (max 60 characters)",
    "编码过长（最多 64 字）": "Barcode too long (max 64 characters)",
    "批次名过长（最多 60 字）": "Batch name too long (max 60 characters)",
    "用药人过长（最多 40 字）": "Patient too long (max 40 characters)",
    "剂量/规格过长（最多 60 字）": "Dosage/spec too long (max 60 characters)",
    "备份文件的版本号无效（version 必须是整数 1 或 2）": "The backup file's version is invalid (version must be the integer 1 or 2)",
    "备份文件的版本高于本应用支持的版本（最高 2），请先升级应用后再导入": "This backup was made by a newer version of the app (this app supports up to version 2); please upgrade the app and import again",
    "价格（priceCents）必须是整数分，不能有小数": "priceCents must be a whole number of cents (no decimals)",
    "文件中没有任何记录，覆盖导入不能用来清空数据，已拒绝（现有数据没有任何改动）": "The file contains no records; a replace-import cannot be used to clear data, so it was rejected (your existing data was not changed)"
  };

  // 整条消息（本地模式抛出的、或客户端自己产生的错误）；带数字的用下面的正则规则
  var MESSAGES = {
    '文件不是有效的 JSON': 'The file is not valid JSON',
    '不是本应用导出的备份文件': 'This is not a backup file exported by this app',
    'CSV 文件为空': 'The CSV file is empty',
    'CSV 表头缺少必需列：日期、商品名、单价、数量': 'The CSV header is missing required columns: date, name, price, quantity (日期, 商品名, 单价, 数量)',
    '网络错误，请稍后重试': 'Network error, please try again later',
    '此浏览器不支持本地存储（IndexedDB）': 'This browser does not support local storage (IndexedDB)',
    '本地有不合格记录': 'Some local records are invalid',
    '记录不存在': 'Record not found',
    '内容为空': 'The content is empty',
    '文件过大': 'The file is too large',
  };
  var MESSAGE_RULES = [
    [/^请求失败（(\d+)）$/, 'Request failed ($1)'],
    [/^导入后记录数将超过上限（(\d+) 条），已取消$/, 'The record count would exceed the limit of $1 after import; cancelled'],
    [/^记录数已达上限（(\d+) 条）$/, 'The record limit has been reached ($1 records)'],
  ];

  var mem = null;
  function getStored() { try { return root.localStorage ? root.localStorage.getItem(KEY) : mem; } catch (e) { return mem; } }
  function putStored(v) { mem = v; try { if (root.localStorage) root.localStorage.setItem(KEY, v); } catch (e) { /* 隐私模式下忽略，仅本页有效 */ } }
  function lang() { return getStored() === 'en' ? 'en' : 'zh'; }
  function setLang(l) { putStored(l === 'en' ? 'en' : 'zh'); return lang(); }
  function t(zh, en, l) { return (l || lang()) === 'en' ? en : zh; }

  /** 中文原因 → 英文；多个原因用「；」连接时逐个翻译。查不到的部分保留中文原文。 */
  function translateReason(zh) {
    if (zh == null) return '';
    var s = String(zh);
    if (Object.prototype.hasOwnProperty.call(REASONS, s)) return REASONS[s];
    return s.split('；').map(function (p) { return Object.prototype.hasOwnProperty.call(REASONS, p) ? REASONS[p] : p; }).join('; ');
  }
  function translateLabel(zh) {
    var m = /^第 (\d+) 条$/.exec(zh || ''); if (m) return 'Record #' + m[1];
    m = /^第 (\d+) 行$/.exec(zh || ''); if (m) return 'Row ' + m[1];
    return zh || '';
  }
  function translateMessage(zh) {
    if (zh == null) return '';
    var s = String(zh);
    if (Object.prototype.hasOwnProperty.call(MESSAGES, s)) return MESSAGES[s];
    if (Object.prototype.hasOwnProperty.call(REASONS, s)) return REASONS[s];
    for (var i = 0; i < MESSAGE_RULES.length; i++) if (MESSAGE_RULES[i][0].test(s)) return s.replace(MESSAGE_RULES[i][0], MESSAGE_RULES[i][1]);
    return s;
  }
  /** 错误对象的文字：中文用 e.message；英文优先 e.messageEn（服务端 errorEn / 本地显式给出），否则查字典。 */
  function errorText(e, l) {
    var zh = (e && e.message) || '';
    if ((l || lang()) !== 'en') return zh;
    return (e && e.messageEn) || translateMessage(zh);
  }
  function rowLine(x, l) {
    if ((l || lang()) === 'en') return (x.labelEn || translateLabel(x.label || ('第 ' + x.row + ' 条'))) + ': ' + (x.reasonEn || translateReason(x.reason));
    return (x.label || ('第 ' + x.row + ' 条')) + '：' + x.reason;
  }
  /** 问题清单：{head, items, more}；rows 为空返回 null。count 为总数（服务端只回传前若干条）。 */
  function problemList(zhHead, enHead, rows, count, l) {
    if (!rows || !rows.length) return null;
    var all = count != null ? count : rows.length;
    var items = rows.slice(0, MAX_SHOW).map(function (x) { return rowLine(x, l); });
    var more = all > MAX_SHOW ? t('……另有 ' + (all - MAX_SHOW) + ' 条未列出（共 ' + all + ' 条）', '… and ' + (all - MAX_SHOW) + ' more not shown (' + all + ' in total)', l) : null;
    return { head: t(zhHead, enHead, l), items: items, more: more };
  }
  /** 导入/上传/下载失败：{msg, list}。有逐条原因 = 整体中止（没改动任何数据）。 */
  function failureView(e, l) {
    var rows = e && e.rejected;
    if (rows && rows.length) {
      var n = e.rejectedCount != null ? e.rejectedCount : rows.length;
      var hasTotal = e.total != null;
      return {
        msg: t('导入已中止：' + (hasTotal ? '共 ' + e.total + ' 条中有 ' : '') + n + ' 条不合格，现有数据没有任何改动。',
          'Import aborted: ' + (hasTotal ? n + ' of ' + e.total + ' records are invalid' : n + ' records are invalid') + '; your existing data was not changed.', l),
        list: problemList('不合格的记录（共 ' + n + ' 条，下面最多列出前 ' + MAX_SHOW + ' 条）',
          'Invalid records (' + n + ' in total; at most the first ' + MAX_SHOW + ' are listed below)', rows, n, l),
      };
    }
    return { msg: errorText(e, l), list: null };
  }
  var PREFIX = { import: ['导入完成', 'Import complete'], upload: ['上传完成', 'Upload complete'], download: ['下载完成', 'Download complete'] };
  /** 成功：{msg, list}；list 为被跳过的记录。kind: import | upload | download */
  function resultView(kind, r, l) {
    var p = PREFIX[kind] || PREFIX.import;
    return {
      msg: t(p[0] + '：新增 ' + r.added + '，更新 ' + r.updated + '，跳过 ' + r.skipped,
        p[1] + ': added ' + r.added + ', updated ' + r.updated + ', skipped ' + r.skipped, l),
      list: problemList('被跳过的记录（共 ' + r.skipped + ' 条，下面最多列出前 ' + MAX_SHOW + ' 条）',
        'Skipped records (' + r.skipped + ' in total; at most the first ' + MAX_SHOW + ' are listed below)', r.skippedRows, r.skipped, l),
    };
  }

  var api = {
    REASONS: REASONS, MAX_SHOW: MAX_SHOW, lang: lang, setLang: setLang, t: t,
    translateReason: translateReason, translateLabel: translateLabel, translateMessage: translateMessage, errorText: errorText,
    failureView: failureView, resultView: resultView,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.LifeI18n = api;
})(typeof window !== 'undefined' ? window : globalThis);
