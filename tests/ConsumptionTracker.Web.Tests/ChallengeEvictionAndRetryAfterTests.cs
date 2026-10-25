using System.Net;
using System.Text.Json;

namespace ConsumptionTracker.Web.Tests;

/// <summary>M-2：待签名挑战达上限时淘汰最旧的未使用挑战，而不是拒绝；L-1/L-4：429 带真实 Retry-After 与中英文正文。</summary>
public class ChallengeEvictionAndRetryAfterTests
{
    private static async Task<(string nonce, string message)> Ch(HttpClient c, string address)
    {
        var r = await c.Post("/api/auth/challenge", new { address });
        Assert.Equal(HttpStatusCode.OK, r.StatusCode);
        var j = await r.J();
        return (j.GetProperty("nonce").GetString()!, j.GetProperty("message").GetString()!);
    }

    private static async Task<HttpStatusCode> Verify(HttpClient c, TestWallet w, string nonce, string message) =>
        (await c.Post("/api/auth/verify", new { address = w.Address, nonce, signature = w.Sign(message) })).StatusCode;

    [Fact]
    public async Task PerAddress_Cap_EvictsOldest_InsteadOfRejecting()
    {
        using var app = new TestApp();
        var c = app.NewClient();
        var w = new TestWallet();
        var all = new List<(string nonce, string message)>();
        for (var i = 0; i < 6; i++) all.Add(await Ch(c, w.Address)); // 第 6 个不再是 429
        Assert.Equal(HttpStatusCode.Unauthorized, await Verify(c, w, all[0].nonce, all[0].message)); // 最旧的被淘汰
        Assert.Equal(HttpStatusCode.OK, await Verify(c, w, all[5].nonce, all[5].message));           // 最新的可用
        Assert.Equal(HttpStatusCode.OK, await Verify(c, w, all[1].nonce, all[1].message));           // 其余也可用
    }

    [Fact]
    public async Task PerAddress_Eviction_OnlyAffectsThatAddress()
    {
        using var app = new TestApp();
        var c = app.NewClient();
        var other = new TestWallet(); var w = new TestWallet();
        var o = await Ch(c, other.Address);
        for (var i = 0; i < 7; i++) await Ch(c, w.Address);
        Assert.Equal(HttpStatusCode.OK, await Verify(c, other, o.nonce, o.message));
    }

    [Fact]
    public async Task Global_Cap_EvictsOldest_InsteadOfRejecting()
    {
        using var app = new TestApp { Settings = { ["Life:Auth:MaxPendingChallenges"] = "3" } };
        var c = app.NewClient();
        var ws = Enumerable.Range(0, 5).Select(_ => new TestWallet()).ToArray();
        var cs = new List<(string nonce, string message)>();
        foreach (var w in ws) cs.Add(await Ch(c, w.Address));  // 第 4、5 个不再被拒
        Assert.Equal(HttpStatusCode.Unauthorized, await Verify(c, ws[0], cs[0].nonce, cs[0].message));
        Assert.Equal(HttpStatusCode.Unauthorized, await Verify(c, ws[1], cs[1].nonce, cs[1].message));
        Assert.Equal(HttpStatusCode.OK, await Verify(c, ws[4], cs[4].nonce, cs[4].message));
        Assert.Equal(HttpStatusCode.OK, await Verify(c, ws[2], cs[2].nonce, cs[2].message));
    }

    [Fact]
    public async Task ExpiredChallenges_AreDropped_BeforeEvictingLiveOnes()
    {
        using var app = new TestApp();
        var c = app.NewClient();
        var w = new TestWallet();
        for (var i = 0; i < 5; i++) await Ch(c, w.Address);
        app.Clock.Advance(TimeSpan.FromSeconds(301)); // 全部过期
        var fresh = await Ch(c, w.Address);
        Assert.Equal(HttpStatusCode.OK, await Verify(c, w, fresh.nonce, fresh.message));
    }

    private static async Task<(HttpResponseMessage r, JsonElement body)> Rejected(HttpClient c)
    {
        var r = await c.Post("/api/auth/challenge", new { address = new TestWallet().Address });
        Assert.Equal(HttpStatusCode.TooManyRequests, r.StatusCode);
        return (r, await r.J());
    }

    [Fact]
    public async Task RateLimit_429_HasRealRetryAfter_AndBilingualBody()
    {
        using var app = new TestApp { Settings = { ["Life:Limits:ChallengePerMinute"] = "3" } };
        var c = app.NewClient();
        for (var i = 0; i < 3; i++) await Ch(c, new TestWallet().Address);

        var (r1, b1) = await Rejected(c);
        var h1 = int.Parse(r1.Headers.GetValues("Retry-After").Single());
        Assert.InRange(h1, 1, 60);
        Assert.Equal(h1, b1.GetProperty("retryAfterSeconds").GetInt32());
        Assert.Contains("请求过于频繁", b1.GetProperty("error").GetString());
        Assert.Contains("Too many requests", b1.GetProperty("errorEn").GetString());
        Assert.Contains(h1.ToString(), b1.GetProperty("errorEn").GetString());

        app.Clock.Advance(TimeSpan.FromSeconds(20));
        var (r2, b2) = await Rejected(c);
        var h2 = int.Parse(r2.Headers.GetValues("Retry-After").Single());
        Assert.True(h2 < h1, $"Retry-After 应随时间递减：{h1} → {h2}");
        Assert.Equal(40, h2);
        Assert.Equal(h2, b2.GetProperty("retryAfterSeconds").GetInt32());
    }

    [Fact]
    public async Task RateLimit_WindowResets_AfterRetryAfter()
    {
        using var app = new TestApp { Settings = { ["Life:Limits:ChallengePerMinute"] = "2" } };
        var c = app.NewClient();
        for (var i = 0; i < 2; i++) await Ch(c, new TestWallet().Address);
        var (r, _) = await Rejected(c);
        app.Clock.Advance(TimeSpan.FromSeconds(int.Parse(r.Headers.GetValues("Retry-After").Single())));
        await Ch(c, new TestWallet().Address); // 等够 Retry-After 之后确实放行
    }

    [Fact]
    public async Task RateLimit_Api_And_Verify_Also_CarryRetryAfter()
    {
        using var app = new TestApp { Settings = { ["Life:Limits:VerifyPerMinute"] = "1", ["Life:Limits:ApiPerMinute"] = "2" } };
        var c = app.NewClient();
        await c.Post("/api/auth/verify", new { address = new TestWallet().Address, nonce = "x", signature = "y" });
        var v = await c.Post("/api/auth/verify", new { address = new TestWallet().Address, nonce = "x", signature = "y" });
        Assert.Equal(HttpStatusCode.TooManyRequests, v.StatusCode);
        Assert.InRange(int.Parse(v.Headers.GetValues("Retry-After").Single()), 1, 60);

        HttpResponseMessage? last = null;
        for (var i = 0; i < 4; i++) last = await c.SendAsync(Http.Req(HttpMethod.Get, "/api/meta")); // 未登录的 401 也计入 api 桶
        Assert.Equal(HttpStatusCode.TooManyRequests, last!.StatusCode);
        Assert.InRange(int.Parse(last.Headers.GetValues("Retry-After").Single()), 1, 60);
    }
}
