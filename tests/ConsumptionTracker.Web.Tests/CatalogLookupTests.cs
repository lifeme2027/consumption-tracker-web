using System.Net;
using System.Security.Cryptography;
using System.Text;
using Microsoft.Data.Sqlite;

namespace ConsumptionTracker.Web.Tests;

/// <summary>POST /api/catalog/lookup：只读商品库查询。无需登录；不可用时 available:false 而不是报错；条码绝不进日志。</summary>
public class CatalogLookupTests : IDisposable
{
    private readonly string _dir = Path.Combine(Path.GetTempPath(), "life-catalog-" + Guid.NewGuid().ToString("N"));
    private readonly List<IDisposable> _apps = new();
    public void Dispose()
    {
        foreach (var a in _apps) a.Dispose();
        SqliteConnection.ClearAllPools();
        try { Directory.Delete(_dir, true); } catch { /* best effort */ }
    }

    private TestApp App(string? path, Dictionary<string, string?>? extra = null, string env = "Production")
    {
        var s = new Dictionary<string, string?>(extra ?? new());
        if (path != null) s["Life:Catalog:Path"] = path;
        var a = new TestApp { Settings = s, Environment = env };
        _apps.Add(a);
        return a;
    }
    private string Db(int rows = 3000) => SyntheticCatalog.Create(_dir, rows);

    private static HttpRequestMessage Lookup(string json, string contentType = "application/json")
    {
        var r = Http.Req(HttpMethod.Post, "/api/catalog/lookup");
        r.Content = new StringContent(json, Encoding.UTF8, contentType);
        return r;
    }
    private static string Body(string code) => System.Text.Json.JsonSerializer.Serialize(new { barcode = code });

