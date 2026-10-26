using System.Net;
using System.Text.RegularExpressions;
using Microsoft.AspNetCore.Hosting;
using Microsoft.Extensions.DependencyInjection;

namespace ConsumptionTracker.Web.Tests;

/// <summary>
/// /box（ScaleBridge Web 版，纯静态）：能打开（/box 与 /box/ 都 200）、只有它带 Web Bluetooth 的 Permissions-Policy 与自己的严格 CSP、
/// 站点其它路径的响应头不变、路径穿越无效、缓存头（入口页不长缓存，带哈希的文件可长缓存）、静态约束（无内联脚本/事件处理器、无外部地址、无 Worker、无网络调用）。
/// </summary>
public class BoxSiteTests : IDisposable
{
    // 故意写成字面量而不是引用 BoxSite.Csp：改动任何一个字都应当让这个测试红，逼着同时审查 scalebridge 仓库的 headers.mjs。
    private const string ExpectedBoxCsp =
        "default-src 'self'; script-src 'self'; connect-src 'self'; style-src 'self'; img-src 'self' data:; " +
        "object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
    private const string ExpectedBoxPermissions = "bluetooth=(self), camera=(), microphone=(), geolocation=(), payment=(), usb=()";
    private const string SitePermissions = "camera=(self), microphone=(), geolocation=(), payment=(), usb=()";

    private readonly TestApp _app = new();
    public void Dispose() => _app.Dispose();

    private static string One(HttpResponseMessage r, string name) =>
        r.Headers.TryGetValues(name, out var v) || r.Content.Headers.TryGetValues(name, out v) ? string.Join(",", v) : "";

    private string BoxRoot => Path.Combine(_app.Services.GetRequiredService<IWebHostEnvironment>().WebRootPath, "box");

    private static readonly Regex Hashed = new(@"\.[0-9a-f]{10}\.(js|css)$");

    [Theory]
    [InlineData("/box")]
    [InlineData("/box/")]
    [InlineData("/box/index.html")]
    [InlineData("/box/privacy.html")]
    public async Task BoxPages_Open_WithBoxHeaders(string url)
    {
        var r = await _app.NewClient().GetAsync(url);
        Assert.Equal(HttpStatusCode.OK, r.StatusCode);                       // /box 与 /box/ 都直接 200，不 301
        Assert.StartsWith("text/html", r.Content.Headers.ContentType?.ToString());
        Assert.Equal(ExpectedBoxCsp, One(r, "Content-Security-Policy"));
        Assert.Equal(ExpectedBoxPermissions, One(r, "Permissions-Policy"));
        Assert.Contains("bluetooth=(self)", One(r, "Permissions-Policy"));
        Assert.Equal("nosniff", One(r, "X-Content-Type-Options"));
        Assert.Equal("no-referrer", One(r, "Referrer-Policy"));
        Assert.Equal("DENY", One(r, "X-Frame-Options"));
        Assert.Equal("no-cache", One(r, "Cache-Control"));                   // 入口页不长缓存
        Assert.False(r.Headers.Contains("Set-Cookie"), "/box 不使用 Cookie");
    }

    [Fact]
    public async Task Box_AndBoxSlash_ServeTheSameDocument_AndHeadWorks()
    {
        var c = _app.NewClient();
        var a = await (await c.GetAsync("/box")).Content.ReadAsStringAsync();
        var b = await (await c.GetAsync("/box/")).Content.ReadAsStringAsync();
        Assert.Equal(a, b);
        Assert.Contains("<html", a);
        Assert.Contains("data-testid=\"btn-connect\"", a);
        var head = await c.SendAsync(new HttpRequestMessage(HttpMethod.Head, "/box"));
        Assert.Equal(HttpStatusCode.OK, head.StatusCode);
        Assert.Equal(ExpectedBoxPermissions, One(head, "Permissions-Policy"));
        Assert.NotEqual(HttpStatusCode.OK, (await c.PostAsync("/box", new StringContent(""))).StatusCode);
    }

