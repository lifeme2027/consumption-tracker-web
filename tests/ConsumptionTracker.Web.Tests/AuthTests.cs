using System.Net;
using System.Text.Json;

namespace ConsumptionTracker.Web.Tests;

public class AuthTests : IDisposable
{
    private readonly TestApp _app = new();
    public void Dispose() => _app.Dispose();

    private static async Task<(string nonce, string message)> Challenge(HttpClient c, string address)
    {
        var r = await c.Post("/api/auth/challenge", new { address });
        Assert.Equal(HttpStatusCode.OK, r.StatusCode);
        var j = await r.J();
        return (j.GetProperty("nonce").GetString()!, j.GetProperty("message").GetString()!);
    }

    [Fact]
    public async Task FullFlow_ChallengeSignVerify_ThenMe()
    {
        var w = new TestWallet();
        var c = _app.NewClient();
        Assert.Equal(HttpStatusCode.Unauthorized, (await c.GetAsync("/api/auth/me")).StatusCode);

        var (nonce, message) = await Challenge(c, w.Address);
        Assert.Contains(w.Address, message);
        Assert.Contains(nonce, message);
        Assert.Contains("life.kastop.com", message);

        var v = await c.Post("/api/auth/verify", new { address = w.Address, nonce, signature = w.Sign(message) });
        Assert.Equal(HttpStatusCode.OK, v.StatusCode);
        var me = await (await c.GetAsync("/api/auth/me")).J();
        Assert.Equal(w.Address, me.GetProperty("address").GetString());
    }

