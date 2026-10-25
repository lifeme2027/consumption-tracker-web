using System.Net;
using System.Text.RegularExpressions;

namespace ConsumptionTracker.Web.Tests;

/// <summary>
/// 默认免登录（本地模式）的前端静态约束：页面一打开就是登记页；本地存储模块不含任何网络调用；
/// 数据请求只出现在 life-remote.js；CSP 仍然严格（无内联脚本/样式、connect-src 'self'）。
/// 本地存储适配层与模式切换的行为测试在 scripts/js-tests（node:test + fake-indexeddb），由 CI 运行。
/// </summary>
public class LocalModeFrontendTests : IDisposable
{
    private readonly TestApp _app = new();
    public void Dispose() => _app.Dispose();

    private async Task<string> Get(string url)
    {
        var r = await _app.CreateClient().GetAsync(url);
        Assert.Equal(HttpStatusCode.OK, r.StatusCode);
        return await r.Content.ReadAsStringAsync();
    }

    [Fact]
    public async Task IndexOpensOnRegisterTab_WithoutLogin_AndShowsMode()
    {
        var html = await Get("/");
        Assert.DoesNotMatch("id=\"appView\"[^>]*hidden", html);          // 不再默认藏起来等登录
        Assert.Matches("id=\"loginView\"[^>]*hidden", html);              // 登录只是可选视图
        Assert.Contains("id=\"modeBadge\"", html);
        Assert.Contains("登录 Kaspa 钱包（可选，云端保存）", html);
        Assert.Contains("退出云端", html);
        Assert.Contains("数据只在你的浏览器里（不发送到服务器），清除浏览器数据或换设备会丢失，请定期导出备份", html);
        Assert.Contains("数据存在服务器上，没有端到端加密、不承诺匿名", html);
        Assert.Contains("数据保存在本机浏览器，建议定期导出", html);
        Assert.Contains("上传本地数据到账户", html);
        Assert.Contains("从账户下载到本地", html);
        Assert.Matches("id=\"cloudSync\"[^>]*hidden", html);              // 云端同步按钮只在云端模式出现
    }

    [Fact]
    public async Task IndexLoadsStorageScriptsBeforeApp_NoInlineScriptOrStyle()
    {
        var html = await Get("/");
        var order = new[] { "/money.js", "/life-i18n.js", "/life-local.js", "/life-remote.js", "/life-mode.js", "/app.js" }
            .Select(s => html.IndexOf($"src=\"{s}\"", StringComparison.Ordinal)).ToArray();
        Assert.All(order, i => Assert.True(i > 0));
        Assert.Equal(order.OrderBy(i => i), order);
        Assert.DoesNotMatch(new Regex("<script(?![^>]*\\bsrc=)[^>]*>", RegexOptions.IgnoreCase), html);
        Assert.DoesNotMatch(new Regex("<style\\b", RegexOptions.IgnoreCase), html);
        Assert.DoesNotMatch(new Regex("\\sstyle=\"", RegexOptions.IgnoreCase), html);
        Assert.DoesNotMatch(new Regex("\\son[a-z]+=\"", RegexOptions.IgnoreCase), html);
    }

    [Theory]
    [InlineData("/life-local.js")]
    [InlineData("/life-mode.js")]
    [InlineData("/life-i18n.js")]
    public async Task LocalAndModeModules_ContainNoNetworkCalls(string path)
    {
        var js = await Get(path);
        foreach (var banned in new[] { "fetch(", "XMLHttpRequest", "sendBeacon", "WebSocket", "EventSource", "/api/" })
            Assert.DoesNotContain(banned, js);
    }

    [Fact]
    public async Task LanguageToggle_ExistsInHeader_DefaultChinese_AndI18nHasNoDomAccess()
    {
        var html = await Get("/");
        Assert.Matches("<button id=\"langBtn\"[^>]*>English</button>", html);
        var i18n = await Get("/life-i18n.js");
        foreach (var banned in new[] { "document.", "innerHTML", "eval(", "new Function" })
            Assert.DoesNotContain(banned, i18n);
        Assert.Contains("getStored() === 'en' ? 'en' : 'zh'", i18n);   // 默认中文
    }

    [Fact]
    public async Task RecordApiCalls_LiveOnlyInRemoteModule()
    {
        var app = await Get("/app.js");
        foreach (var banned in new[] { "/api/records", "/api/import", "/api/export", "/api/stats", "/api/meta", "/api/products", "/api/account" })
            Assert.DoesNotContain(banned, app);
        var remote = await Get("/life-remote.js");
        Assert.Contains("/api/records", remote);
        Assert.Contains("X-Requested-With", remote);
    }

    [Fact]
    public async Task Csp_StaysStrict()
    {
        var r = await _app.CreateClient().GetAsync("/");
        var csp = string.Join(";", r.Headers.GetValues("Content-Security-Policy"));
        Assert.Contains("connect-src 'self'", csp);
        Assert.Contains("script-src 'self'", csp);
        Assert.DoesNotContain("script-src 'self' 'unsafe-inline'", csp);
        Assert.DoesNotContain("http://", csp);
        Assert.DoesNotContain("https://", csp);
    }

    [Fact]
    public async Task PrivacyPage_ExplainsBothModes()
    {
        var html = await Get("/privacy.html");
        Assert.Contains("本地模式", html);
        Assert.Contains("云端模式", html);
        Assert.Contains("数据只在你的浏览器里", html);
        Assert.Contains("没有端到端加密", html);
        Assert.Contains("不承诺匿名", html);
    }

    /// <summary>本地条码记忆：app.js 的条码框要同时处理回车（扫码枪）与 change（手动输入后 Tab/失焦），文案三端一致；隐私页说明只存本地。</summary>
    [Fact]
    public async Task BarcodeMemory_WiredToEnterAndChange_WithConsistentHints_AndPrivacyNote()
    {
        var js = await Get("/app.js");
        Assert.Contains("$('fBarcode').addEventListener('keydown'", js);
        Assert.Contains("$('fBarcode').addEventListener('change'", js);
        Assert.Contains("lastLookedCode", js);                                  // 回车与失焦共用，避免重复查询/覆盖用户改动
        Assert.Contains("已带出上次的名称、分类、价格，请核对。", js);
        Assert.Contains("新条码，请填写名称和价格。", js);
        var zh = await Get("/privacy.html");
        Assert.Contains("条码记忆", zh);
        Assert.Contains("不发送到服务器", zh);
        var en = await Get("/privacy-en.html");
        Assert.Contains("Barcode memory", en);
    }
}
