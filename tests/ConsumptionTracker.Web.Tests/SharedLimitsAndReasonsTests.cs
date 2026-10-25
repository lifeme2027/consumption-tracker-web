using System.Text.Json;
using ConsumptionTracker.Core.Models;
using ConsumptionTracker.Core.Services;

namespace ConsumptionTracker.Web.Tests;

// 注意：本文件与桌面版仓库中的同名测试保持一致（Core 与 shared-vectors 共用）
/// <summary>
/// I-02 / I-03：Core JSON 导入的数量与 priceCents 上限的专门测试；
/// shared-vectors/limits.json 真正被加载并与 Core 常量逐项对照；
/// shared-vectors/reasons.json（中英文原因对照）与 Core 实际产生的原因一致。
/// </summary>
public class SharedLimitsAndReasonsTests
{
    private const string Head = "{\"app\":\"consumption-tracker\",\"version\":2,\"records\":[";
    private static string Rec(string price, string qty, string extra = "") =>
        $"{{\"name\":\"测试\",\"priceCents\":{price},\"quantity\":{qty},\"date\":\"2026-10-01\"{extra}}}";
    private static ImportResult Json(string rec) => BackupService.ParseJson(Head + rec + "]}");

    private static JsonElement Vector(string file)
    {
        var path = Path.Combine(AppContext.BaseDirectory, "shared-vectors", file);
        return JsonDocument.Parse(File.ReadAllText(path)).RootElement.Clone();
    }

    // ---------- limits.json ----------

    [Fact]
    public void LimitsJson_IsLoaded_AndEqualsCoreConstants()
    {
        var lim = Vector("limits.json");
        Assert.Equal(RecordLimits.MaxName, lim.GetProperty("name").GetInt32());
        Assert.Equal(RecordLimits.MaxNote, lim.GetProperty("note").GetInt32());
        Assert.Equal(RecordLimits.MaxBarcode, lim.GetProperty("barcode").GetInt32());
        Assert.Equal(RecordLimits.MaxBatchName, lim.GetProperty("batch").GetInt32());
        Assert.Equal(RecordLimits.MaxPatient, lim.GetProperty("patient").GetInt32());
        Assert.Equal(RecordLimits.MaxDosage, lim.GetProperty("dosage").GetInt32());
        Assert.Equal(RecordLimits.MaxQuantity, lim.GetProperty("quantityMax").GetDecimal());
        Assert.Equal(Money.MaxQuantityDecimals, lim.GetProperty("quantityDecimals").GetInt32());
        Assert.Equal(RecordLimits.MaxPriceCents, lim.GetProperty("priceCentsMax").GetInt64());
    }

    [Theory]
    [InlineData("name")]
    [InlineData("note")]
    [InlineData("barcode")]
    [InlineData("batch")]
    [InlineData("patient")]
    [InlineData("dosage")]
    public void LimitsJson_TextFields_ExactlyAtLimitAccepted_OneMoreRejected(string key)
    {
        var max = Vector("limits.json").GetProperty(key).GetInt32();
        string Field(int n) => key switch
        {
            "name" => $"\"name\":\"{new string('名', n)}\"",
            "batch" => $"\"name\":\"测试\",\"batchId\":\"b1\",\"batchName\":\"{new string('批', n)}\"",
            _ => $"\"name\":\"测试\",\"{key}\":\"{new string('x', n)}\"",
        };
        string Rec2(int n) => $"{{{Field(n)},\"priceCents\":100,\"quantity\":1,\"date\":\"2026-10-01\"}}";
        Assert.Single(Json(Rec2(max)).Records);
        var over = Json(Rec2(max + 1));
        Assert.Empty(over.Records);
        Assert.Single(over.Issues);
    }

