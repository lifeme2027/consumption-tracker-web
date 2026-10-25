using System.Net;
using System.Text.RegularExpressions;

namespace ConsumptionTracker.Web.Tests;

/// <summary>
/// M-1 / L-6 文案的静态约束：删除不再被说成“永久/无法恢复”，而是如实说明 secure_delete / checkpoint / VACUUM 的含义、
/// 旧备份不会被删、明文备份与 IIS 日志最长保留 30 天；隐私页中英文都要覆盖 12 小时会话、健康敏感信息，
/// 并把本地模式与云端模式分开写。DEPLOY.md 必须给出清理脚本 / 计划任务。
/// </summary>
public class PrivacyAndDeleteWordingTests : IDisposable
{
    private readonly TestApp _app = new();
    public void Dispose() => _app.Dispose();

    private async Task<string> Get(string url)
    {
        var r = await _app.CreateClient().GetAsync(url);
        Assert.Equal(HttpStatusCode.OK, r.StatusCode);
        return await r.Content.ReadAsStringAsync();
    }

    private static string RepoRoot()
    {
        var d = new DirectoryInfo(AppContext.BaseDirectory);
        while (d != null && !File.Exists(Path.Combine(d.FullName, "DEPLOY.md"))) d = d.Parent;
        Assert.NotNull(d);
        return d!.FullName;
    }

    /// <summary>取以包含 heading 的 &lt;h2&gt; 开始、到下一个 &lt;h2&gt; 之前的 HTML。</summary>
    private static string Section(string html, string headingContains)
    {
        var m = Regex.Match(html, "<h2>[^<]*" + Regex.Escape(headingContains) + "[^<]*</h2>(.*?)(?=<h2>|</section>)", RegexOptions.Singleline);
        Assert.True(m.Success, "找不到小节：" + headingContains);
        return m.Groups[1].Value;
    }

    [Fact]
    public void NoFrontendFileClaimsPermanentOrIrrecoverableDeletion()
    {
        var wwwroot = Path.Combine(RepoRoot(), "src", "ConsumptionTracker.Web", "wwwroot");
        var files = Directory.GetFiles(wwwroot, "*.*", SearchOption.TopDirectoryOnly)
            .Where(f => new[] { ".html", ".js" }.Contains(Path.GetExtension(f))).ToList();
        Assert.True(files.Count >= 8);
        foreach (var f in files)
        {
            var t = File.ReadAllText(f);
            foreach (var bad in new[] { "永久", "无法恢复", "不可恢复", "无法找回数据", "permanently", "irrecoverable", "unrecoverable", "cannot be recovered" })
                Assert.False(t.Contains(bad, StringComparison.OrdinalIgnoreCase), $"{Path.GetFileName(f)} 含有绝对化措辞「{bad}」");
        }
    }

    [Fact]
    public async Task IndexWipeHint_IsHonest_AndLinksBothPrivacyPages()
    {
        var html = await Get("/");
        Assert.Contains("本页不提供撤销", html);
        Assert.Contains("href=\"/privacy.html\"", html);
        Assert.Contains("href=\"/privacy-en.html\"", html);
        var js = await Get("/app.js");
        foreach (var k in new[] { "secure_delete", "checkpoint", "VACUUM", "备份副本不会被删除", "30 天", "IndexedDB" })
            Assert.Contains(k, js);
    }

    [Fact]
    public async Task ChinesePrivacyPage_CoversRetentionSessionLogsHealth_AndSplitsModes()
    {
        var html = await Get("/privacy.html");
        foreach (var k in new[] { "12 小时", "30 天", "IIS", "secure_delete", "checkpoint", "VACUUM", "健康", "备份", "已经存在的备份副本" })
            Assert.Contains(k, html);
        var local = Section(html, "本地模式（默认");
        Assert.Contains("健康", local);
        Assert.Contains("IndexedDB", local);
        Assert.Contains("没有账户、没有会话", local);
        var cloud = Section(html, "云端模式（登录");
        Assert.Contains("健康", cloud);
        Assert.Contains("没有端到端加密", cloud);
        Assert.Contains("明文", cloud);
        Section(html, "云端模式：会话有效期");
        Section(html, "云端模式：服务器备份的保留期");
        Section(html, "服务器访问日志");
        Assert.Contains("hreflang=\"en\"", html);                         // 能跳到英文页
        Assert.DoesNotContain("<script", html, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public async Task EnglishPrivacyPage_ExistsAndCoversTheSame()
    {
        var html = await Get("/privacy-en.html");
        Assert.Contains("<html lang=\"en\">", html);
        foreach (var k in new[] { "12 hours", "30 days", "IIS", "secure_delete", "checkpoint", "VACUUM", "health-related sensitive information",
                                  "backup copies that already exist", "without end-to-end encryption", "do not promise anonymity" })
            Assert.Contains(k, html);
        var local = Section(html, "Local mode (default");
        Assert.Contains("health-related sensitive information", local);
        Assert.Contains("IndexedDB", local);
        Assert.Contains("never sent to the server", local);
        var cloud = Section(html, "Cloud mode (optional");
        Assert.Contains("health-related sensitive information", cloud);
        Assert.Contains("plaintext", cloud);
        Section(html, "Cloud mode: session lifetime");
        Section(html, "Cloud mode: server backup retention");
        Section(html, "Server access logs");
        Assert.Contains("hreflang=\"zh-CN\"", html);
        Assert.DoesNotContain("<script", html, StringComparison.OrdinalIgnoreCase);
        // CSP 不放宽
        var r = await _app.CreateClient().GetAsync("/privacy-en.html");
        var csp = string.Join(";", r.Headers.GetValues("Content-Security-Policy"));
        Assert.Contains("default-src 'none'", csp);
        Assert.Contains("script-src 'self'", csp);
        Assert.Contains("connect-src 'self'", csp);
    }

    [Fact]
    public void DeployDoc_HasRetentionCleanupScheduledTask_IisLogs_Redirect_Cert()
    {
        var root = RepoRoot();
        var doc = File.ReadAllText(Path.Combine(root, "DEPLOY.md"));
        foreach (var k in new[] { "最长保留 30 天", "cleanup-life.ps1", "Register-ScheduledTask", "-WhatIf", "IIS 日志", "W3SVC", "Permanent", "2026-11-29", "AllowedHosts", "life.db.vacuumed", "已经存在的备份副本不会被程序删除" })
            Assert.Contains(k, doc);
        var ps1 = File.ReadAllText(Path.Combine(root, "scripts", "ops", "cleanup-life.ps1"));
        Assert.Contains("[int]$Days = 30", ps1);
        Assert.Contains("SupportsShouldProcess", ps1);
        Assert.DoesNotContain("App_Data", ps1.Replace("不会碰 D:\\Web\\life\\App_Data", ""));   // 脚本逻辑不能碰数据目录（注释里的说明除外）
    }
}
