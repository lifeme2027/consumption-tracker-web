using System.Net;
using System.Text;
using System.Text.Json;
using ConsumptionTracker.Core.Models;
using ConsumptionTracker.Core.Services;

namespace ConsumptionTracker.Web.Tests;

/// <summary>③ 空覆盖导入拒绝；① 备份 version 校验；② priceCents 小数不取整；④ 配额超限的英文。</summary>
public class ImportSafetyCoreTests
{
    private static string Doc(string? versionJson, string records = "[]", string products = "[]") =>
        "{\"app\":\"consumption-tracker\"" + (versionJson == null ? "" : ",\"version\":" + versionJson) + ",\"records\":" + records + ",\"products\":" + products + "}";

    private static string OneRec(string priceCentsJson, string extra = "") =>
        "[{\"name\":\"a\",\"priceCents\":" + priceCentsJson + ",\"quantity\":1,\"date\":\"2026-10-01\"" + extra + "}]";

    // ---------- ① version ----------

    [Theory]
    [InlineData("1")] [InlineData("2")] [InlineData("2.0")] [InlineData("1.0")]
    public void Version_1And2_AreAccepted(string v) =>
        Assert.Single(BackupService.ParseJson(Doc(v, OneRec("100"))).Records);

    [Theory]
    [InlineData(null)] [InlineData("\"abc\"")] [InlineData("\"2\"")] [InlineData("null")] [InlineData("true")]
    [InlineData("0")] [InlineData("-1")] [InlineData("1.5")] [InlineData("[]")] [InlineData("{}")]
    public void Version_MissingOrNotAnInteger_IsRejected_WithBilingualReason(string? v)
    {
        var e = Assert.Throws<InvalidDataException>(() => BackupService.ParseJson(Doc(v, OneRec("100"))));
        Assert.Contains("版本号无效", e.Message);
        Assert.Contains("version is invalid", ImportFormat.English(e));
    }

    [Theory]
    [InlineData("3")] [InlineData("99")] [InlineData("1000000000000")] [InlineData("3.0")]
    public void Version_Newer_IsRejected_WithUpgradePrompt(string v)
    {
        var e = Assert.Throws<InvalidDataException>(() => BackupService.ParseJson(Doc(v, OneRec("100"))));
        Assert.Contains("升级", e.Message);
        Assert.Contains("upgrade", ImportFormat.English(e));
    }

    [Fact]
    public void Version_V1Backup_StillCompatible_PriceFallbackAndNoProductsKey()
    {
        var r = BackupService.ParseJson("{\"app\":\"consumption-tracker\",\"version\":1,\"records\":[{\"name\":\"旧\",\"price\":12.5,\"quantity\":1,\"date\":\"2026-10-01\"}]}");
        Assert.Equal(1250, Assert.Single(r.Records).PriceCents);
    }

    // ---------- ② 小数分 ----------

    [Theory]
    [InlineData("12.5")] [InlineData("\"12.5\"")] [InlineData("0.4")] [InlineData("1250.0001")]
    public void FractionalPriceCents_IsAnInvalidRow_NotRounded_NotFallingBackToPrice(string pc)
    {
        // 即使带了可用的 price 字段也不退回：小数分本身就是错的
        var r = BackupService.ParseJson(Doc("2", OneRec(pc, ",\"price\":0.13")));
        Assert.Empty(r.Records);
        var i = Assert.Single(r.Issues);
        Assert.Equal(1, i.Row);
        Assert.Contains("priceCents", i.Reason); Assert.Contains("整数分", i.Reason); Assert.Contains("不能有小数", i.Reason);
        Assert.Contains("whole number of cents", i.ReasonEn);
    }

    [Theory]
    [InlineData("1250", 1250)] [InlineData("1250.0", 1250)] [InlineData("\"1250\"", 1250)] [InlineData("0", 0)]
    public void IntegralPriceCents_StaysValid(string pc, long expected) =>
        Assert.Equal(expected, Assert.Single(BackupService.ParseJson(Doc("2", OneRec(pc))).Records).PriceCents);

    [Fact]
    public void FractionalLastPriceCents_OfAProduct_IsIgnored_NotRounded()
    {
        var p = "[{\"barcode\":\"123\",\"name\":\"x\",\"lastPriceCents\":12.5}]";
        var r = BackupService.ParseJson(Doc("2", OneRec("100"), p));
        Assert.Null(Assert.Single(r.Products).LastPriceCents);
        var ok = BackupService.ParseJson(Doc("2", OneRec("100"), "[{\"barcode\":\"123\",\"name\":\"x\",\"lastPriceCents\":1250}]"));
        Assert.Equal(1250, Assert.Single(ok.Products).LastPriceCents);
    }

    // ---------- ③ 异常的消息 ----------

