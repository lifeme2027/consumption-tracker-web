using System.Net;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using ConsumptionTracker.Core.Models;
using ConsumptionTracker.Core.Services;

namespace ConsumptionTracker.Web.Tests;

/// <summary>I-01 / L-7：覆盖导入先全量预检、有拒绝则整体中止（不清空）；合并导入返回被跳过的行号与原因。</summary>
public class ImportRejectionTests : IDisposable
{
    private readonly TestApp _app = new();
    public void Dispose() => _app.Dispose();

    private static StringContent Text(string s) => new(s, new UTF8Encoding(false), "text/plain");
    private static HttpRequestMessage Raw(string url, string body)
    {
        var r = new HttpRequestMessage(HttpMethod.Post, url) { Content = Text(body) };
        r.Headers.Add("X-Requested-With", "life-web");
        return r;
    }

    private static JsonObject Rec(string name = "好记录", long cents = 1250, decimal qty = 1, string note = "", string date = "2026-10-20") => new()
    {
        ["id"] = Guid.NewGuid().ToString(), ["barcode"] = "", ["name"] = name, ["priceCents"] = cents, ["quantity"] = qty,
        ["category"] = "药品", ["note"] = note, ["date"] = date, ["createdAt"] = 1700000000000L,
    };

    private static string Backup(params JsonNode[] recs) => new JsonObject
    {
        ["app"] = "consumption-tracker", ["version"] = 2, ["records"] = new JsonArray(recs), ["products"] = new JsonArray(),
    }.ToJsonString();

    private async Task<HttpClient> SeededAsync(int n = 2)
    {
        var c = await _app.LoginAsync(new TestWallet());
        for (var i = 1; i <= n; i++) await c.AddAsync(Http.Rec("旧数据" + i));
        return c;
    }

    private static async Task<(int count, string names)> StateAsync(HttpClient c)
    {
        var q = await (await c.Post("/api/records/query", new { })).J();
        return (q.GetProperty("count").GetInt32(), string.Join(",", q.GetProperty("records").EnumerateArray().Select(x => x.GetProperty("name").GetString()!).OrderBy(x => x, StringComparer.Ordinal)));
    }

    [Theory]
    [InlineData("note", "备注过长")]
    [InlineData("qty7", "数量最多 6 位小数")]
    [InlineData("qtyBig", "数量过大")]
    [InlineData("priceBig", "价格过大")]
    [InlineData("name", "名称过长")]
    public async Task Replace_WithOneBadRecord_Aborts_422_ListsRow_KeepsOldData(string kind, string reasonPart)
    {
        var c = await SeededAsync();
        var bad = kind switch
        {
            "note" => Rec("坏", note: new string('备', 1001)),
            "qty7" => Rec("坏", qty: 0.0000001m),
            "qtyBig" => Rec("坏", qty: 1_000_001m),
            "priceBig" => Rec("坏", cents: 100_000_000_001L),
            _ => Rec(new string('名', 101)),
        };
        var resp = await c.SendAsync(Raw("/api/import?mode=replace&confirm=yes", Backup(Rec("好1"), bad, Rec("好3"))));
        Assert.Equal(HttpStatusCode.UnprocessableEntity, resp.StatusCode);
        var j = await resp.J();
        Assert.Equal(1, j.GetProperty("rejectedCount").GetInt32());
        Assert.Equal(3, j.GetProperty("total").GetInt32());
        var row = j.GetProperty("rejected")[0];
        Assert.Equal(2, row.GetProperty("row").GetInt32());
        Assert.Equal("第 2 条", row.GetProperty("label").GetString());
        Assert.Equal("Record #2", row.GetProperty("labelEn").GetString());
        Assert.Contains(reasonPart, row.GetProperty("reason").GetString());
        Assert.False(string.IsNullOrWhiteSpace(row.GetProperty("reasonEn").GetString()));
        Assert.Contains("没有任何改动", j.GetProperty("error").GetString());
        Assert.Equal((2, "旧数据1,旧数据2"), await StateAsync(c));   // 旧数据原样保留
    }