    [Fact]
    public async Task Cookie_IsHttpOnly_SameSiteStrict_AndSecureWhenRequired()
    {
        using var secure = new TestApp { Settings = { ["Life:Cookie:RequireSecure"] = "true" } };
        var w = new TestWallet();
        var c = secure.NewClient();
        var (nonce, message) = await Challenge(c, w.Address);
        var v = await c.Post("/api/auth/verify", new { address = w.Address, nonce, signature = w.Sign(message) });
        var cookie = v.Headers.GetValues("Set-Cookie").Single();
        Assert.Contains("httponly", cookie, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("samesite=strict", cookie, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("secure", cookie, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("expires=", cookie, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("domain=", cookie, StringComparison.OrdinalIgnoreCase);
        // 响应体不返回 token（只在 HttpOnly Cookie 中）
        Assert.False((await v.J()).TryGetProperty("token", out _));
    }

    [Fact]
    public async Task Challenge_RejectsBadAddresses()
    {
        var c = _app.NewClient();
        foreach (var bad in new[] { "", "kaspa:qxyz", "hello", "kaspatest:qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq" })
            Assert.Equal(HttpStatusCode.BadRequest, (await c.Post("/api/auth/challenge", new { address = bad })).StatusCode);
        var w = new TestWallet();
        var badChecksum = w.Address[..^1] + (w.Address[^1] == 'q' ? 'p' : 'q');
        var r = await c.Post("/api/auth/challenge", new { address = badChecksum });
        Assert.Equal(HttpStatusCode.BadRequest, r.StatusCode);
        Assert.Contains("校验和", (await r.J()).GetProperty("error").GetString());
    }

    [Fact]
    public async Task Verify_WrongSignature_Fails_AndBurnsChallenge()
    {
        var w = new TestWallet(); var mallory = new TestWallet();
        var c = _app.NewClient();
        var (nonce, message) = await Challenge(c, w.Address);
        // mallory 用自己的钥匙签 → 失败
        var bad = await c.Post("/api/auth/verify", new { address = w.Address, nonce, signature = mallory.Sign(message) });
        Assert.Equal(HttpStatusCode.Unauthorized, bad.StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await c.GetAsync("/api/auth/me")).StatusCode);
        // nonce 已作废：即使随后给出正确签名也不行
        var good = await c.Post("/api/auth/verify", new { address = w.Address, nonce, signature = w.Sign(message) });
        Assert.Equal(HttpStatusCode.Unauthorized, good.StatusCode);
    }

    [Fact]
    public async Task Verify_SignatureOfDifferentMessage_Fails()
    {
        var w = new TestWallet();
        var c = _app.NewClient();
        var (nonce, _) = await Challenge(c, w.Address);
        var r = await c.Post("/api/auth/verify", new { address = w.Address, nonce, signature = w.Sign("我自己编的消息") });
        Assert.Equal(HttpStatusCode.Unauthorized, r.StatusCode);
    }

    [Fact]
    public async Task ChallengeReplay_SecondUseIsRejected()
    {
        var w = new TestWallet();
        var c1 = _app.NewClient(); var c2 = _app.NewClient();
        var (nonce, message) = await Challenge(c1, w.Address);
        var sig = w.Sign(message);
        Assert.Equal(HttpStatusCode.OK, (await c1.Post("/api/auth/verify", new { address = w.Address, nonce, signature = sig })).StatusCode);
        // 攻击者截获 nonce + 签名后重放
        var replay = await c2.Post("/api/auth/verify", new { address = w.Address, nonce, signature = sig });
        Assert.Equal(HttpStatusCode.Unauthorized, replay.StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await c2.GetAsync("/api/auth/me")).StatusCode);
    }

    [Fact]
    public async Task ExpiredChallenge_IsRejected()
    {
        var w = new TestWallet();
        var c = _app.NewClient();
        var (nonce, message) = await Challenge(c, w.Address);
        _app.Clock.Advance(TimeSpan.FromSeconds(301));
        var r = await c.Post("/api/auth/verify", new { address = w.Address, nonce, signature = w.Sign(message) });
        Assert.Equal(HttpStatusCode.Unauthorized, r.StatusCode);
    }

    [Fact]
    public async Task Challenge_BoundToAddress_OtherAddressCannotUseIt()
    {
        var a = new TestWallet(); var b = new TestWallet();
        var c = _app.NewClient();
        var (nonce, message) = await Challenge(c, a.Address);
        // B 拿 A 的 nonce，用 B 的地址 + B 对 A 的消息的签名来登录
        var r = await c.Post("/api/auth/verify", new { address = b.Address, nonce, signature = b.Sign(message) });
        Assert.Equal(HttpStatusCode.Unauthorized, r.StatusCode);
    }

    [Fact]
    public async Task Verify_UnknownNonce_And_ClientSuppliedMessage_Rejected()
    {
        var w = new TestWallet();
        var c = _app.NewClient();
        var r = await c.Post("/api/auth/verify", new { address = w.Address, nonce = "deadbeef", signature = w.Sign("x"), message = "x" });
        Assert.Equal(HttpStatusCode.Unauthorized, r.StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await c.Post("/api/auth/verify", new { address = w.Address })).StatusCode);
    }

    [Fact]
    public async Task ForgedAndGarbageTokens_Rejected()
    {
        foreach (var token in new[] { "", "abc", new string('A', 43), "../../etc/passwd", new string('x', 500), "' OR 1=1 --" })
        {
            var c = _app.CreateClient(new() { HandleCookies = false });
            var req = new HttpRequestMessage(HttpMethod.Post, "/api/records/query") { Content = JsonContent(new { }) };
            req.Headers.Add("X-Requested-With", "life-web");
            req.Headers.Add("Cookie", "ct_session=" + token);
            Assert.Equal(HttpStatusCode.Unauthorized, (await c.SendAsync(req)).StatusCode);
        }
    }

    [Fact]
    public async Task TokenOfAnotherAddress_CannotBeBuiltFromHash_AndTamperedTokenFails()
    {
        var w = new TestWallet();
        var c = await _app.LoginAsync(w);
        Assert.Equal(HttpStatusCode.OK, (await c.GetAsync("/api/auth/me")).StatusCode);

        // 取出真实 token，改一个字符 → 必须失效
        var handlerCookie = await GetCookie(c);
        var tampered = handlerCookie[..^1] + (handlerCookie[^1] == 'A' ? 'B' : 'A');
        var c2 = _app.CreateClient(new() { HandleCookies = false });
        var req = new HttpRequestMessage(HttpMethod.Get, "/api/auth/me");
        req.Headers.Add("Cookie", "ct_session=" + tampered);
        Assert.Equal(HttpStatusCode.Unauthorized, (await c2.SendAsync(req)).StatusCode);
    }

    [Fact]
    public async Task Session_ExpiresAfterLifetime()
    {
        var w = new TestWallet();
        var c = await _app.LoginAsync(w);
        Assert.Equal(HttpStatusCode.OK, (await c.GetAsync("/api/auth/me")).StatusCode);
        _app.Clock.Advance(TimeSpan.FromHours(11));
        Assert.Equal(HttpStatusCode.OK, (await c.GetAsync("/api/auth/me")).StatusCode);
        _app.Clock.Advance(TimeSpan.FromHours(2));
        Assert.Equal(HttpStatusCode.Unauthorized, (await c.GetAsync("/api/auth/me")).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await c.Post("/api/records/query", new { })).StatusCode);
    }

    [Fact]
    public async Task Logout_RevokesSession_EvenIfCookieIsReused()
    {
        var w = new TestWallet();
        var c = await _app.LoginAsync(w);
        var token = await GetCookie(c);
        Assert.Equal(HttpStatusCode.OK, (await c.Post("/api/auth/logout")).StatusCode);
        var c2 = _app.CreateClient(new() { HandleCookies = false });
        var req = new HttpRequestMessage(HttpMethod.Get, "/api/auth/me");
        req.Headers.Add("Cookie", "ct_session=" + token);
        Assert.Equal(HttpStatusCode.Unauthorized, (await c2.SendAsync(req)).StatusCode);
    }