    [Fact]
    public void EmptyReplaceException_IsBilingual_AndNeutral()
    {
        var e = new EmptyReplaceException();
        Assert.Contains("没有任何记录", e.Message); Assert.Contains("不能用来清空", e.Message);
        Assert.Contains("no records", e.MessageEn); Assert.Contains("cannot be used to clear data", e.MessageEn);
    }
}

public class ImportSafetyApiTests : IDisposable
{
    private readonly TestApp _app = new();
    public void Dispose() => _app.Dispose();

    private static HttpRequestMessage Raw(string url, string body)
    {
        var r = new HttpRequestMessage(HttpMethod.Post, url) { Content = new StringContent(body, new UTF8Encoding(false), "text/plain") };
        r.Headers.Add("X-Requested-With", "life-web");
        return r;
    }

    private static string Rec(string name, string pc = "1250") =>
        "{\"id\":\"" + Guid.NewGuid() + "\",\"name\":\"" + name + "\",\"priceCents\":" + pc + ",\"quantity\":1,\"category\":\"药品\",\"date\":\"2026-10-20\",\"createdAt\":1700000000000}";

    private static string Doc(string? version, params string[] recs) =>
        "{\"app\":\"consumption-tracker\"" + (version == null ? "" : ",\"version\":" + version) + ",\"records\":[" + string.Join(",", recs) + "],\"products\":[]}";

    private async Task<(int count, string names)> StateAsync(HttpClient c)
    {
        var q = await (await c.Post("/api/records/query", new { })).J();
        return (q.GetProperty("count").GetInt32(), string.Join(",", q.GetProperty("records").EnumerateArray().Select(x => x.GetProperty("name").GetString()!).OrderBy(x => x, StringComparer.Ordinal)));
    }

    private async Task<HttpClient> SeededAsync()
    {
        var c = await _app.LoginAsync(new TestWallet());
        await c.AddAsync(Http.Rec("旧数据1")); await c.AddAsync(Http.Rec("旧数据2"));
        return c;
    }

    // ---------- ③ ----------

    [Theory]
    [InlineData("json")] [InlineData("csv")] [InlineData("csvbom")]
    public async Task EmptyFile_ReplaceImport_Is422_Bilingual_AndKeepsOldData(string kind)
    {
        var c = await SeededAsync();
        var before = await StateAsync(c);
        var body = kind == "json" ? Doc("2") : kind == "csv" ? "日期,商品名,单价,数量\n" : "\uFEFF日期,商品名,单价,数量\r\n";
        var res = await c.SendAsync(Raw("/api/import?mode=replace&confirm=yes", body));
        Assert.Equal(HttpStatusCode.UnprocessableEntity, res.StatusCode);
        var j = await res.J();
        Assert.Contains("没有任何记录", j.GetProperty("error").GetString());
        Assert.Contains("一键删除全部数据", j.GetProperty("error").GetString());
        Assert.Contains("no records", j.GetProperty("errorEn").GetString());
        Assert.Contains("delete all data", j.GetProperty("errorEn").GetString());
        Assert.Equal(0, j.GetProperty("rejected").GetArrayLength());
        Assert.Equal(before, await StateAsync(c));
    }

    [Fact]
    public async Task EmptyFile_MergeImport_StillSucceeds_WithNoSideEffects()
    {
        var c = await SeededAsync();
        var before = await StateAsync(c);
        var res = await c.SendAsync(Raw("/api/import?mode=merge", Doc("2")));
        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        Assert.Equal(before, await StateAsync(c));
    }

    [Fact]
    public async Task NonEmptyFile_ReplaceImport_StillWorks()
    {
        var c = await SeededAsync();
        var res = await c.SendAsync(Raw("/api/import?mode=replace&confirm=yes", Doc("2", Rec("新数据"))));
        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        Assert.Equal((1, "新数据"), await StateAsync(c));
    }

    [Fact]
    public async Task WipeAll_IsTheWayToClear()
    {
        var c = await SeededAsync();
        var res = await c.Post("/api/account/delete-data", new { confirm = "DELETE" });
        Assert.True(res.IsSuccessStatusCode, await res.Content.ReadAsStringAsync());
        Assert.Equal(0, (await StateAsync(c)).count);
    }

    [Fact]
    public void Repository_RejectsEmptyReplace_EvenWithoutTheEndpointGuard()
    {
        using var f = new RepoFixture();
        var repo = f.User(new TestWallet());
        repo.Add(new RecordItem { Name = "旧", PriceCents = 1, Quantity = 1, Date = "2026-10-01", Category = "药品" });
        Assert.Throws<EmptyReplaceException>(() => repo.Import(new List<RecordItem>(), new List<Product>(), ImportMode.Replace));
        Assert.Single(repo.Query(new RecordQuery()));
    }

