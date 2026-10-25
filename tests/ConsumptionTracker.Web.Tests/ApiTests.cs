using System.Net;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;

namespace ConsumptionTracker.Web.Tests;

public class ApiTests : IDisposable
{
    private readonly TestApp _app = new();
    public void Dispose() => _app.Dispose();

    private static StringContent Text(string s) => new(s, new UTF8Encoding(false), "text/plain");

    private static HttpRequestMessage Raw(HttpMethod m, string url, HttpContent? c = null)
    {
        var r = new HttpRequestMessage(m, url) { Content = c };
        r.Headers.Add("X-Requested-With", "life-web");
        return r;
    }

    [Fact]
    public async Task AllDataEndpoints_RequireLogin()
    {
        var c = _app.NewClient();
        foreach (var (m, url) in new[]
        {
            (HttpMethod.Get, "/api/meta"), (HttpMethod.Get, "/api/stats"), (HttpMethod.Get, "/api/export.json"),
            (HttpMethod.Get, "/api/export.csv"), (HttpMethod.Get, "/api/records/x"), (HttpMethod.Post, "/api/records"),
            (HttpMethod.Post, "/api/records/query"), (HttpMethod.Put, "/api/records/x"), (HttpMethod.Delete, "/api/records/x"),
            (HttpMethod.Post, "/api/records/delete"), (HttpMethod.Post, "/api/records/batch"), (HttpMethod.Post, "/api/import"),
            (HttpMethod.Post, "/api/products/lookup"), (HttpMethod.Post, "/api/account/delete-data"),
        })
        {
            var resp = await c.SendAsync(Raw(m, url, m == HttpMethod.Get ? null : new StringContent("{}", Encoding.UTF8, "application/json")));
            Assert.True(resp.StatusCode == HttpStatusCode.Unauthorized, $"{m} {url} => {(int)resp.StatusCode}");
        }
    }

