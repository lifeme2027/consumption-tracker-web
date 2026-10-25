using System.Net;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text.Json;
using ConsumptionTracker.Web;
using ConsumptionTracker.Web.Auth;
using ConsumptionTracker.Web.Kaspa;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;

namespace ConsumptionTracker.Web.Tests;

/// <summary>可手动拨动的时钟（测试挑战/会话过期）。</summary>
public sealed class TestClock : TimeProvider
{
    private DateTimeOffset _now = new(2026, 10, 25, 2, 0, 0, TimeSpan.Zero);
    public override DateTimeOffset GetUtcNow() => _now;
    public void Advance(TimeSpan t) => _now += t;
}

/// <summary>测试用「钱包」：随机私钥 → 主网 Schnorr 地址，可对消息签名（与 KasWare schnorr 签名同构）。</summary>
public sealed class TestWallet
{
    public byte[] Private { get; } = RandomNumberGenerator.GetBytes(32);
    public string Address { get; }
    public TestWallet() => Address = KaspaMessageSigner.AddressFromXOnly(KaspaMessageSigner.XOnlyPublicKey(Private), "mainnet");
    public string Sign(string message) => Convert.ToBase64String(KaspaMessageSigner.Sign(message, Private));
}

public sealed class LogCapture : ILoggerProvider
{
    public List<string> Lines { get; } = new();
    public ILogger CreateLogger(string categoryName) => new L(this);
    public void Dispose() { }
    private sealed class L(LogCapture o) : ILogger
    {
        public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;
        public bool IsEnabled(LogLevel logLevel) => true;
        public void Log<TState>(LogLevel logLevel, EventId eventId, TState state, Exception? exception, Func<TState, Exception?, string> formatter)
        {
            lock (o.Lines) o.Lines.Add(formatter(state, exception) + (exception?.ToString() ?? ""));
        }
    }
}

public sealed class TestApp : WebApplicationFactory<Program>
{
    public string DataDir { get; }
    public TestApp(string? sharedDir = null) =>
        DataDir = sharedDir ?? Path.Combine(Path.GetTempPath(), "life-tests-" + Guid.NewGuid().ToString("N"));
    public TestClock Clock { get; } = new();
    public LogCapture Logs { get; } = new();
    public string Environment { get; init; } = "Production";
    public Dictionary<string, string?> Settings { get; init; } = new();

    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        builder.UseEnvironment(Environment);
        builder.UseSetting("Life:Storage:DataDir", DataDir);
        builder.UseSetting("Life:Cookie:RequireSecure", "false"); // 测试走 http
        foreach (var (k, v) in Settings) builder.UseSetting(k, v);
        builder.ConfigureServices(s =>
        {
            s.AddSingleton<TimeProvider>(Clock);
        });
        builder.ConfigureLogging(l => { l.ClearProviders(); l.SetMinimumLevel(LogLevel.Trace); l.AddProvider(Logs); });
    }

    public HttpClient NewClient() => CreateClient(new WebApplicationFactoryClientOptions { AllowAutoRedirect = false, HandleCookies = true });

    protected override void Dispose(bool disposing)
    {
        base.Dispose(disposing);
        // 只清自己这个库的连接池；全局 ClearAllPools 会在并行测试之间互相关掉对方的连接（共享静态状态）
        ConsumptionTracker.Web.Storage.Database.ClearPoolFor(Path.Combine(DataDir, "life.db"));
        try { Directory.Delete(DataDir, true); } catch { /* best effort */ }
    }
}

public static class Http
{
    public static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    public static HttpRequestMessage Req(HttpMethod m, string url, object? body = null)
    {
        var r = new HttpRequestMessage(m, url);
        r.Headers.Add("X-Requested-With", "life-web");
        if (body != null) r.Content = JsonContent.Create(body, options: Json);
        return r;
    }

    public static Task<HttpResponseMessage> Post(this HttpClient c, string url, object? body = null) => c.SendAsync(Req(HttpMethod.Post, url, body));
    public static Task<HttpResponseMessage> Put(this HttpClient c, string url, object? body) => c.SendAsync(Req(HttpMethod.Put, url, body));
    public static Task<HttpResponseMessage> Del(this HttpClient c, string url) => c.SendAsync(Req(HttpMethod.Delete, url));

    public static async Task<JsonElement> J(this HttpResponseMessage r)
    {
        var s = await r.Content.ReadAsStringAsync();
        return JsonDocument.Parse(s).RootElement.Clone();
    }

    /// <summary>走完整的 挑战 → 签名 → 验证 流程，返回已登录的 client。</summary>
    public static async Task<HttpClient> LoginAsync(this TestApp app, TestWallet w)
    {
        var c = app.CreateClient(new WebApplicationFactoryClientOptions { AllowAutoRedirect = false, HandleCookies = false });
        var ch = await (await c.Post("/api/auth/challenge", new { address = w.Address })).J();
        var message = ch.GetProperty("message").GetString()!;
        var resp = await c.Post("/api/auth/verify", new { address = w.Address, nonce = ch.GetProperty("nonce").GetString(), signature = w.Sign(message) });
        Assert.Equal(HttpStatusCode.OK, resp.StatusCode);
        var setCookie = resp.Headers.GetValues("Set-Cookie").Single();
        var token = setCookie.Split(';')[0].Split('=', 2)[1];
        c.DefaultRequestHeaders.Add("Cookie", "ct_session=" + token); // 手动带 Cookie，便于测试读取/篡改 token
        return c;
    }

    public static string SessionToken(this HttpClient c) =>
        c.DefaultRequestHeaders.GetValues("Cookie").Single().Split('=', 2)[1];

    public static object Rec(string name = "阿莫西林", long priceCents = 1250, decimal qty = 2, string cat = "药品",
        string date = "2026-10-20", string barcode = "6901234567890", string batch = "", string patient = "", string dosage = "", string note = "") =>
        new { barcode, name, priceCents, quantity = qty, category = cat, note, date, batchName = batch, patient, dosage };

    public static async Task<string> AddAsync(this HttpClient c, object rec)
    {
        var r = await c.Post("/api/records", rec);
        Assert.Equal(HttpStatusCode.Created, r.StatusCode);
        return (await r.J()).GetProperty("id").GetString()!;
    }
}