    [Theory]
    [InlineData("note")]
    [InlineData("barcode")]
    [InlineData("batch")]
    [InlineData("patient")]
    [InlineData("dosage")]
    [InlineData("name")]
    public void LimitsJson_EntryForm_RecordDraft_IsBoundedByTheSameLimits(string key)
    {
        var max = Vector("limits.json").GetProperty(key).GetInt32();
        RecordDraft Draft(int n)
        {
            var d = new RecordDraft { Name = "n", PriceText = "1", QuantityText = "1", Date = "2026-10-01" };
            var v = new string('x', n);
            switch (key)
            {
                case "note": d.Note = v; break;
                case "barcode": d.Barcode = v; break;
                case "batch": d.BatchName = v; break;
                case "patient": d.Patient = v; break;
                case "dosage": d.Dosage = v; break;
                default: d.Name = v; break;
            }
            return d;
        }
        Assert.True(Draft(max).TryBuild(out _, out _));
        Assert.False(Draft(max + 1).TryBuild(out var rec, out var errors));
        Assert.Null(rec);
        Assert.NotEmpty(errors);
    }

    // ---------- I-03：priceCents 上限（1e11 分 = 10 亿元） ----------

    [Theory]
    [InlineData("0", true)]
    [InlineData("100000000000", true)]
    [InlineData("100000000001", false)]
    [InlineData("1000000000000000", false)]   // 一致性测试 j20：1e15 分
    [InlineData("9223372036854775807", false)]
    [InlineData("-1", false)]
    public void Json_PriceCents_Limit(string cents, bool ok)
    {
        var r = Json(Rec(cents, "1"));
        Assert.Equal(ok ? 1 : 0, r.Records.Count);
        if (!ok) Assert.Contains(r.Issues[0].Reason, new[] { "价格过大（最多 10 亿元）", "价格不能为负数" });
    }

    [Fact]
    public void Json_PriceYuanField_UsesSameCap()
    {
        Assert.Single(BackupService.ParseJson(Head + "{\"name\":\"a\",\"price\":1000000000,\"quantity\":1,\"date\":\"2026-10-01\"}]}").Records);
        Assert.Empty(BackupService.ParseJson(Head + "{\"name\":\"a\",\"price\":1000000000.01,\"quantity\":1,\"date\":\"2026-10-01\"}]}").Records);
    }

    // ---------- I-02：数量（>0、≤6 位小数、≤1,000,000）与 shared-vectors/quantity.json 同一规则 ----------

    [Theory]
    [InlineData("0.000001", true)]
    [InlineData("1000000", true)]
    [InlineData("2.5", true)]
    [InlineData("0", false)]
    [InlineData("-1", false)]
    [InlineData("0.0000001", false)]          // 7 位小数（j22）
    [InlineData("1.1234567", false)]
    [InlineData("1000000.000001", false)]
    [InlineData("1000001", false)]
    [InlineData("10000000", false)]           // j23
    public void Json_Quantity_UnifiedRule(string qty, bool ok)
    {
        var r = Json(Rec("100", qty));
        Assert.Equal(ok ? 1 : 0, r.Records.Count);
        Assert.Equal(ok ? 0 : 1, r.Issues.Count);
    }

    [Fact]
    public void QuantityVectors_AgreeWithJsonImport()
    {
        foreach (var e in Vector("quantity.json").EnumerateArray())
        {
            var input = e.GetProperty("input").GetString()!;
            var expected = e.GetProperty("quantity");
            // 只比较合法的 JSON 数字语法（"007"、".5"、"1,5"、"1e3" 等不是 JSON 数字，无法作为 JSON 数值出现）
            if (!System.Text.RegularExpressions.Regex.IsMatch(input, @"^(0|[1-9][0-9]*)(\.[0-9]+)?$")) continue;
            var r = Json(Rec("100", input));
            Assert.True((expected.ValueKind != JsonValueKind.Null) == (r.Records.Count == 1), $"quantity.json 输入 {input}");
        }
    }

    // ---------- 导入文件整体不可用：中英文具体原因 ----------

    [Fact]
    public void FormatErrors_AreSpecific_AndBilingual()
    {
        var a = Assert.Throws<InvalidDataException>(() => BackupService.ParseJson("{ nope"));
        Assert.Equal("文件不是有效的 JSON", a.Message); Assert.Equal("The file is not valid JSON", ImportFormat.English(a));
        var b = Assert.Throws<InvalidDataException>(() => BackupService.ParseJson("{\"x\":1}"));
        Assert.Contains("不是本应用导出的备份文件", b.Message); Assert.Contains("not a backup file", ImportFormat.English(b));
        var c = Assert.Throws<InvalidDataException>(() => CsvService.Parse("日期,商品名\n2026-01-01,a"));
        Assert.Contains("缺少必需列", c.Message); Assert.Contains("missing required columns", ImportFormat.English(c));
        var d = Assert.Throws<InvalidDataException>(() => CsvService.Parse(""));
        Assert.Contains("为空", d.Message); Assert.Contains("empty", ImportFormat.English(d));
        Assert.Null(ImportFormat.English(new InvalidDataException("x")));
    }