    [Fact]
    public async Task EveryBoxFile_IsServed_WithBoxHeaders_AndCorrectCaching()
    {
        var files = Directory.EnumerateFiles(BoxRoot, "*", SearchOption.AllDirectories).ToList();
        Assert.True(files.Count >= 10, "wwwroot/box 应已同步（node scripts/sync-to-site.mjs）");
        Assert.Contains(files, f => Hashed.IsMatch(f));
        var c = _app.NewClient();
        foreach (var f in files)
        {
            var rel = Path.GetRelativePath(BoxRoot, f).Replace('\\', '/');
            var r = await c.GetAsync("/box/" + rel);
            Assert.True(r.StatusCode == HttpStatusCode.OK, $"{rel}: {r.StatusCode}");
            Assert.Equal(ExpectedBoxCsp, One(r, "Content-Security-Policy"));
            Assert.Equal(ExpectedBoxPermissions, One(r, "Permissions-Policy"));
            Assert.Equal(Hashed.IsMatch(rel) ? "public, max-age=31536000, immutable" : "no-cache", One(r, "Cache-Control"));
            if (rel.EndsWith(".js")) Assert.Contains("javascript", r.Content.Headers.ContentType?.ToString());
            if (rel.EndsWith(".css")) Assert.StartsWith("text/css", r.Content.Headers.ContentType?.ToString());
            Assert.False(r.Headers.Contains("Set-Cookie"), rel);
        }
    }

    [Fact]
    public async Task IndexReferences_OnlyExistingHashedAssets()
    {
        var html = await (await _app.NewClient().GetAsync("/box/")).Content.ReadAsStringAsync();
        var refs = Regex.Matches(html, "(?:src|href)=\"(/box/[^\"]+)\"").Select(m => m.Groups[1].Value).ToList();
        Assert.Contains(refs, r => r.EndsWith(".js"));
        Assert.Contains(refs, r => r.EndsWith(".css"));
        foreach (var r in refs.Where(r => r.EndsWith(".js") || r.EndsWith(".css")))
        {
            Assert.Matches(Hashed, r);
            Assert.Equal(HttpStatusCode.OK, (await _app.NewClient().GetAsync(r)).StatusCode);
        }
    }

    [Theory]
    [InlineData("/")]
    [InlineData("/index.html")]
    [InlineData("/privacy.html")]
    [InlineData("/app.js")]
    [InlineData("/healthz")]
    [InlineData("/api/auth/me")]
    [InlineData("/boxer")]            // 只匹配整段 /box
    [InlineData("/boxer/index.html")]
    [InlineData("/xbox")]
    [InlineData("/nope-404")]
    public async Task OtherPaths_KeepSiteHeaders_WithoutBluetooth(string url)
    {
        var r = await _app.NewClient().GetAsync(url);
        Assert.Equal(SitePermissions, One(r, "Permissions-Policy"));
        Assert.DoesNotContain("bluetooth", One(r, "Permissions-Policy"));
        var csp = One(r, "Content-Security-Policy");
        Assert.StartsWith("default-src 'none'; script-src 'self'; style-src 'self'; style-src-attr 'unsafe-inline';", csp);
        Assert.Contains("form-action 'self'", csp);
        Assert.DoesNotContain("connect-src 'self'; style-src", csp);
    }

    [Fact]
    public async Task OtherPaths_CacheBehaviourIsUnchanged()
    {
        var r = await _app.NewClient().GetAsync("/app.js");
        Assert.Equal(HttpStatusCode.OK, r.StatusCode);
        Assert.NotEqual("no-cache", One(r, "Cache-Control")); // 全站原有静态文件不被 /box 的缓存规则波及
        Assert.Equal("no-store", One(await _app.NewClient().GetAsync("/api/auth/me"), "Cache-Control"));
    }

    [Theory]
    [InlineData("/box/../appsettings.json")]
    [InlineData("/box/%2e%2e/appsettings.json")]
    [InlineData("/box/%2e%2e%2fappsettings.json")]
    [InlineData("/box/..%2f..%2fappsettings.json")]
    [InlineData("/box/..%5cappsettings.json")]
    [InlineData("/box/%2e%2e%5c%2e%2e%5cweb.config")]
    [InlineData("/box/core/../../../appsettings.json")]
    [InlineData("/box/%252e%252e/appsettings.json")]
    [InlineData("/box/..;/appsettings.json")]
    [InlineData("/box/index.html/../../appsettings.json")]
    [InlineData("/box/C:/Windows/win.ini")]
    [InlineData("/box/%00/index.html")]
    public async Task PathTraversal_DoesNotLeakFilesOutsideBox(string url)
    {
        HttpResponseMessage r;
        try { r = await _app.NewClient().GetAsync(url); }
        catch (Exception e) when (e is HttpRequestException or UriFormatException or InvalidOperationException) { return; }
        var body = await r.Content.ReadAsStringAsync();
        Assert.DoesNotContain("\"Storage\"", body);          // appsettings.json 的内容
        Assert.DoesNotContain("DataDir", body);
        Assert.DoesNotContain("aspNetCore", body, StringComparison.OrdinalIgnoreCase); // web.config
        Assert.DoesNotContain("[fonts]", body, StringComparison.OrdinalIgnoreCase);    // win.ini
        // 若被规整到 /box 之外，得到的是站点自己的 404/页面，不能是 /box 的文档以外的任何配置/源码
        Assert.True(r.StatusCode != HttpStatusCode.OK || body.Contains("<html"), $"{url}: {r.StatusCode}");
    }