    [Fact]
    public async Task Replace_ValidJson_ButEveryRecordInvalid_DoesNotClearOldData_L7()
    {
        var c = await SeededAsync(3);
        var resp = await c.SendAsync(Raw("/api/import?mode=replace&confirm=yes",
            Backup(Rec("a", qty: 0), Rec("", cents: 1), Rec("c", date: "2026/10/20"))));
        Assert.Equal(HttpStatusCode.UnprocessableEntity, resp.StatusCode);
        var j = await resp.J();
        Assert.Equal(3, j.GetProperty("rejectedCount").GetInt32());
        Assert.Equal(new[] { 1, 2, 3 }, j.GetProperty("rejected").EnumerateArray().Select(x => x.GetProperty("row").GetInt32()).ToArray());
        Assert.Equal(3, (await StateAsync(c)).count);
    }

    [Fact]
    public async Task Replace_ListsEveryBadRow_AndCapsTheListButNotTheCount()
    {
        var c = await SeededAsync();
        var recs = Enumerable.Range(1, 250).Select(i => (JsonNode)Rec("坏" + i, qty: 0)).ToArray();
        var j = await (await c.SendAsync(Raw("/api/import?mode=replace&confirm=yes", Backup(recs)))).J();
        Assert.Equal(250, j.GetProperty("rejectedCount").GetInt32());
        Assert.Equal(200, j.GetProperty("rejected").GetArrayLength());
        Assert.Equal(2, (await StateAsync(c)).count);
    }

    [Fact]
    public async Task Replace_Csv_BadRow_ReportsRowNumber_HeaderIsRow1()
    {
        var c = await SeededAsync();
        var csv = "日期,商品名,单价,数量,备注\n2026-10-01,好,1.00,1,\n2026-10-02,坏价,abc,1,\n2026-10-03,坏量,1.00,2.1234567,\n";
        var resp = await c.SendAsync(Raw("/api/import?mode=replace&confirm=yes", csv));
        Assert.Equal(HttpStatusCode.UnprocessableEntity, resp.StatusCode);
        var rows = (await resp.J()).GetProperty("rejected").EnumerateArray().ToList();
        Assert.Equal(new[] { 3, 4 }, rows.Select(x => x.GetProperty("row").GetInt32()).ToArray());
        Assert.Equal("第 3 行", rows[0].GetProperty("label").GetString());
        Assert.Equal("Row 4", rows[1].GetProperty("labelEn").GetString());
        Assert.Contains("价格无效", rows[0].GetProperty("reason").GetString());
        Assert.Contains("数量最多 6 位小数", rows[1].GetProperty("reason").GetString());
        Assert.Equal(2, (await StateAsync(c)).count);
    }

    [Fact]
    public async Task Replace_AllValid_ReplacesInOneGo()
    {
        var c = await SeededAsync();
        var resp = await c.SendAsync(Raw("/api/import?mode=replace&confirm=yes", Backup(Rec("新1"), Rec("新2"), Rec("新3"))));
        Assert.Equal(HttpStatusCode.OK, resp.StatusCode);
        var j = await resp.J();
        Assert.Equal(3, j.GetProperty("added").GetInt32());
        Assert.Equal(0, j.GetProperty("skipped").GetInt32());
        Assert.Equal((3, "新1,新2,新3"), await StateAsync(c));
    }

    [Fact]
    public async Task Merge_ImportsValid_ReturnsSkippedRowsWithReasons()
    {
        var c = await SeededAsync();
        var resp = await c.SendAsync(Raw("/api/import?mode=merge", Backup(
            Rec("好1"), Rec("坏备注", note: new string('x', 1001)), Rec("好2"), Rec("坏量", qty: 2_000_000m), JsonValue.Create("不是对象")!)));
        Assert.Equal(HttpStatusCode.OK, resp.StatusCode);
        var j = await resp.J();
        Assert.Equal(2, j.GetProperty("added").GetInt32());
        Assert.Equal(3, j.GetProperty("skipped").GetInt32());
        Assert.Equal(5, j.GetProperty("total").GetInt32());
        var rows = j.GetProperty("skippedRows").EnumerateArray().ToList();
        Assert.Equal(new[] { 2, 4, 5 }, rows.Select(x => x.GetProperty("row").GetInt32()).ToArray());
        Assert.Contains("备注过长", rows[0].GetProperty("reason").GetString());
        Assert.Contains("数量过大", rows[1].GetProperty("reason").GetString());
        Assert.Contains("Quantity too large", rows[1].GetProperty("reasonEn").GetString());
        Assert.Equal("第 5 条", rows[2].GetProperty("label").GetString());
        Assert.Equal((4, "好1,好2,旧数据1,旧数据2"), await StateAsync(c));
    }