    // ---------- reasons.json ----------

    private static IEnumerable<(string Zh, string En)> CorePairs()
    {
        string B(int n) => new string('x', n);
        var recs = new List<string>
        {
            "123",
            "{\"name\":\"a\",\"priceCents\":-1,\"quantity\":1,\"date\":\"2026-10-01\"}",
            "{\"name\":\"a\",\"quantity\":1,\"date\":\"2026-10-01\"}",
            "{\"name\":\"a\",\"priceCents\":1,\"date\":\"2026-10-01\"}",
            Rec("100000000001", "1"),
            "{\"name\":\"\",\"priceCents\":1,\"quantity\":1,\"date\":\"2026-10-01\"}",
            Rec("1", "0"),
            "{\"name\":\"a\",\"priceCents\":1,\"quantity\":1,\"date\":\"x\"}",
            Rec("1", "1000001"),
            Rec("1", "0.0000001"),
            Rec("1", "1", $",\"id\":\"{B(65)}\""),
            Rec("1", "1", $",\"barcode\":\"{B(65)}\""),
            $"{{\"name\":\"{B(101)}\",\"priceCents\":1,\"quantity\":1,\"date\":\"2026-10-01\"}}",
            Rec("1", "1", $",\"category\":\"{B(31)}\""),
            Rec("1", "1", $",\"note\":\"{B(1001)}\""),
            Rec("1", "1", $",\"batchId\":\"b\",\"batchName\":\"{B(61)}\""),
            Rec("1", "1", $",\"patient\":\"{B(41)}\""),
            Rec("1", "1", $",\"dosage\":\"{B(61)}\""),
            "{\"name\":\"a\",\"priceCents\":12.5,\"quantity\":1,\"date\":\"2026-10-01\"}",   // 小数分：不取整
        };
        foreach (var r in recs)
            foreach (var i in Json(r).Issues) yield return (i.Reason, i.ReasonEn);

        // 整个文件级别的版本号 / 空覆盖原因
        foreach (var v in new[] { "", ",\"version\":\"abc\"", ",\"version\":99" })
        {
            var e = Assert.Throws<InvalidDataException>(() => BackupService.ParseJson("{\"app\":\"consumption-tracker\"" + v + ",\"records\":[],\"products\":[]}"));
            yield return (e.Message, ImportFormat.English(e)!);
        }
        yield return (EmptyReplaceException.Reason.Zh, EmptyReplaceException.Reason.En);

        var csv = new[]
        {
            ("", "1"), ("-1", "1"), ("abc", "1"), ("99999999999", "1"), ("1", ""), ("1", "abc"), ("1", "1.1234567"), ("1", "9999999"), ("1", "0"), ("1", "-2"),
        };
        foreach (var (p, q) in csv)
            foreach (var i in CsvService.Parse($"日期,商品名,单价,数量\n2026-10-01,a,{p},{q}\n").Issues)
                yield return (i.Reason, i.ReasonEn);
    }

    [Fact]
    public void ReasonsJson_ContainsEveryPairCoreProduces_AndIsWellFormed()
    {
        var vec = Vector("reasons.json").EnumerateArray()
            .Select(e => (Zh: e.GetProperty("zh").GetString()!, En: e.GetProperty("en").GetString()!)).ToList();
        Assert.Equal(vec.Count, vec.Select(v => v.Zh).Distinct().Count());   // zh 唯一
        Assert.All(vec, v => { Assert.NotEmpty(v.En); Assert.DoesNotContain(v.En, v.Zh); });
        var seen = CorePairs().Distinct().ToList();
        Assert.True(seen.Count >= 20, "覆盖的原因种类过少：" + seen.Count);
        foreach (var p in seen)
            Assert.True(vec.Contains(p), $"reasons.json 缺少：{p.Zh} / {p.En}");
    }
}
