using System.Globalization;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Nodes;
using ConsumptionTracker.Core.Models;

namespace ConsumptionTracker.Core.Services;

public sealed record ImportResult(List<RecordItem> Records, List<Product> Products, int Skipped);

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
        var skipped = 0;
        foreach (var n in recs)
        {
            var r = n is JsonObject o ? ParseRecord(o) : null;
            if (r != null) records.Add(r); else skipped++;
        }

        var products = new List<Product>();
        if (obj["products"] is JsonArray ps)
            foreach (var n in ps)
                if (n is JsonObject o && ParseProduct(o) is { } p) products.Add(p);

        return new ImportResult(records, products, skipped);
    }

    private static RecordItem? ParseRecord(JsonObject o)
    {
        long priceCents;
        if (TryNumber(o["priceCents"], out var pc) && pc >= 0) priceCents = (long)Math.Round(pc, MidpointRounding.AwayFromZero);
        else if (TryNumber(o["price"], out var py) && py >= 0) priceCents = Money.ToCents(py);
        else return null;
        if (!TryNumber(o["quantity"], out var qty)) return null;

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
            CreatedAt = TryNumber(o["createdAt"], out var ca) ? (long)ca : DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
        };
        return RecordValidator.Sanitize(raw);
    }

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
            UpdatedAt = TryNumber(o["updatedAt"], out var u) ? (long)u : DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
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
        if (v.TryGetValue<double>(out var d) && double.IsFinite(d)) { value = (decimal)d; return true; }
        if (v.TryGetValue<string>(out var s))
            return decimal.TryParse(s, NumberStyles.Float, CultureInfo.InvariantCulture, out value);
        return false;
    }
}