    // ---- 静态约束（保护同步进来的那份产物） ----

    private IEnumerable<(string Rel, string Text)> BoxTextFiles() =>
        Directory.EnumerateFiles(BoxRoot, "*", SearchOption.AllDirectories)
            .Where(f => f.EndsWith(".js") || f.EndsWith(".html") || f.EndsWith(".css"))
            .Select(f => (Path.GetRelativePath(BoxRoot, f).Replace('\\', '/'), File.ReadAllText(f)));

    [Fact]
    public void BoxHtml_HasNoInlineScriptOrHandlersOrBaseOrExternalUrls()
    {
        foreach (var (rel, text) in BoxTextFiles().Where(t => t.Rel.EndsWith(".html")))
        {
            Assert.DoesNotMatch(@"<script(?![^>]*\bsrc=)", text);                         // 没有内联脚本
            Assert.DoesNotMatch(@"<script[^>]*\bsrc=""[^""]+""[^>]*>\s*[^<\s]", text);       // 带 src 的 script 里也不能有内容
            Assert.DoesNotMatch(@"\son[a-z]+\s*=", text);                                 // 没有 onclick= 之类
            Assert.DoesNotMatch(@"\sstyle\s*=", text);                                    // 没有内联 style（style-src 'self'）
            Assert.DoesNotMatch(@"<base\b", text);                                        // base-uri 'none'
            Assert.DoesNotMatch(@"(?:src|href|action)\s*=\s*""(?:https?:)?//", text);     // 不引用外部地址
            Assert.DoesNotContain("javascript:", text, StringComparison.OrdinalIgnoreCase);
        }
    }

    [Fact]
    public void BoxJs_NoWorkers_NoNetworkCalls_NoCookies_NoForbiddenWording()
    {
        foreach (var (rel, text) in BoxTextFiles())
        {
            var code = Regex.Replace(Regex.Replace(text, @"/\*.*?\*/", "", RegexOptions.Singleline), @"(?m)^\s*//.*$", "");
            if (rel.StartsWith("i18n/") || rel.EndsWith(".html") || rel.EndsWith(".css")) continue;
            Assert.DoesNotMatch(@"\b(?:new\s+(?:Shared)?Worker|ServiceWorker|serviceWorker|importScripts)\b", code);
            Assert.DoesNotMatch(@"\b(?:fetch|XMLHttpRequest|sendBeacon|WebSocket|EventSource)\b", code);   // 不向任何地方发请求（数据只在本浏览器）
            Assert.DoesNotMatch(@"\bdocument\.cookie\b", code);
            Assert.DoesNotMatch(@"\b(?:eval|new\s+Function)\s*\(", code);
            Assert.DoesNotMatch(@"https?://", code);                                       // 代码里不写外部地址
        }
        foreach (var (rel, text) in BoxTextFiles())
            foreach (var w in new[] { "永久", "无法恢复", "30 天", "自动清理" })
                Assert.DoesNotContain(w, text);
    }

    [Fact]
    public void BoxCopy_HonestyLabels_Present_AndNoUnverifiedClaims()
    {
        var all = string.Join("\n", BoxTextFiles().Select(t => t.Text));
        Assert.Contains("实验性（仅按规范实现，未真机验证）", all);
        Assert.Contains("演示数据", all);
        Assert.DoesNotMatch(@"(?<![不未没无])支持\s*(?:的)?\s*(?:小米|Xiaomi|Renpho|云麦|Chipsea|芯海|OKOK|华为)", all);
        Assert.DoesNotMatch(@"(?<![未没尚不])已(?:经)?(?:在)?真机验证", all);
    }
}