    [Fact]
    public async Task Session_SurvivesRestart_ChallengeDoesNot()
    {
        var w = new TestWallet();
        var c = await _app.LoginAsync(w);
        var token = await GetCookie(c);
        var (nonce, message) = await Challenge(_app.NewClient(), w.Address);
        // 第二个应用实例复用同一个数据目录 = 进程重启
        using var restarted = new TestApp(sharedDir: _app.DataDir);
        var c2 = restarted.CreateClient(new() { HandleCookies = false });
        var req = new HttpRequestMessage(HttpMethod.Get, "/api/auth/me");
        req.Headers.Add("Cookie", "ct_session=" + token);
        Assert.Equal(HttpStatusCode.OK, (await c2.SendAsync(req)).StatusCode);
        var r = await c2.Post("/api/auth/verify", new { address = w.Address, nonce, signature = w.Sign(message) });
        Assert.Equal(HttpStatusCode.Unauthorized, r.StatusCode);
    }

    [Fact]
    public async Task TooManyPendingChallenges_PerAddress_Rejected()
    {
        var w = new TestWallet();
        var c = _app.NewClient();
        for (var i = 0; i < 5; i++) Assert.Equal(HttpStatusCode.OK, (await c.Post("/api/auth/challenge", new { address = w.Address })).StatusCode);
        Assert.Equal(HttpStatusCode.TooManyRequests, (await c.Post("/api/auth/challenge", new { address = w.Address })).StatusCode);
    }

    [Fact]
    public async Task RateLimit_Challenge_PerIp()
    {
        using var app = new TestApp { Settings = { ["Life:Limits:ChallengePerMinute"] = "3" } };
        var c = app.NewClient();
        var codes = new List<HttpStatusCode>();
        for (var i = 0; i < 5; i++) codes.Add((await c.Post("/api/auth/challenge", new { address = new TestWallet().Address })).StatusCode);
        Assert.Equal(new[] { HttpStatusCode.OK, HttpStatusCode.OK, HttpStatusCode.OK, HttpStatusCode.TooManyRequests, HttpStatusCode.TooManyRequests }, codes);
    }

    [Fact]
    public async Task RateLimit_Verify_PerIp()
    {
        using var app = new TestApp { Settings = { ["Life:Limits:VerifyPerMinute"] = "2" } };
        var c = app.NewClient();
        var w = new TestWallet();
        var codes = new List<HttpStatusCode>();
        for (var i = 0; i < 3; i++) codes.Add((await c.Post("/api/auth/verify", new { address = w.Address, nonce = "x", signature = "y" })).StatusCode);
        Assert.Equal(HttpStatusCode.TooManyRequests, codes[2]);
    }

    // ---- 开发后门开关 ----

    [Fact]
    public async Task DevLogin_DoesNotExistInProduction_EvenIfConfigured()
    {
        using var app = new TestApp { Environment = "Production", Settings = { ["Life:Auth:DevLogin"] = "true" } };
        var c = app.NewClient();
        var w = new TestWallet();
        var r = await c.Post("/api/auth/dev-login", new { address = w.Address });
        Assert.Equal(HttpStatusCode.NotFound, r.StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await c.GetAsync("/api/auth/me")).StatusCode);
        Assert.False((await (await c.GetAsync("/api/config")).J()).GetProperty("devLogin").GetBoolean());
    }

    [Fact]
    public async Task DevLogin_DisabledByDefault_EvenInDevelopment()
    {
        using var app = new TestApp { Environment = "Development" };
        var r = await app.NewClient().Post("/api/auth/dev-login", new { address = new TestWallet().Address });
        Assert.Equal(HttpStatusCode.NotFound, r.StatusCode);
    }

    [Fact]
    public async Task DevLogin_WorksOnlyInDevelopmentWithSwitch_AndStillValidatesAddress()
    {
        using var app = new TestApp { Environment = "Development", Settings = { ["Life:Auth:DevLogin"] = "true" } };
        var c = app.NewClient();
        Assert.Equal(HttpStatusCode.BadRequest, (await c.Post("/api/auth/dev-login", new { address = "kaspa:qbad" })).StatusCode);
        var w = new TestWallet();
        Assert.Equal(HttpStatusCode.OK, (await c.Post("/api/auth/dev-login", new { address = w.Address })).StatusCode);
        Assert.Equal(w.Address, (await (await c.GetAsync("/api/auth/me")).J()).GetProperty("address").GetString());
    }

    [Fact]
    public void ProductionAppsettings_HasDevLoginOff()
    {
        var path = Path.Combine(AppContext.BaseDirectory, "appsettings.json");
        using var doc = JsonDocument.Parse(File.ReadAllText(path));
        Assert.False(doc.RootElement.GetProperty("Life").GetProperty("Auth").GetProperty("DevLogin").GetBoolean());
        Assert.True(doc.RootElement.GetProperty("Life").GetProperty("Cookie").GetProperty("RequireSecure").GetBoolean());
    }

    // helpers
    private static StringContent JsonContent(object o) => new(JsonSerializer.Serialize(o), System.Text.Encoding.UTF8, "application/json");

    private static async Task<string> GetCookie(HttpClient c)
    {
        await Task.CompletedTask;
        return c.SessionToken();
    }
}
