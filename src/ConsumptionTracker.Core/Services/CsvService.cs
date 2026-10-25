using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using ConsumptionTracker.Core.Models;

namespace ConsumptionTracker.Core.Services;

/// <summary>
/// CSV 导出/导入。列与手机版一致：
/// 日期,条码/追溯码,商品名,分类,单价,数量,金额,批次/药方,批次ID,用药人,剂量/规格,备注
/// 导出为 UTF-8 BOM + CRLF，Excel/WPS 可直接打开；单价/金额单位为元（两位小数）。
/// </summary>
public static class CsvService
{
    public static readonly string[] Header =
        { "日期", "条码/追溯码", "商品名", "分类", "单价", "数量", "金额", "批次/药方", "批次ID", "用药人", "剂量/规格", "备注" };

    public static string Escape(string v) =>
        v.IndexOfAny(new[] { ',', '"', '\r', '\n' }) >= 0 ? "\"" + v.Replace("\"", "\"\"") + "\"" : v;

    private static bool IsTrigger(char c) => c is '=' or '+' or '-' or '@' or '\t' or '\r';

    /// <summary>
    /// 防 CSV 公式注入（文本列）：若以若干个 ' 之后紧跟 = + - @ \t \r 开头，整体前加一个 '。
    /// 与 <see cref="UnguardText"/> 互逆（'=x 也能无损往返）。数值列不要调用。
    /// </summary>
    public static string GuardText(string v)
    {
        var i = 0;
        while (i < v.Length && v[i] == '\'') i++;
        return i < v.Length && IsTrigger(v[i]) ? "'" + v : v;
    }

    /// <summary>导入还原：仅当「一串 ' 之后紧跟触发字符」时去掉一个前导 '，其余文本（如 it's、'hello）原样保留。</summary>
    public static string UnguardText(string v)
    {
        var i = 0;
        while (i < v.Length && v[i] == '\'') i++;
        return i > 0 && i < v.Length && IsTrigger(v[i]) ? v[1..] : v;
    }

    public static string ToCsv(IEnumerable<RecordItem> records)
    {
        var sorted = records.OrderBy(r => r.Date, StringComparer.Ordinal).ThenBy(r => r.CreatedAt);
        var sb = new StringBuilder("\uFEFF");
        sb.Append(string.Join(",", Header.Select(Escape))).Append("\r\n");
        foreach (var r in sorted)
        {
            // 文本列经 GuardText 防公式注入；单价/数量/金额是数值列，绝不加前缀
            string[] cols =
            {
                GuardText(r.Date), GuardText(r.Barcode), GuardText(r.Name), GuardText(r.Category),
                Yuan(r.PriceCents),
                Money.FormatQuantity(r.Quantity),
                Yuan(r.AmountCents),
                GuardText(r.BatchName), GuardText(r.BatchId), GuardText(r.Patient), GuardText(r.Dosage), GuardText(r.Note),
            };
            sb.Append(string.Join(",", cols.Select(Escape))).Append("\r\n");
        }
        return sb.ToString();
    }

    private static string Yuan(long cents) => (cents / 100m).ToString("0.00", CultureInfo.InvariantCulture);

    /// <summary>RFC 4180 解析（支持引号、转义引号、字段内换行、BOM）。引号内的 \r\n / \r / \n 原样保留；引号外 CRLF、单独 \r、\n 都算换行。</summary>
    public static List<List<string>> ParseRows(string text)
    {
        if (text.Length > 0 && text[0] == '\uFEFF') text = text[1..];
        var rows = new List<List<string>>();
        var row = new List<string>();
        var field = new StringBuilder();
        var inQuotes = false;
        var any = false;
        for (var i = 0; i < text.Length; i++)
        {
            var c = text[i];
            if (inQuotes)
            {
                if (c == '"')
                {
                    if (i + 1 < text.Length && text[i + 1] == '"') { field.Append('"'); i++; }
                    else inQuotes = false;
                }
                else field.Append(c);
                continue;
            }
            switch (c)
            {
                case '"': inQuotes = true; any = true; break;
                case ',': row.Add(field.ToString()); field.Clear(); any = true; break;
                case '\r' when i + 1 < text.Length && text[i + 1] == '\n': break; // CRLF：由随后的 \n 结束本行
                case '\r':   // 单独的 \r（旧 Mac 风格换行）同样结束本行，不再被悄悄丢弃
                case '\n':
                    if (any || field.Length > 0) { row.Add(field.ToString()); rows.Add(row); }
                    row = new List<string>(); field.Clear(); any = false;
                    break;
                default: field.Append(c); any = true; break;
            }
        }
        if (any || field.Length > 0) { row.Add(field.ToString()); rows.Add(row); }
        return rows;
    }