    [Fact]
    public async Task Crud_OverHttp()
    {
        var c = await _app.LoginAsync(new TestWallet());
        var id = await c.AddAsync(Http.Rec(note: "饭后", patient: "妈妈", dosage: "0.5g×24片", batch: "方1"));

        var got = await (await c.GetAsync($"/api/records/{id}")).J();
        Assert.Equal("阿莫西林", got.GetProperty("name").GetString());
        Assert.Equal(2500, got.GetProperty("amountCents").GetInt64());
        Assert.Equal("妈妈", got.GetProperty("patient").GetString());
        Assert.Equal("方1", got.GetProperty("batchName").GetString());

        var put = await c.Put($"/api/records/{id}", Http.Rec("头孢", 3000, 1, "药品", "2026-10-21"));
        Assert.Equal(HttpStatusCode.OK, put.StatusCode);
        Assert.Equal(3000, (await put.J()).GetProperty("amountCents").GetInt64());

        var q = await (await c.Post("/api/records/query", new { })).J();
        Assert.Equal(1, q.GetProperty("count").GetInt32());
        Assert.Equal(3000, q.GetProperty("totalCents").GetInt64());

        Assert.Equal(HttpStatusCode.OK, (await c.Del($"/api/records/{id}")).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await c.GetAsync($"/api/records/{id}")).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await c.Del($"/api/records/{id}")).StatusCode);
    }

    [Fact]
    public async Task Create_ValidationErrors_Return400_WithoutEchoingContent()
    {
        var c = await _app.LoginAsync(new TestWallet());
        foreach (var bad in new object[]
        {
            Http.Rec(name: ""), Http.Rec(priceCents: -1), Http.Rec(qty: 0), Http.Rec(date: "2026-02-30"),
            Http.Rec(name: new string('长', 101)), new { name = "x", date = "2026-10-01" } /* 缺价格 */,
        })
        {
            var r = await c.Post("/api/records", bad);
            Assert.Equal(HttpStatusCode.BadRequest, r.StatusCode);
            Assert.DoesNotContain("长长长", await r.Content.ReadAsStringAsync());
        }
        Assert.Equal(HttpStatusCode.BadRequest, (await c.Post("/api/records", new StringContent("{not json", Encoding.UTF8, "application/json"))).StatusCode);
    }

    [Fact]
    public async Task Filters_And_Stats_AreConsistentWithList()
    {
        var c = await _app.LoginAsync(new TestWallet());
        await c.AddAsync(Http.Rec("a", 333, 3, "药品", "2026-10-05"));
        await c.AddAsync(Http.Rec("b", 199, 0.5m, "食品", "2026-10-05", barcode: ""));
        await c.AddAsync(Http.Rec("c", 1000, 1, "药品", "2026-10-31"));
        await c.AddAsync(Http.Rec("d", 5000, 1, "药品", "2026-11-01"));

        var list = await (await c.Post("/api/records/query", new { from = "2026-10-01", to = "2026-10-31" })).J();
        var stats = await (await c.GetAsync("/api/stats?month=2026-10&day=2026-10-05")).J();
        Assert.Equal(list.GetProperty("totalCents").GetInt64(), stats.GetProperty("monthTotalCents").GetInt64());
        Assert.Equal(list.GetProperty("count").GetInt32(), stats.GetProperty("monthCount").GetInt32());
        Assert.Equal(999 + 100 + 1000, stats.GetProperty("monthTotalCents").GetInt64());
        Assert.Equal(1099, stats.GetProperty("dayTotalCents").GetInt64());
        var cats = stats.GetProperty("categories").EnumerateArray().ToList();
        Assert.Equal(stats.GetProperty("monthTotalCents").GetInt64(), cats.Sum(x => x.GetProperty("cents").GetInt64()));
        Assert.Equal(1.0, cats.Sum(x => x.GetProperty("ratio").GetDouble()), 6);
        Assert.Equal("药品", cats[0].GetProperty("category").GetString());
        var days = stats.GetProperty("days").EnumerateArray().Sum(x => x.GetProperty("cents").GetInt64());
        Assert.Equal(stats.GetProperty("monthTotalCents").GetInt64(), days);

        var byCat = await (await c.Post("/api/records/query", new { category = "食品" })).J();
        Assert.Equal(1, byCat.GetProperty("count").GetInt32());
        var byKw = await (await c.Post("/api/records/query", new { keyword = "c" , from = "2026-10-01", to="2026-10-31"})).J();
        Assert.True(byKw.GetProperty("count").GetInt32() >= 1);

        Assert.Equal(HttpStatusCode.BadRequest, (await c.GetAsync("/api/stats?month=2026-13")).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await c.Post("/api/records/query", new { from = "bad" })).StatusCode);
    }

    [Fact]
    public async Task ProductLookup_And_Meta()
    {
        var c = await _app.LoginAsync(new TestWallet());
        await c.AddAsync(Http.Rec("阿莫西林", 880, barcode: "111", batch: "方1"));
        var p = await (await c.Post("/api/products/lookup", new { barcode = "111" })).J();
        Assert.True(p.GetProperty("found").GetBoolean());
        Assert.Equal(880, p.GetProperty("lastPriceCents").GetInt64());
        Assert.False((await (await c.Post("/api/products/lookup", new { barcode = "nope" })).J()).GetProperty("found").GetBoolean());
        var meta = await (await c.GetAsync("/api/meta")).J();
        Assert.Contains("药品", meta.GetProperty("categories").EnumerateArray().Select(x => x.GetString()));
        Assert.Equal("方1", meta.GetProperty("batches")[0].GetProperty("batchName").GetString());
    }

    [Fact]
    public async Task Batch_AssignAndBulkDelete()
    {
        var c = await _app.LoginAsync(new TestWallet());
        var a = await c.AddAsync(Http.Rec("a")); var b = await c.AddAsync(Http.Rec("b"));
        var r = await (await c.Post("/api/records/batch", new { ids = new[] { a, b }, name = "方X" })).J();
        Assert.Equal(2, r.GetProperty("updated").GetInt32());
        var q = await (await c.Post("/api/records/query", new { })).J();
        Assert.All(q.GetProperty("records").EnumerateArray(), x => Assert.Equal("方X", x.GetProperty("batchName").GetString()));
        Assert.Equal(2, (await (await c.Post("/api/records/delete", new { ids = new[] { a, b } })).J()).GetProperty("deleted").GetInt32());
        Assert.Equal(HttpStatusCode.BadRequest, (await c.Post("/api/records/delete", new { ids = Array.Empty<string>() })).StatusCode);
    }

    // ---------- 越权：读 / 改 / 删他人记录 ----------

    [Fact]
    public async Task Isolation_BCannotRead_Modify_OrDeleteAsRecords_OverHttp()
    {
        var ca = await _app.LoginAsync(new TestWallet());
        var cb = await _app.LoginAsync(new TestWallet());
        var secret = await ca.AddAsync(Http.Rec("A的秘密药", note: "A的隐私备注", patient: "A的家人", batch: "A方"));
        await cb.AddAsync(Http.Rec("B自己的"));

        // 读：按 id、列表、关键词、元数据、统计、导出
        Assert.Equal(HttpStatusCode.NotFound, (await cb.GetAsync($"/api/records/{secret}")).StatusCode);
        var list = await (await cb.Post("/api/records/query", new { })).J();
        Assert.Equal(1, list.GetProperty("count").GetInt32());
        Assert.DoesNotContain("A的", list.ToString());
        var kw = await (await cb.Post("/api/records/query", new { keyword = "A的隐私备注" })).J();
        Assert.Equal(0, kw.GetProperty("count").GetInt32());
        Assert.DoesNotContain("A方", (await (await cb.GetAsync("/api/meta")).Content.ReadAsStringAsync()));
        var stats = await (await cb.GetAsync("/api/stats?month=2026-10")).J();
        Assert.Equal(1250 * 2, stats.GetProperty("monthTotalCents").GetInt64());
        Assert.DoesNotContain("A的", await (await cb.GetAsync("/api/export.json")).Content.ReadAsStringAsync());
        Assert.DoesNotContain("A的", await (await cb.GetAsync("/api/export.csv")).Content.ReadAsStringAsync());

        // 改
        var put = await cb.Put($"/api/records/{secret}", Http.Rec("被B篡改"));
        Assert.Equal(HttpStatusCode.NotFound, put.StatusCode);
        // 删（单个 / 批量 / 批次归并）
        Assert.Equal(HttpStatusCode.NotFound, (await cb.Del($"/api/records/{secret}")).StatusCode);
        Assert.Equal(0, (await (await cb.Post("/api/records/delete", new { ids = new[] { secret } })).J()).GetProperty("deleted").GetInt32());
        Assert.Equal(0, (await (await cb.Post("/api/records/batch", new { ids = new[] { secret }, name = "劫持" })).J()).GetProperty("updated").GetInt32());

        // A 的数据毫发无损
        var still = await (await ca.GetAsync($"/api/records/{secret}")).J();
        Assert.Equal("A的秘密药", still.GetProperty("name").GetString());
        Assert.Equal("A方", still.GetProperty("batchName").GetString());
    }

    [Fact]
    public async Task Isolation_BDeleteAllAndReplaceImport_DoNotTouchA()
    {
        var ca = await _app.LoginAsync(new TestWallet());
        var cb = await _app.LoginAsync(new TestWallet());
        var idA = await ca.AddAsync(Http.Rec("A1"));
        await cb.AddAsync(Http.Rec("B1"));

        var json = await (await cb.GetAsync("/api/export.json")).Content.ReadAsStringAsync();
        Assert.Equal(HttpStatusCode.OK, (await cb.SendAsync(Raw(HttpMethod.Post, "/api/import?mode=replace&confirm=yes", Text(json)))).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await cb.Post("/api/account/delete-data", new { confirm = "DELETE" })).StatusCode);

        Assert.Equal(HttpStatusCode.OK, (await ca.GetAsync($"/api/records/{idA}")).StatusCode);
        Assert.Equal(0, (await (await cb.Post("/api/records/query", new { })).J()).GetProperty("count").GetInt32());
    }

    [Fact]
    public async Task Isolation_ImportingA_sExportIntoB_CopiesToB_ButNeverOverwritesA()
    {
        var ca = await _app.LoginAsync(new TestWallet());
        var cb = await _app.LoginAsync(new TestWallet());
        var idA = await ca.AddAsync(Http.Rec("A原始"));
        var export = await (await ca.GetAsync("/api/export.json")).Content.ReadAsStringAsync();
        // B 导入了含相同 id 的文件后改名，不应影响 A
        Assert.Equal(HttpStatusCode.OK, (await cb.SendAsync(Raw(HttpMethod.Post, "/api/import", Text(export)))).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await cb.Put($"/api/records/{idA}", Http.Rec("B改名"))).StatusCode);
        Assert.Equal("A原始", (await (await ca.GetAsync($"/api/records/{idA}")).J()).GetProperty("name").GetString());
    }

    // ---------- 导入导出 / 一键删除 ----------

    [Fact]
    public async Task Export_Json_Csv_FormatAndHeaders()
    {
        var c = await _app.LoginAsync(new TestWallet());
        await c.AddAsync(Http.Rec("药A", 1999, 1.5m, note: "含,逗号"));
        var rj = await c.GetAsync("/api/export.json");
        Assert.Contains("attachment", rj.Content.Headers.ContentDisposition!.ToString());
        using var doc = JsonDocument.Parse(await rj.Content.ReadAsStringAsync());
        Assert.Equal("consumption-tracker", doc.RootElement.GetProperty("app").GetString());
        Assert.Equal(2, doc.RootElement.GetProperty("version").GetInt32());
        Assert.Equal(19.99m, doc.RootElement.GetProperty("records")[0].GetProperty("price").GetDecimal());
        Assert.Equal(1999, doc.RootElement.GetProperty("records")[0].GetProperty("priceCents").GetInt64());

        var bytes = await (await c.GetAsync("/api/export.csv")).Content.ReadAsByteArrayAsync();
        Assert.Equal(new byte[] { 0xEF, 0xBB, 0xBF }, bytes[..3]);
        Assert.NotEqual(new byte[] { 0xEF, 0xBB, 0xBF }, bytes[3..6]);
    }

    [Fact]
    public async Task Import_Json_And_Csv_RoundTrip_ThroughApi_ThenRefreshStillThere()
    {
        var src = await _app.LoginAsync(new TestWallet());
        await src.AddAsync(Http.Rec("药A", 1999, 1.5m, patient: "妈妈", dosage: "0.5g×24片"));
        await src.AddAsync(Http.Rec("饭", 300, 1, "餐饮", "2026-10-02", barcode: ""));
        var json = await (await src.GetAsync("/api/export.json")).Content.ReadAsStringAsync();
        var csv = Encoding.UTF8.GetString(await (await src.GetAsync("/api/export.csv")).Content.ReadAsByteArrayAsync());

        var d1 = await _app.LoginAsync(new TestWallet());
        var r1 = await (await d1.SendAsync(Raw(HttpMethod.Post, "/api/import", Text(json)))).J();
        Assert.Equal(2, r1.GetProperty("added").GetInt32());

        var d2 = await _app.LoginAsync(new TestWallet());
        var r2 = await (await d2.SendAsync(Raw(HttpMethod.Post, "/api/import", Text(csv)))).J();
        Assert.Equal(2, r2.GetProperty("added").GetInt32());

        foreach (var d in new[] { d1, d2 })
        {
            var q = await (await d.Post("/api/records/query", new { })).J();
            Assert.Equal(2, q.GetProperty("count").GetInt32());
            Assert.Equal(2999 + 300, q.GetProperty("totalCents").GetInt64()); // round(1999×1.5=2998.5)=2999，四舍五入远离零
        }
    }

    [Fact]
    public async Task Import_ReplaceNeedsConfirm_AndBadInputRejected()
    {
        var c = await _app.LoginAsync(new TestWallet());
        await c.AddAsync(Http.Rec("留着"));
        Assert.Equal(HttpStatusCode.BadRequest, (await c.SendAsync(Raw(HttpMethod.Post, "/api/import?mode=replace", Text("{\"app\":\"consumption-tracker\",\"records\":[]}")))).StatusCode);
        Assert.Equal(1, (await (await c.Post("/api/records/query", new { })).J()).GetProperty("count").GetInt32());
        Assert.Equal(HttpStatusCode.BadRequest, (await c.SendAsync(Raw(HttpMethod.Post, "/api/import", Text("{broken")))).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await c.SendAsync(Raw(HttpMethod.Post, "/api/import", Text("   ")))).StatusCode);
        Assert.Equal(1, (await (await c.Post("/api/records/query", new { })).J()).GetProperty("count").GetInt32());
    }

    [Fact]
    public async Task DeleteAll_RequiresSecondConfirmation()
    {
        var c = await _app.LoginAsync(new TestWallet());
        await c.AddAsync(Http.Rec("a")); await c.AddAsync(Http.Rec("b"));
        Assert.Equal(HttpStatusCode.BadRequest, (await c.Post("/api/account/delete-data", new { })).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await c.Post("/api/account/delete-data", new { confirm = "yes" })).StatusCode);
        Assert.Equal(2, (await (await c.Post("/api/records/query", new { })).J()).GetProperty("count").GetInt32());
        var r = await (await c.Post("/api/account/delete-data", new { confirm = "DELETE" })).J();
        Assert.Equal(2, r.GetProperty("deleted").GetInt32());
        Assert.Equal(0, (await (await c.Post("/api/records/query", new { })).J()).GetProperty("count").GetInt32());
    }

    // ---------- 安全：CSRF、头、体积、日志 ----------

    [Fact]
    public async Task Csrf_MutatingRequestsWithoutHeaderOrWithForeignOrigin_Rejected()
    {
        var c = await _app.LoginAsync(new TestWallet());
        var noHeader = new HttpRequestMessage(HttpMethod.Post, "/api/records") { Content = JsonContent.Create(Http.Rec()) };
        Assert.Equal(HttpStatusCode.Forbidden, (await c.SendAsync(noHeader)).StatusCode);

        var formPost = new HttpRequestMessage(HttpMethod.Post, "/api/account/delete-data")
        { Content = new StringContent("confirm=DELETE", Encoding.UTF8, "application/x-www-form-urlencoded") };
        Assert.Equal(HttpStatusCode.Forbidden, (await c.SendAsync(formPost)).StatusCode);

        var foreign = Raw(HttpMethod.Post, "/api/records", JsonContent.Create(Http.Rec()));
        foreign.Headers.Add("Origin", "https://evil.example");
        Assert.Equal(HttpStatusCode.Forbidden, (await c.SendAsync(foreign)).StatusCode);

        var sameOrigin = Raw(HttpMethod.Post, "/api/records", JsonContent.Create(Http.Rec()));
        sameOrigin.Headers.Add("Origin", "http://localhost");
        Assert.Equal(HttpStatusCode.Created, (await c.SendAsync(sameOrigin)).StatusCode);

        // 登录端点同样受保护（防登录 CSRF）
        var login = new HttpRequestMessage(HttpMethod.Post, "/api/auth/challenge") { Content = JsonContent.Create(new { address = new TestWallet().Address }) };
        Assert.Equal(HttpStatusCode.Forbidden, (await c.SendAsync(login)).StatusCode);
    }

    [Fact]
    public async Task SecurityHeaders_CspForbidsExternalConnections_AndNoServerHeaders()
    {
        var c = _app.NewClient();
        foreach (var url in new[] { "/", "/api/config", "/privacy.html", "/healthz" })
        {
            var r = await c.GetAsync(url);
            var csp = string.Join(";", r.Headers.GetValues("Content-Security-Policy"));
            Assert.Contains("default-src 'none'", csp);
            Assert.Contains("connect-src 'self'", csp);
            Assert.Contains("script-src 'self'", csp);
            Assert.Contains("frame-ancestors 'none'", csp);
            Assert.DoesNotContain("http:", csp);
            Assert.DoesNotContain("https:", csp);
            Assert.DoesNotContain("unsafe-eval", csp);
            Assert.DoesNotContain("script-src 'self' 'unsafe-inline'", csp);
            Assert.Equal("nosniff", r.Headers.GetValues("X-Content-Type-Options").Single());
            Assert.Equal("no-referrer", r.Headers.GetValues("Referrer-Policy").Single());
            Assert.False(r.Headers.Contains("X-Powered-By"));
            Assert.False(r.Headers.Contains("Server"));
        }
        Assert.Equal("no-store", (await c.GetAsync("/api/config")).Headers.CacheControl!.ToString());
    }

    [Fact]
    public async Task OversizedBodies_AreRejected()
    {
        var c = await _app.LoginAsync(new TestWallet());
        var big = new string('x', 200_000);
        var r = await c.SendAsync(Raw(HttpMethod.Post, "/api/records", new StringContent("{\"name\":\"" + big + "\"}", Encoding.UTF8, "application/json")));
        Assert.True(r.StatusCode is HttpStatusCode.RequestEntityTooLarge or HttpStatusCode.BadRequest, r.StatusCode.ToString());

        var huge = new string('y', 6 * 1024 * 1024);
        var r2 = await c.SendAsync(Raw(HttpMethod.Post, "/api/import", Text(huge)));
        Assert.True(r2.StatusCode is HttpStatusCode.RequestEntityTooLarge or HttpStatusCode.BadRequest, r2.StatusCode.ToString());
    }

    [Fact]
    public async Task UnknownApiRoute_Is404Json_NotStaticFallback()
    {
        var r = await _app.NewClient().GetAsync("/api/nope");
        Assert.Equal(HttpStatusCode.NotFound, r.StatusCode);
    }

    [Fact]
    public async Task Logs_NeverContainRecordContents()
    {
        // 把日志级别调到最详细：即使运维开了 Debug/Trace，也不能出现记录内容
        using var app = new TestApp { Settings = { ["Logging:LogLevel:Default"] = "Trace", ["Logging:LogLevel:Microsoft.AspNetCore"] = "Trace" } };
        var w = new TestWallet();
        var c = await app.LoginAsync(w);
        var id = await c.AddAsync(Http.Rec("绝密药名XYZ", note: "绝密备注XYZ", patient: "绝密用药人XYZ", dosage: "绝密剂量XYZ", batch: "绝密批次XYZ"));
        await c.Put($"/api/records/{id}", Http.Rec("绝密药名XYZ2", note: "绝密备注XYZ2"));
        await c.Post("/api/records/query", new { keyword = "绝密药名XYZ" });
        await c.Post("/api/records", new { name = "绝密非法XYZ", priceCents = -1, date = "bad" }); // 400
        var export = await (await c.GetAsync("/api/export.json")).Content.ReadAsStringAsync();
        await c.SendAsync(Raw(HttpMethod.Post, "/api/import", Text(export)));
        await c.SendAsync(Raw(HttpMethod.Post, "/api/import", Text("{绝密坏JSON XYZ")));
        await c.Del($"/api/records/{id}");
        string[] lines;
        lock (app.Logs.Lines) lines = app.Logs.Lines.ToArray();
        Assert.NotEmpty(lines);
        Assert.DoesNotContain(lines, l => l.Contains("XYZ") || l.Contains("绝密"));
    }

    [Fact]
    public async Task Config_ReportsNoDevLogin_AndStaticPagesServed()
    {
        var c = _app.NewClient();
        var cfg = await (await c.GetAsync("/api/config")).J();
        Assert.False(cfg.GetProperty("devLogin").GetBoolean());
        Assert.Equal("mainnet", cfg.GetProperty("network").GetString());
        Assert.Equal(HttpStatusCode.OK, (await c.GetAsync("/healthz")).StatusCode);
        var index = await c.GetAsync("/");
        Assert.Equal(HttpStatusCode.OK, index.StatusCode);
        var html = await index.Content.ReadAsStringAsync();
        Assert.DoesNotMatch("https?://", html.Replace("http://www.w3.org", ""));
        Assert.Equal(HttpStatusCode.OK, (await c.GetAsync("/vendor/html5-qrcode.min.js")).StatusCode);
    }
}
