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

    public static string ToCsv(IEnumerable<RecordItem> records)
    {
        var sorted = records.OrderBy(r => r.Date, StringComparer.Ordinal).ThenBy(r => r.CreatedAt);
        var sb = new StringBuilder("\uFEFF");
        sb.Append(string.Join(",", Header.Select(Escape))).Append("\r\n");
        foreach (var r in sorted)
        {
            string[] cols =
            {
                r.Date, r.Barcode, r.Name, r.Category,
                Yuan(r.PriceCents),
                r.Quantity.ToString("0.####", CultureInfo.InvariantCulture),
                Yuan(r.AmountCents),
                r.BatchName, r.BatchId, r.Patient, r.Dosage, r.Note,
            };
            sb.Append(string.Join(",", cols.Select(Escape))).Append("\r\n");
        }
        return sb.ToString();
    }

    private static string Yuan(long cents) => (cents / 100m).ToString("0.00", CultureInfo.InvariantCulture);

    /// <summary>RFC 4180 解析（支持引号、转义引号、字段内换行、BOM）。</summary>
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
                case '\r': break;
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
        if (rows.Count == 0) throw new InvalidDataException("CSV 文件为空");
        var header = rows[0].Select(h => h.Trim()).ToList();
        int Col(params string[] names) => header.FindIndex(h => names.Contains(h));
        var cDate = Col("日期");
        var cName = Col("商品名", "名称");
        var cPrice = Col("单价", "价格");
        var cQty = Col("数量");
        if (cDate < 0 || cName < 0 || cPrice < 0 || cQty < 0)
            throw new InvalidDataException("CSV 表头缺少必需列：日期、商品名、单价、数量");
        var cBarcode = Col("条码/追溯码", "条码", "编码");
        var cCat = Col("分类");
        var cBatchName = Col("批次/药方", "批次名", "批次");
        var cBatchId = Col("批次ID");
        var cPatient = Col("用药人");
        var cDosage = Col("剂量/规格", "剂量");
        var cNote = Col("备注");

        string Get(List<string> r, int c) => c >= 0 && c < r.Count ? r[c] : "";

        var records = new List<RecordItem>();
        var skipped = 0;
        var seen = new Dictionary<string, int>();
        foreach (var r in rows.Skip(1))
        {
            if (!Money.TryParseYuan(Get(r, cPrice), out var cents) || !Money.TryParseQuantity(Get(r, cQty), out var qty))
            { skipped++; continue; }
            var batchName = Get(r, cBatchName).Trim();
            var batchId = Get(r, cBatchId).Trim();
            if (batchId == "" && batchName != "") batchId = "batch-" + Hash("batch|" + batchName)[..16];
            var draft = new RecordItem
            {
                Id = "",
                Barcode = Get(r, cBarcode),
                Name = Get(r, cName),
                PriceCents = cents,
                Quantity = qty,
                Category = Get(r, cCat),
                Note = Get(r, cNote),
                BatchId = batchId,
                BatchName = batchName,
                Patient = Get(r, cPatient),
                Dosage = Get(r, cDosage),
                Date = Get(r, cDate).Trim(),
            };
            var clean = RecordValidator.Sanitize(draft);
            if (clean == null) { skipped++; continue; }
            var key = string.Join("\u001f", clean.Date, clean.Barcode, clean.Name, clean.PriceCents, clean.Quantity,
                clean.Category, clean.BatchId, clean.Patient, clean.Dosage, clean.Note);
            seen[key] = seen.TryGetValue(key, out var n) ? n + 1 : 0;
            records.Add(clean with { Id = "csv-" + Hash(key + "#" + seen[key])[..32] });
        }
        return new ImportResult(records, new List<Product>(), skipped);
    }

    private static string Hash(string s) =>
        Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(s))).ToLowerInvariant();
}
