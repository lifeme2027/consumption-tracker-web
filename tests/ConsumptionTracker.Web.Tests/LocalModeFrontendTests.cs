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
        var order = new[] { "/money.js", "/life-i18n.js", "/life-catalog.js", "/life-local.js", "/life-remote.js", "/life-mode.js", "/app.js" }
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

    /// <summary>商品库查询：唯一的非 life-remote 网络调用，只发条码、POST、不带 Cookie；app.js 自己不写 fetch；开关默认开且写在设置里。</summary>
    [Fact]
    public async Task CatalogLookup_IsPostOnly_BarcodeOnly_NoCookies_SwitchableInSettings()
    {
        var cat = await Get("/life-catalog.js");
        Assert.Contains("'/api/catalog/lookup'", cat);
        Assert.Contains("method: 'POST'", cat);
        Assert.Contains("credentials: 'omit'", cat);
        Assert.Contains("JSON.stringify({ barcode: code })", cat);
        Assert.Contains("TIMEOUT_MS = 3000", cat);
        Assert.DoesNotContain("encodeURIComponent", cat);      // 条码不进网址
        Assert.DoesNotContain("sendBeacon", cat);
        Assert.DoesNotContain("/api/records", cat);
        var app = await Get("/app.js");
        Assert.DoesNotContain("/api/catalog", app);            // 网络调用只在 life-catalog.js 里
        Assert.Contains("CAT.query(code)", app);
        var html = await Get("/");
        Assert.Contains("id=\"catalogToggle\" type=\"checkbox\" checked", html);   // 默认开启
        Assert.Contains("查询商品库（会把条码发送到本站服务器，不含其他数据、不记录）", html);
        Assert.Contains("开启「查询商品库」", html);                                  // 本地模式提示条如实说明
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

    /// <summary>隐私页如实说明商品库查询：开启时条码发到本站服务器、只发条码、不记录不保存、可关闭、关闭即离线；本地模式其他数据仍只在设备上。</summary>
    [Fact]
    public async Task PrivacyPages_DescribeCatalogLookupHonestly_InBothLanguages()
    {
        var zh = await Get("/privacy.html");
        foreach (var k in new[] { "商品库查询", "条码会被发送到本站服务器", "只发送条码这一个字段", "不记录、不保存", "不在网址里", "关闭这个开关后", "完全不发送条码查询请求", "完全离线", "其他数据一直只在你的设备上", "不携带登录 Cookie", "默认开启" })
            Assert.Contains(k, zh);
        Assert.Contains("数据只在你的浏览器里", zh);              // 记录本身仍只在本地
        var en = await Get("/privacy-en.html");
        foreach (var k in new[] { "Product catalog lookup", "is sent to this site&rsquo;s server", "Only the barcode is sent", "neither logs nor stores", "not in the URL", "When the switch is off", "no barcode lookups at all", "fully offline", "all other data always stays on your device", "no sign-in cookie", "on by default" })
            Assert.Contains(k, en);
        Assert.Contains("never sent to the server", en);
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
