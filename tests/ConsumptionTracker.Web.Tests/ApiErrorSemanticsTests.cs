using System.Net;
using System.Net.Http.Headers;
using System.Text;

namespace ConsumptionTracker.Web.Tests;

/// <summary>L-10：错误语义——错方法 405(+Allow)、错 Content-Type 415、未知路径 404，且 400/413/415 都带中英文正文。</summary>
public class ApiErrorSemanticsTests : IDisposable
{
    private readonly TestApp _app = new();
    public void Dispose() => _app.Dispose();

    private static async Task AssertBilingual(HttpResponseMessage r)
    {
        Assert.StartsWith("application/json", r.Content.Headers.ContentType?.MediaType ?? "");
        var j = await r.J();
        Assert.False(string.IsNullOrWhiteSpace(j.GetProperty("error").GetString()));
        Assert.False(string.IsNullOrWhiteSpace(j.GetProperty("errorEn").GetString()));
    }

    [Theory]
    [InlineData("GET", "/api/auth/challenge", "POST")]
    [InlineData("GET", "/api/auth/verify", "POST")]
    [InlineData("PUT", "/api/auth/logout", "POST")]
    [InlineData("POST", "/api/auth/me", "GET")]
    [InlineData("DELETE", "/api/export.json", "GET")]
    public async Task WrongMethod_Is405_WithAllowHeader_AndBilingualBody(string method, string url, string allowed)
    {
        var c = _app.NewClient();
        var r = await c.SendAsync(Http.Req(new HttpMethod(method), url));
        Assert.Equal(HttpStatusCode.MethodNotAllowed, r.StatusCode);
        Assert.Contains(allowed, r.Content.Headers.Allow.Concat(r.Headers.TryGetValues("Allow", out var v) ? v : Array.Empty<string>()));
        await AssertBilingual(r);
    }

    [Fact]
    public async Task WrongMethod_On_RecordsId_ListsBothMethods()
    {
        var c = _app.NewClient();
        var r = await c.SendAsync(Http.Req(HttpMethod.Post, "/api/records/abc"));
        // POST /records/{id} 不存在，但 GET/DELETE（以及更新用的方法）存在
        Assert.Equal(HttpStatusCode.MethodNotAllowed, r.StatusCode);
        var allow = string.Join(",", r.Content.Headers.Allow);
        Assert.Contains("GET", allow); Assert.Contains("DELETE", allow);
    }

    [Theory]
    [InlineData("text/plain")]
    [InlineData("application/x-www-form-urlencoded")]
    [InlineData("application/xml")]
    public async Task WrongContentType_Is415_WithBilingualBody(string contentType)
    {
        var c = _app.NewClient();
        var req = Http.Req(HttpMethod.Post, "/api/auth/challenge");
        req.Content = new StringContent("{}", Encoding.UTF8, new MediaTypeHeaderValue(contentType));
        var r = await c.SendAsync(req);
        Assert.Equal(HttpStatusCode.UnsupportedMediaType, r.StatusCode);
        await AssertBilingual(r);
        Assert.Contains("application/json", (await r.J()).GetProperty("errorEn").GetString());
    }

    [Fact]
    public async Task UnknownApiPath_Is404_Bilingual()
    {
        var c = _app.NewClient();
        var r = await c.SendAsync(Http.Req(HttpMethod.Get, "/api/definitely/not/here"));
        Assert.Equal(HttpStatusCode.NotFound, r.StatusCode);
        await AssertBilingual(r);
        Assert.Contains("接口不存在", (await r.J()).GetProperty("error").GetString());
    }

    [Fact]
    public async Task MalformedJson_Is400_WithBilingualBody()
    {
        var c = _app.NewClient();
        var req = Http.Req(HttpMethod.Post, "/api/auth/challenge");
        req.Content = new StringContent("{bad", Encoding.UTF8, "application/json");
        var r = await c.SendAsync(req);
        Assert.Equal(HttpStatusCode.BadRequest, r.StatusCode);
        await AssertBilingual(r);
    }

    [Fact]
    public async Task EmptyJsonBody_Is400_WithBilingualBody()
    {
        var c = _app.NewClient();
        var req = Http.Req(HttpMethod.Post, "/api/auth/challenge");
        req.Content = new StringContent("", Encoding.UTF8, "application/json");
        var r = await c.SendAsync(req);
        Assert.Equal(HttpStatusCode.BadRequest, r.StatusCode);
        await AssertBilingual(r);
    }

    // TestServer 不实施 Kestrel 的请求体上限，413 的端到端行为用真实 Kestrel 手工验证；这里验证 413 等状态的正文内容。
    [Theory]
    [InlineData(400)] [InlineData(404)] [InlineData(405)] [InlineData(413)] [InlineData(415)] [InlineData(500)] [InlineData(418)]
    public void StatusBodies_AreBilingual_ForEveryStatus(int status)
    {
        var (zh, en) = ConsumptionTracker.Web.Api.ApiErrors.Messages(status);
        Assert.False(string.IsNullOrWhiteSpace(zh));
        Assert.False(string.IsNullOrWhiteSpace(en));
    }

    [Fact]
    public void Status413_Message_MentionsTooLarge()
    {
        var (zh, en) = ConsumptionTracker.Web.Api.ApiErrors.Messages(413);
        Assert.Contains("过大", zh); Assert.Contains("too large", en, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public async Task ExistingValidationMessages_Unchanged()
    {
        var c = _app.NewClient();
        var r = await c.Post("/api/auth/challenge", new { address = "not-an-address" });
        Assert.Equal(HttpStatusCode.BadRequest, r.StatusCode);
        var j = await r.J();
        Assert.False(string.IsNullOrWhiteSpace(j.GetProperty("error").GetString()));
        Assert.Equal(HttpStatusCode.Unauthorized, (await c.Post("/api/records/query", new { })).StatusCode);
    }

    [Fact]
    public async Task NonApi_NotFound_StaysPlain()
    {
        var c = _app.NewClient();
        var r = await c.GetAsync("/no-such-page.html");
        Assert.Equal(HttpStatusCode.NotFound, r.StatusCode);
        Assert.Equal("", await r.Content.ReadAsStringAsync());
    }
}