    [Fact]
    public async Task Hit_ReturnsNameCategoryUnitSpecAndSalePrice_WithoutLogin_AndNeverCostOrOrigin()
    {
        var app = App(Db());
        var r = await app.CreateClient().SendAsync(Lookup(Body(SyntheticCatalog.HitCode)));   // 匿名、无 Cookie
        Assert.Equal(HttpStatusCode.OK, r.StatusCode);
        Assert.Contains("no-store", string.Join(",", r.Headers.CacheControl?.ToString()));
        var raw = await r.Content.ReadAsStringAsync();
        var j = System.Text.Json.JsonDocument.Parse(raw).RootElement;
        Assert.True(j.GetProperty("available").GetBoolean());
        Assert.True(j.GetProperty("found").GetBoolean());
        Assert.Equal("合成测试饮料", j.GetProperty("name").GetString());
        Assert.Equal("合成饮料", j.GetProperty("category").GetString());
        Assert.Equal("瓶", j.GetProperty("unit").GetString());
        Assert.Equal("500ml", j.GetProperty("spec").GetString());
        Assert.Equal(350, j.GetProperty("salePriceCents").GetInt64());
        Assert.DoesNotContain("cost", raw, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("origin", raw, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("合成产地", raw);
    }

    [Fact]
    public async Task NullSalePrice_IsNull_AndMiss_IsAvailableButNotFound_AndBarcodeIsTrimmed()
    {
        var app = App(Db());
        var c = app.CreateClient();
        var j = await (await c.SendAsync(Lookup(Body("  " + SyntheticCatalog.NoPriceCode + " ")))).J();
        Assert.True(j.GetProperty("found").GetBoolean());
        Assert.Equal(System.Text.Json.JsonValueKind.Null, j.GetProperty("salePriceCents").ValueKind);
        var miss = await (await c.SendAsync(Lookup(Body(SyntheticCatalog.MissCode)))).J();
        Assert.True(miss.GetProperty("available").GetBoolean());
        Assert.False(miss.GetProperty("found").GetBoolean());
        Assert.Equal("", miss.GetProperty("name").GetString());
    }

    [Fact]
    public async Task NotConfigured_And_MissingFile_And_WrongSchema_ReturnAvailableFalse_NeverThrow()
    {
        foreach (var path in new string?[] { null, "", Path.Combine(_dir, "nope", "catalog.db") })
        {
            var r = await App(path).CreateClient().SendAsync(Lookup(Body(SyntheticCatalog.HitCode)));
            Assert.Equal(HttpStatusCode.OK, r.StatusCode);
            var j = await r.J();
            Assert.False(j.GetProperty("available").GetBoolean());
            Assert.False(j.GetProperty("found").GetBoolean());
        }
        // 表结构不对（缺列 / 缺表 / 根本不是 SQLite）
        Directory.CreateDirectory(_dir);
        var bad = Path.Combine(_dir, "bad.db");
        using (var c = new SqliteConnection($"Data Source={bad};Pooling=False")) { c.Open(); using var cmd = c.CreateCommand(); cmd.CommandText = "CREATE TABLE catalog(barcode TEXT, title TEXT); CREATE TABLE other(x)"; cmd.ExecuteNonQuery(); }
        var notDb = Path.Combine(_dir, "garbage.db"); File.WriteAllText(notDb, "this is not a sqlite file");
        foreach (var path in new[] { bad, notDb })
        {
            var r = await App(path).CreateClient().SendAsync(Lookup(Body(SyntheticCatalog.HitCode)));
            Assert.Equal(HttpStatusCode.OK, r.StatusCode);
            Assert.False((await r.J()).GetProperty("available").GetBoolean());
        }
    }

    [Fact]
    public async Task BadInput_Gets400_Bilingual_Or415_Or405_AndGuardsStillApply()
    {
        var app = App(Db());
        var c = app.CreateClient();
        foreach (var body in new[] { "", "{}", "not json", "[]", "{\"barcode\":123}", "{\"barcode\":\"   \"}", "{\"barcode\":null}" })
        {
            var r = await c.SendAsync(Lookup(body));
            Assert.Equal(HttpStatusCode.BadRequest, r.StatusCode);
            var j = await r.J();
            Assert.False(string.IsNullOrWhiteSpace(j.GetProperty("error").GetString()));
            Assert.False(string.IsNullOrWhiteSpace(j.GetProperty("errorEn").GetString()));
        }
        var tooLong = await c.SendAsync(Lookup(Body(new string('9', 65))));
        Assert.Equal(HttpStatusCode.BadRequest, tooLong.StatusCode);
        Assert.Contains("64", (await tooLong.J()).GetProperty("errorEn").GetString());
        Assert.Equal(HttpStatusCode.OK, (await c.SendAsync(Lookup(Body(new string('9', 64))))).StatusCode);   // 恰好 64 字可以
        Assert.Equal(HttpStatusCode.UnsupportedMediaType, (await c.SendAsync(Lookup(Body("1"), "text/plain"))).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await c.SendAsync(Lookup("{\"barcode\":\"" + new string('1', 5000) + "\"}"))).StatusCode);   // 请求体上限 1KB
        // 条码不能走 URL：GET 不存在
        var get = await c.SendAsync(Http.Req(HttpMethod.Get, "/api/catalog/lookup?barcode=" + SyntheticCatalog.HitCode));
        Assert.Equal(HttpStatusCode.MethodNotAllowed, get.StatusCode);
        // 同源校验保持：缺少 X-Requested-With 的 POST 被拒；跨站 Origin 被拒
        var noHeader = new HttpRequestMessage(HttpMethod.Post, "/api/catalog/lookup") { Content = new StringContent(Body(SyntheticCatalog.HitCode), Encoding.UTF8, "application/json") };
        Assert.Equal(HttpStatusCode.Forbidden, (await c.SendAsync(noHeader)).StatusCode);
        var cross = Lookup(Body(SyntheticCatalog.HitCode)); cross.Headers.Add("Origin", "https://evil.example");
        Assert.Equal(HttpStatusCode.Forbidden, (await c.SendAsync(cross)).StatusCode);
    }

    [Fact]
    public async Task Lookup_NeverWrites_FileIdenticalAndNoJournalFiles_AndWorksOnReadOnlyFile()
    {
        var path = Db();
        var before = SHA256.HashData(File.ReadAllBytes(path));
        var app = App(path);
        var c = app.CreateClient();
        for (var i = 0; i < 20; i++) await c.SendAsync(Lookup(Body(i % 2 == 0 ? SyntheticCatalog.HitCode : SyntheticCatalog.MissCode)));
        Assert.Equal(before, SHA256.HashData(File.ReadAllBytes(path)));
        Assert.DoesNotContain(Directory.GetFiles(_dir), f => f != path);   // 没有 -wal / -shm / -journal
        // 即使文件被设成只读也能查
        File.SetAttributes(path, FileAttributes.ReadOnly);
        try
        {
            var j = await (await c.SendAsync(Lookup(Body(SyntheticCatalog.HitCode)))).J();
            Assert.True(j.GetProperty("found").GetBoolean());
        }
        finally { File.SetAttributes(path, FileAttributes.Normal); }
    }

    [Fact]
    public async Task SqlInjectionLikeBarcode_IsJustAMiss()
    {
        var app = App(Db());
        var j = await (await app.CreateClient().SendAsync(Lookup(Body("' OR 1=1 --")))).J();
        Assert.True(j.GetProperty("available").GetBoolean());
        Assert.False(j.GetProperty("found").GetBoolean());
        // 库仍在、没有被改动
        var ok = await (await app.CreateClient().SendAsync(Lookup(Body(SyntheticCatalog.HitCode)))).J();
        Assert.True(ok.GetProperty("found").GetBoolean());
    }

    [Fact]
    public async Task OwnRateLimitTier_ExhaustingCatalogDoesNotBlockOtherApi_AndViceVersa()
    {
        var app = App(Db(), new() { ["Life:Limits:CatalogPerMinute"] = "3", ["Life:Limits:ApiPerMinute"] = "1000" });
        var c = app.CreateClient();
        for (var i = 0; i < 3; i++) Assert.Equal(HttpStatusCode.OK, (await c.SendAsync(Lookup(Body(SyntheticCatalog.HitCode)))).StatusCode);
        var limited = await c.SendAsync(Lookup(Body(SyntheticCatalog.HitCode)));
        Assert.Equal(HttpStatusCode.TooManyRequests, limited.StatusCode);
        Assert.NotEqual(HttpStatusCode.TooManyRequests, (await c.SendAsync(Http.Req(HttpMethod.Get, "/api/records/x"))).StatusCode);   // 其它 API 档位不受影响（401 即可）
        app.Clock.Advance(TimeSpan.FromMinutes(2));
        Assert.Equal(HttpStatusCode.OK, (await c.SendAsync(Lookup(Body(SyntheticCatalog.HitCode)))).StatusCode);
    }

    [Fact]
    public void DefaultCatalogLimit_Is600_AndCatalogIsOffByDefault()
    {
        var o = new LifeOptions();
        Assert.Equal(600, o.Limits.CatalogPerMinute);
        Assert.Equal("", o.Catalog.Path);
    }

    /// <summary>隐私红线：Trace 级别抓全部日志，做各种查询（命中/未命中/非法/库不可用/超长/限流），日志里不得出现条码。</summary>
    [Theory]
    [InlineData("Production")]
    [InlineData("Development")]
    public async Task Barcode_NeverAppearsInAnyLog_EvenAtTraceLevel(string env)
    {
        var secret = "7712" + Guid.NewGuid().ToString("N").Substring(0, 9);     // 本用例独有的“条码”，同时也建进库里（命中）
        var path = Db();
        using (var w = new SqliteConnection($"Data Source={path};Pooling=False"))
        {
            w.Open(); using var cmd = w.CreateCommand();
            cmd.CommandText = "INSERT INTO catalog(barcode,name,category,unit,sale_price_cents) VALUES($b,'合成日志测试','合成',' 个',100)";
            cmd.Parameters.AddWithValue("$b", secret); cmd.ExecuteNonQuery();
        }
        var ghost = "8813" + Guid.NewGuid().ToString("N").Substring(0, 9);        // 未命中的条码
        var app = App(path, new() { ["Life:Limits:CatalogPerMinute"] = "12", ["Logging:LogLevel:Default"] = "Trace", ["Logging:LogLevel:Microsoft.AspNetCore"] = "Trace" }, env);
        var c = app.CreateClient();
        await c.SendAsync(Lookup(Body(secret)));
        await c.SendAsync(Lookup(Body(ghost)));
        await c.SendAsync(Lookup(Body(" " + secret + " ")));
        await c.SendAsync(Lookup("{\"barcode\":" + secret + "}"));                // 数字而不是字符串
        await c.SendAsync(Lookup(secret));                                         // 根本不是 JSON（框架的 JSON 错误消息可能带出字符）
        await c.SendAsync(Lookup("{\"barcode\":\"" + secret + "\"", "application/json"));   // 截断的 JSON
        await c.SendAsync(Lookup(Body(secret), "text/plain"));                    // 415 路径
        await c.SendAsync(Lookup(Body(secret + new string('0', 80))));            // 超长
        await c.SendAsync(Lookup("{\"barcode\":\"" + secret + new string('1', 3000) + "\"}"));   // 超过 1KB 的请求体
        var bad = Lookup(Body(secret)); bad.Headers.Add("Origin", "https://evil.example");
        await c.SendAsync(bad);
        for (var i = 0; i < 12; i++) await c.SendAsync(Lookup(Body(secret)));    // 触发 429
        // 库不可用的路径（异常被吞）
        using var broken = App(Path.Combine(_dir, "garbage.db"), new() { ["Logging:LogLevel:Default"] = "Trace", ["Logging:LogLevel:Microsoft.AspNetCore"] = "Trace" });
        File.WriteAllText(Path.Combine(_dir, "garbage.db"), "not sqlite");
        await broken.CreateClient().SendAsync(Lookup(Body(secret)));

        foreach (var a in new[] { app, broken })
        {
            string[] lines; lock (a.Logs.Lines) lines = a.Logs.Lines.ToArray();
            Assert.NotEmpty(lines);   // 确认日志抓取本身有效（Trace 级别下框架会有很多行）
            Assert.DoesNotContain(lines, l => l.Contains(secret) || l.Contains(ghost));
        }
    }

    [Fact]
    public void CatalogSourceFiles_DoNotUseLogging_OrEmbedBarcodeInMessages()
    {
        var root = FindRepoRoot();
        foreach (var f in new[] { "Catalog/CatalogLookup.cs", "Api/CatalogEndpoint.cs" })
        {
            var src = File.ReadAllText(Path.Combine(root, "src", "ConsumptionTracker.Web", f));
            foreach (var banned in new[] { "ILogger", "LogInformation", "LogDebug", "LogWarning", "LogError", "Console.", "Trace.", "Debug.", "ex.Message", "e.Message", "throw new" })
                Assert.DoesNotContain(banned, src);
        }
    }

    private static string FindRepoRoot()
    {
        var d = new DirectoryInfo(AppContext.BaseDirectory);
        while (d != null && !File.Exists(Path.Combine(d.FullName, "ConsumptionTracker.Web.sln"))) d = d.Parent;
        return d?.FullName ?? throw new InvalidOperationException("repo root not found");
    }
}
