using System.Globalization;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Nodes;
using ConsumptionTracker.Core.Models;

namespace ConsumptionTracker.Core.Services;

/// <summary>
/// 解析结果：Records 只含通过完整校验的记录；被拒绝的行在 Issues 里带行号与具体原因（Skipped == Issues.Count）。
/// </summary>
public sealed record ImportResult(List<RecordItem> Records, List<Product> Products, int Skipped)
{
    public List<ImportIssue> Issues { get; init; } = new();
}

/// <summary>
/// JSON 备份：与手机版 BackupFile 兼容（app='consumption-tracker'，version=2）。
/// 记录里同时写 price（元，供手机版读取）与 priceCents（分，桌面版优先使用）。
/// </summary>
public static class BackupService
{
    public const string AppId = "consumption-tracker";
    public const int Version = 2;

    private static readonly JsonSerializerOptions WriteOptions = new()
    {
        WriteIndented = true,
        Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
    };

    public static string BuildJson(IEnumerable<RecordItem> records, IEnumerable<Product> products, DateTimeOffset? exportedAt = null)
    {
        var root = new JsonObject
        {
            ["app"] = AppId,
            ["version"] = Version,
            ["exportedAt"] = (exportedAt ?? DateTimeOffset.UtcNow).UtcDateTime.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", CultureInfo.InvariantCulture),
            ["records"] = new JsonArray(records.Select(ToNode).ToArray()),
            ["products"] = new JsonArray(products.Select(ToNode).ToArray()),
        };
        return root.ToJsonString(WriteOptions);
    }

    private static JsonNode ToNode(RecordItem r) => new JsonObject
    {
        ["id"] = r.Id,
        ["barcode"] = r.Barcode,
        ["name"] = r.Name,
        ["price"] = Money.ToYuan(r.PriceCents),
        ["priceCents"] = r.PriceCents,
        ["quantity"] = r.Quantity,
        ["category"] = r.Category,
        ["note"] = r.Note,
        ["batchId"] = r.BatchId,
        ["batchName"] = r.BatchName,
        ["patient"] = r.Patient,
        ["dosage"] = r.Dosage,
        ["date"] = r.Date,
        ["createdAt"] = r.CreatedAt,
    };

    private static JsonNode ToNode(Product p)
    {
        var o = new JsonObject
        {
            ["barcode"] = p.Barcode,
            ["name"] = p.Name,
            ["category"] = p.Category,
            ["updatedAt"] = p.UpdatedAt,
        };
        if (p.LastPriceCents is { } c)
        {
            o["lastPrice"] = Money.ToYuan(c);
            o["lastPriceCents"] = c;
        }
        return o;
    }

    /// <summary>解析并校验 JSON 备份；非法记录跳过并计数。非备份文件抛 InvalidDataException（中文消息）。</summary>
    public static ImportResult ParseJson(string text)
    {
        JsonNode? root;
        try { root = JsonNode.Parse(text.TrimStart('\uFEFF')); }
        catch (JsonException) { throw new InvalidDataException("文件不是有效的 JSON"); }

        if (root is not JsonObject obj || Str(obj["app"]) != AppId || obj["records"] is not JsonArray recs)
            throw new InvalidDataException("不是本应用导出的备份文件");

        var records = new List<RecordItem>();
        var issues = new List<ImportIssue>();
        var row = 0;
        foreach (var n in recs)
        {
            row++;
            var (r, bad) = ParseRecord(n);
            if (r != null) records.Add(r); else issues.Add(ImportIssue.Json(row, bad!.Value));
        }

        var products = new List<Product>();
        if (obj["products"] is JsonArray ps)
            foreach (var n in ps)
                if (n is JsonObject o && ParseProduct(o) is { } p) products.Add(p);

        return new ImportResult(records, products, issues.Count) { Issues = issues };
    }

    private static (RecordItem?, RuleProblem?) ParseRecord(JsonNode? node)
    {
        if (node is not JsonObject o) return (null, new("记录内容无效（不是对象）", "Invalid record (not an object)"));
        long priceCents;
        if (TryNumber(o["priceCents"], out var pc) && pc >= 0)
        {
            if (pc > RecordLimits.MaxPriceCents) return (null, TooBigPrice);
            priceCents = (long)Math.Round(pc, MidpointRounding.AwayFromZero);
        }
        else if (TryNumber(o["price"], out var py) && py >= 0)
        {
            if (py > 10_000_000_000m) return (null, TooBigPrice);   // 远超上限，同时避免 ×100 溢出
            priceCents = Money.ToCents(py);
        }
        else if (TryNumber(o["priceCents"], out _) || TryNumber(o["price"], out _))
            return (null, new("价格不能为负数", "Price cannot be negative"));
        else return (null, new("缺少有效的价格（priceCents 或 price）", "Missing or invalid price (priceCents or price)"));
        if (!TryNumber(o["quantity"], out var qty)) return (null, new("缺少有效的数量", "Missing or invalid quantity"));

        var raw = new RecordItem
        {
            Id = Str(o["id"]),
            Barcode = Str(o["barcode"]),
            Name = Str(o["name"]),
            PriceCents = priceCents,
            Quantity = qty,
            Category = Str(o["category"]),
            Note = Str(o["note"]),
            BatchId = Str(o["batchId"]),
            BatchName = Str(o["batchName"]),
            Patient = Str(o["patient"]),
            Dosage = Str(o["dosage"]),
            Date = Str(o["date"]),
            CreatedAt = TryNumber(o["createdAt"], out var ca) && Math.Abs(ca) < 9e18m ? (long)ca : DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
        };
        var clean = RecordValidator.SanitizeChecked(raw, out var problems);
        return clean != null ? (clean, null) : (null, RecordValidator.Join(problems));
    }

    private static readonly RuleProblem TooBigPrice = new("价格过大（最多 10 亿元）", "Price too large (max 1,000,000,000 yuan)");

    private static Product? ParseProduct(JsonObject o)
    {
        var barcode = Str(o["barcode"]).Trim();
        if (barcode == "") return null;
        long? last = null;
        if (TryNumber(o["lastPriceCents"], out var lc) && lc >= 0) last = (long)Math.Round(lc, MidpointRounding.AwayFromZero);
        else if (TryNumber(o["lastPrice"], out var ly) && ly >= 0) last = Money.ToCents(ly);
        return new Product
        {
            Barcode = barcode,
            Name = Str(o["name"]).Trim(),
            Category = Str(o["category"]).Trim(),
            LastPriceCents = last,
            UpdatedAt = TryNumber(o["updatedAt"], out var u) && Math.Abs(u) < 9e18m ? (long)u : DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
        };
    }

    internal static string Str(JsonNode? n)
    {
        if (n is null) return "";
        if (n is JsonValue v)
        {
            if (v.TryGetValue<string>(out var s)) return s;
            return v.ToString();
        }
        return "";
    }

    internal static bool TryNumber(JsonNode? n, out decimal value)
    {
        value = 0;
        if (n is not JsonValue v) return false;
        if (v.TryGetValue<decimal>(out value)) return true;
        if (v.TryGetValue<double>(out var d) && double.IsFinite(d))
        {
            // 超出 decimal 范围时取饱和值（后续按「过大/为负」给出具体原因，而不是抛 OverflowException）
            value = d >= (double)decimal.MaxValue ? decimal.MaxValue : d <= (double)decimal.MinValue ? decimal.MinValue : (decimal)d;
            return true;
        }
        if (v.TryGetValue<string>(out var s))
            return decimal.TryParse(s, NumberStyles.Float, CultureInfo.InvariantCulture, out value);
        return false;
    }
}
