using System.Text.Json;
using ConsumptionTracker.Core.Models;
using ConsumptionTracker.Core.Services;
using System.Net;
using System.Text;

namespace ConsumptionTracker.Web.Tests;

/// <summary>CSV 防公式注入：规则与向量见 shared-vectors/README.md、csv-text.json。</summary>
public class CsvInjectionTests : IDisposable
{
    private readonly TestApp _app = new();
    public void Dispose() => _app.Dispose();

    private static RecordItem Rec(string name, long priceCents, decimal qty, string date, string category = "食品",
        string barcode = "", string batchName = "", string patient = "", string dosage = "", string note = "", string id = "x") => new()
    {
        Id = id, Name = name, PriceCents = priceCents, Quantity = qty, Date = date, Category = category,
        Barcode = barcode, BatchId = batchName == "" ? "" : "b1", BatchName = batchName, Patient = patient, Dosage = dosage, Note = note, CreatedAt = 1,
    };

    public static IEnumerable<object[]> Vectors()
    {
        var path = Path.Combine(AppContext.BaseDirectory, "shared-vectors", "csv-text.json");
        using var doc = JsonDocument.Parse(File.ReadAllText(path));
        foreach (var e in doc.RootElement.EnumerateArray())
            yield return new object[] { e.GetProperty("text").GetString()!, e.GetProperty("cell").GetString()! };
    }

    [Theory]
    [MemberData(nameof(Vectors))]
    public void GuardText_And_UnguardText_FollowSharedVectors(string text, string cell)
    {
        Assert.Equal(cell, CsvService.GuardText(text));
        Assert.Equal(text, CsvService.UnguardText(cell));
    }

    [Fact]
    public void SharedVectorFile_IsLoaded() => Assert.True(Vectors().Count() >= 20);

    [Theory]
    [MemberData(nameof(Vectors))]
    public void FullRoundTrip_ThroughCsv_TextColumnsAreLossless(string text, string _)
    {
        // 备注列不会被 Trim，可原样往返；其余文本列与之同一路径
        var rec = Rec("商品", 100, 1, "2026-10-05", note: text, id: "x");
        var back = CsvService.Parse(CsvService.ToCsv(new[] { rec }));
        var r = Assert.Single(back.Records);
        Assert.Equal(text, r.Note);
    }

    [Theory]
    [InlineData("=1+1")]
    [InlineData("+cmd|' /C calc'!A0")]
    [InlineData("-2+3")]
    [InlineData("@SUM(1+1)")]
    [InlineData("=HYPERLINK(\"http://evil\",\"x\")")]
    [InlineData("'=x")]
    public void AllTextColumns_RoundTrip_AndExportNeverStartsWithTrigger(string evil)
    {
        var rec = Rec(evil, 2350, 2, "2026-10-05", evil, evil, evil, evil, evil, evil, "id1");
        var csv = CsvService.ToCsv(new[] { rec });
        foreach (var row in CsvService.ParseRows(csv).Skip(1))
            foreach (var cell in row)
                Assert.False(cell.Length > 0 && "=+-@\t\r".Contains(cell[0]), $"导出单元格以触发字符开头: {cell}");

        var back = Assert.Single(CsvService.Parse(csv).Records);
        Assert.Equal(evil, back.Name);
        Assert.Equal(evil, back.Barcode);
        Assert.Equal(evil, back.Category);
        Assert.Equal(evil, back.BatchName);
        Assert.Equal(evil, back.Patient);
        Assert.Equal(evil, back.Dosage);
        Assert.Equal(evil, back.Note);
        Assert.Equal(2350, back.PriceCents);
        Assert.Equal(2m, back.Quantity);
    }

    [Fact]
    public void NumericColumns_NeverPrefixed()
    {
        var recs = new[]
        {
            Rec("a", 0, 1, "2026-10-05"), Rec("b", 99999999999, 999999.999999m, "2026-10-05"),
            Rec("c", 5, 0.000001m, "2026-10-05"),
        };
        var rows = CsvService.ParseRows(CsvService.ToCsv(recs)).Skip(1).ToList();
        Assert.Equal(3, rows.Count);
        foreach (var row in rows)
            foreach (var col in new[] { 4, 5, 6 })
                Assert.Matches("^[0-9]", row[col]);
    }

    [Fact]
    public void Import_StripsOnlyPrefixedTriggerCells()
    {
        // 外部（或旧版导出的）文件：'=x → =x；普通文本里的撇号保持不变；未加前缀的 =x 原样保留
        var csv = "日期,商品名,单价,数量,备注\r\n" +
                  "2026-10-05,'=SUM(A1),1.00,1,'+1\r\n" +
                  "2026-10-05,it's ok,1.00,1,'hello\r\n" +
                  "2026-10-05,=raw,1.00,1,x\r\n";
        var recs = CsvService.Parse(csv).Records.OrderBy(r => r.Name, StringComparer.Ordinal).ToList();
        Assert.Equal(new[] { "=SUM(A1)", "=raw", "it's ok" }, recs.Select(r => r.Name));
        Assert.Equal("+1", recs.First(r => r.Name == "=SUM(A1)").Note);
        Assert.Equal("'hello", recs.First(r => r.Name == "it's ok").Note);
    }

    [Fact]
    public void Header_IsNotGuarded_AndPriceColumnStillImportsNumbers()
    {
        var csv = CsvService.ToCsv(new[] { Rec("牛奶", 777, 2.5m, "2026-10-01") });
        Assert.StartsWith("\uFEFF日期,条码/追溯码,商品名,分类,单价,数量,金额,", csv);
        var r = Assert.Single(CsvService.Parse(csv).Records);
        Assert.Equal(777, r.PriceCents);
    }

    [Fact]
    public async Task Api_ExportCsv_GuardsAndImportRestores()
    {
        var src = await _app.LoginAsync(new TestWallet());
        await src.AddAsync(Http.Rec("=1+1", 1250, 2, note: "@SUM(A1)", patient: "-妈妈", dosage: "+1片", barcode: "'=x"));
        var csv = Encoding.UTF8.GetString(await (await src.GetAsync("/api/export.csv")).Content.ReadAsByteArrayAsync());
        Assert.Contains(",'=1+1,", csv);
        Assert.Contains("'@SUM(A1)", csv);
        Assert.Contains("'-妈妈", csv);
        Assert.Contains("''=x", csv);
        Assert.Contains(",12.50,2,25.00,", csv); // 数值列没有前缀

        var dst = await _app.LoginAsync(new TestWallet());
        var req = new HttpRequestMessage(HttpMethod.Post, "/api/import") { Content = new StringContent(csv, new UTF8Encoding(false), "text/plain") };
        req.Headers.Add("X-Requested-With", "life-web");
        Assert.Equal(HttpStatusCode.OK, (await dst.SendAsync(req)).StatusCode);
        var q = await (await dst.Post("/api/records/query", new { })).J();
        var r = q.GetProperty("records")[0];
        Assert.Equal("=1+1", r.GetProperty("name").GetString());
        Assert.Equal("@SUM(A1)", r.GetProperty("note").GetString());
        Assert.Equal("-妈妈", r.GetProperty("patient").GetString());
        Assert.Equal("+1片", r.GetProperty("dosage").GetString());
        Assert.Equal("'=x", r.GetProperty("barcode").GetString());
        Assert.Equal(1250, r.GetProperty("priceCents").GetInt64());
    }
}