    [Fact]
    public async Task AbsurdNumbers_GiveSpecificReasons_NotAGenericParseError()
    {
        var c = await SeededAsync();
        var body = "{\"app\":\"consumption-tracker\",\"records\":[" +
                   "{\"name\":\"a\",\"priceCents\":1e300,\"quantity\":1,\"date\":\"2026-10-01\"}," +
                   "{\"name\":\"b\",\"price\":99999999999999999999999,\"quantity\":1,\"date\":\"2026-10-01\"}," +
                   "{\"name\":\"c\",\"priceCents\":5,\"quantity\":1e300,\"date\":\"2026-10-01\"}," +
                   "{\"name\":\"d\",\"priceCents\":-5,\"quantity\":1,\"date\":\"2026-10-01\"}]}";
        var resp = await c.SendAsync(Raw("/api/import?mode=replace&confirm=yes", body));
        Assert.Equal(HttpStatusCode.UnprocessableEntity, resp.StatusCode);
        var rs = (await resp.J()).GetProperty("rejected").EnumerateArray().Select(x => x.GetProperty("reason").GetString()!).ToList();
        Assert.Contains("价格过大", rs[0]); Assert.Contains("价格过大", rs[1]);
        Assert.Contains("数量过大", rs[2]); Assert.Contains("价格不能为负数", rs[3]);
        Assert.Equal(2, (await StateAsync(c)).count);
    }

    // ---------- 仓储层：同一事务 / 预检 ----------

    [Fact]
    public void Repo_Replace_WithBadRecord_ThrowsRejected_AndKeepsOldData()
    {
        using var f = new RepoFixture();
        var repo = f.User(new TestWallet());
        repo.Add(new RecordItem { Name = "旧", PriceCents = 100, Quantity = 1, Date = "2026-10-01" });
        var good = new RecordItem { Name = "新", PriceCents = 100, Quantity = 1, Date = "2026-10-01" };
        var bad = good with { Name = "坏", Note = new string('x', 1001) };
        var ex = Assert.Throws<ImportRejectedException>(() => repo.Import(new[] { good, bad, good with { Id = "g2" } }, Array.Empty<Product>(), ImportMode.Replace));
        Assert.Single(ex.Issues);
        Assert.Equal(2, ex.Issues[0].Row);
        Assert.Equal(3, ex.Total);
        Assert.Equal(new[] { "旧" }, repo.Query().Select(r => r.Name));
    }

    [Fact]
    public void Repo_Replace_ThatFailsMidWay_RollsBack_NoPartialClear()
    {
        using var f = new RepoFixture(maxRecords: 2);
        var repo = f.User(new TestWallet());
        repo.Add(new RecordItem { Name = "旧1", PriceCents = 100, Quantity = 1, Date = "2026-10-01" });
        repo.Add(new RecordItem { Name = "旧2", PriceCents = 100, Quantity = 1, Date = "2026-10-01" });
        var many = Enumerable.Range(1, 3).Select(i => new RecordItem { Id = "n" + i, Name = "新" + i, PriceCents = 100, Quantity = 1, Date = "2026-10-01" }).ToList();
        Assert.Throws<InvalidOperationException>(() => repo.Import(many, Array.Empty<Product>(), ImportMode.Replace));
        Assert.Equal(new[] { "旧1", "旧2" }, repo.Query().Select(r => r.Name).OrderBy(x => x));
    }
}