    /// <summary>
    /// 导入 CSV。无 id 的行生成确定性 id（由内容哈希得到），因此对同一文件重复「合并」导入不会产生重复记录。
    /// </summary>
    public static ImportResult Parse(string text)
    {
        var rows = ParseRows(text);
        if (rows.Count == 0) throw ImportFormat.Error("CSV 文件为空", "The CSV file is empty");
        var header = rows[0].Select(h => h.Trim()).ToList();
        int Col(params string[] names) => header.FindIndex(h => names.Contains(h));
        var cDate = Col("日期");
        var cName = Col("商品名", "名称");
        var cPrice = Col("单价", "价格");
        var cQty = Col("数量");
        if (cDate < 0 || cName < 0 || cPrice < 0 || cQty < 0)
            throw ImportFormat.Error("CSV 表头缺少必需列：日期、商品名、单价、数量", "The CSV header is missing required columns: date, name, price, quantity (日期, 商品名, 单价, 数量)");
        var cBarcode = Col("条码/追溯码", "条码", "编码");
        var cCat = Col("分类");
        var cBatchName = Col("批次/药方", "批次名", "批次");
        var cBatchId = Col("批次ID");
        var cPatient = Col("用药人");
        var cDosage = Col("剂量/规格", "剂量");
        var cNote = Col("备注");

        string Get(List<string> r, int c) => c >= 0 && c < r.Count ? r[c] : "";
        string GetText(List<string> r, int c) => UnguardText(Get(r, c));

        var records = new List<RecordItem>();
        var issues = new List<ImportIssue>();
        var seen = new Dictionary<string, int>();
        var rowNo = 1;   // 表头是第 1 行
        foreach (var r in rows.Skip(1))
        {
            rowNo++;
            if (!Money.TryParseYuan(Get(r, cPrice), out var cents) || !Money.TryParseQuantity(Get(r, cQty), out var qty))
            {
                var ps = new List<RuleProblem>();
                if (Money.PriceProblem(Get(r, cPrice)) is { } pp) ps.Add(pp);
                if (Money.QuantityProblem(Get(r, cQty)) is { } qp) ps.Add(qp);
                issues.Add(ImportIssue.Csv(rowNo, RecordValidator.Join(ps)));
                continue;
            }
            var batchName = GetText(r, cBatchName).Trim();
            var batchId = GetText(r, cBatchId).Trim();
            if (batchId == "" && batchName != "") batchId = "batch-" + Hash("batch|" + batchName)[..16];
            var draft = new RecordItem
            {
                Id = "",
                Barcode = GetText(r, cBarcode),
                Name = GetText(r, cName),
                PriceCents = cents,
                Quantity = qty,
                Category = GetText(r, cCat),
                Note = GetText(r, cNote),
                BatchId = batchId,
                BatchName = batchName,
                Patient = GetText(r, cPatient),
                Dosage = GetText(r, cDosage),
                Date = GetText(r, cDate).Trim(),
            };
            var clean = RecordValidator.SanitizeChecked(draft, out var problems);
            if (clean == null) { issues.Add(ImportIssue.Csv(rowNo, RecordValidator.Join(problems))); continue; }
            var key = string.Join("\u001f", clean.Date, clean.Barcode, clean.Name, clean.PriceCents, clean.Quantity,
                clean.Category, clean.BatchId, clean.Patient, clean.Dosage, clean.Note);
            seen[key] = seen.TryGetValue(key, out var n) ? n + 1 : 0;
            records.Add(clean with { Id = "csv-" + Hash(key + "#" + seen[key])[..32] });
        }
        return new ImportResult(records, new List<Product>(), issues.Count) { Issues = issues };
    }

    private static string Hash(string s) =>
        Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(s))).ToLowerInvariant();
}