    // ---------- ① ----------

    [Theory]
    [InlineData(null, "版本号无效", "version is invalid")]
    [InlineData("\"abc\"", "版本号无效", "version is invalid")]
    [InlineData("99", "升级", "upgrade")]
    public async Task Import_BadOrNewerVersion_Is400_Bilingual_AndKeepsData(string? v, string zh, string en)
    {
        var c = await SeededAsync();
        var before = await StateAsync(c);
        foreach (var mode in new[] { "merge", "replace&confirm=yes" })
        {
            var res = await c.SendAsync(Raw("/api/import?mode=" + mode, Doc(v, Rec("新"))));
            Assert.Equal(HttpStatusCode.BadRequest, res.StatusCode);
            var j = await res.J();
            Assert.Contains(zh, j.GetProperty("error").GetString());
            Assert.Contains(en, j.GetProperty("errorEn").GetString());
        }
        Assert.Equal(before, await StateAsync(c));
    }

    [Theory] [InlineData("1")] [InlineData("2")]
    public async Task Import_V1AndV2_Work(string v)
    {
        var c = await SeededAsync();
        var res = await c.SendAsync(Raw("/api/import?mode=replace&confirm=yes", Doc(v, Rec("兼容"))));
        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        Assert.Equal((1, "兼容"), await StateAsync(c));
    }

    // ---------- ② ----------

    [Fact]
    public async Task FractionalPriceCents_Replace_Is422WithRowReason_Merge_SkipsWithReason()
    {
        var c = await SeededAsync();
        var before = await StateAsync(c);
        var text = Doc("2", Rec("好"), Rec("坏", "12.5"));
        var rep = await c.SendAsync(Raw("/api/import?mode=replace&confirm=yes", text));
        Assert.Equal(HttpStatusCode.UnprocessableEntity, rep.StatusCode);
        var j = await rep.J();
        var row = j.GetProperty("rejected")[0];
        Assert.Equal(2, row.GetProperty("row").GetInt32());
        Assert.Contains("整数分", row.GetProperty("reason").GetString());
        Assert.Contains("whole number of cents", row.GetProperty("reasonEn").GetString());
        Assert.Equal(before, await StateAsync(c));

        var mer = await c.SendAsync(Raw("/api/import?mode=merge", text));
        Assert.Equal(HttpStatusCode.OK, mer.StatusCode);
        var m = await mer.J();
        Assert.Equal(1, m.GetProperty("skipped").GetInt32());
        Assert.Contains("整数分", m.GetProperty("skippedRows")[0].GetProperty("reason").GetString());
        Assert.Equal(3, (await StateAsync(c)).count);
    }

    // ---------- ④ ----------

    [Fact]
    public async Task QuotaExceeded_Add_And_Import_ReturnEnglish()
    {
        using var app = new TestApp { Settings = new() { ["Life:Storage:MaxRecordsPerUser"] = "2" } };
        var c = await app.LoginAsync(new TestWallet());
        await c.AddAsync(Http.Rec("a")); await c.AddAsync(Http.Rec("b"));
        var add = await c.Post("/api/records", Http.Rec("c"));
        Assert.Equal(HttpStatusCode.BadRequest, add.StatusCode);
        var j = await add.J();
        Assert.Contains("上限（2 条）", j.GetProperty("error").GetString());
        Assert.Equal("The record limit has been reached (2 records)", j.GetProperty("errorEn").GetString());

        var imp = await c.SendAsync(Raw("/api/import?mode=merge", Doc("2", Rec("x"), Rec("y"), Rec("z"))));
        Assert.Equal(HttpStatusCode.BadRequest, imp.StatusCode);
        var k = await imp.J();
        Assert.Contains("导入后记录数将超过上限", k.GetProperty("error").GetString());
        Assert.Contains("would exceed the limit of 2", k.GetProperty("errorEn").GetString());
    }

    [Fact]
    public async Task OtherApiErrors_CarryEnglish()
    {
        var c = await _app.LoginAsync(new TestWallet());
        var bad = await c.Post("/api/records", Http.Rec(name: ""));                       // 校验失败
        Assert.Equal(HttpStatusCode.BadRequest, bad.StatusCode);
        Assert.False(string.IsNullOrWhiteSpace((await bad.J()).GetProperty("errorEn").GetString()));
        var q = await c.Post("/api/records/query", new { from = "xx" });
        Assert.Equal(HttpStatusCode.BadRequest, q.StatusCode);
        Assert.Contains("start date", (await q.J()).GetProperty("errorEn").GetString());
        var nf = await c.Del("/api/records/not-there");
        Assert.Equal(HttpStatusCode.NotFound, nf.StatusCode);
        Assert.Equal("Record not found", (await nf.J()).GetProperty("errorEn").GetString());
    }
}
