using System.Net;
using System.Text.RegularExpressions;

namespace ConsumptionTracker.Web.Tests;

/// <summary>
/// 登记表单必填标记（三端一致）：名称、单价、数量、日期必填；条码、分类、批次、用药人、剂量/规格、备注可选。
/// 必填清单以真实校验为准（RecordValidator / app.js collectForm），这里同时检查静态页面与 API 行为，防止两者漂移。
/// </summary>
public class RequiredFieldsTests : IDisposable
{
    private readonly TestApp _app = new();
    public void Dispose() => _app.Dispose();

    private static readonly string[] RequiredIds = { "fName", "fPrice", "fQty", "fDate" };
    private static readonly string[] OptionalIds = { "fBarcode", "fCategory", "fPatient", "fDosage", "fBatch", "fNote" };

    private async Task<string> Get(string url)
    {
        var r = await _app.CreateClient().GetAsync(url);
        Assert.Equal(HttpStatusCode.OK, r.StatusCode);
        return await r.Content.ReadAsStringAsync();
    }

    private static string Form(string html)
    {
        var m = Regex.Match(html, "<form id=\"recForm\".*?</form>", RegexOptions.Singleline);
        Assert.True(m.Success);
        return m.Value;
    }

    private static string Tag(string form, string id) =>
        Regex.Match(form, "<(input|select|textarea)\\b[^>]*\\bid=\"" + id + "\"[^>]*>").Value;

    [Fact]
    public async Task RequiredInputs_HaveRequiredAriaAndBoldStarLabel()
    {
        var form = Form(await Get("/index.html"));
        foreach (var id in RequiredIds)
        {
            var tag = Tag(form, id);
            Assert.NotEqual("", tag);
            Assert.Contains(" required", tag);
            Assert.Contains("aria-required=\"true\"", tag);
            // 标签文字包在 span.req 里（粗体 + 红 *），input 不在 span 里
            Assert.Matches("<label><span class=\"req\">[^<]+</span> <(input|select|textarea)\\b[^>]*\\bid=\"" + id + "\"", form);
        }
    }

    [Fact]
    public async Task OptionalInputs_AreNotMarkedRequired()
    {
        var form = Form(await Get("/index.html"));
        foreach (var id in OptionalIds)
        {
            var tag = Tag(form, id);
            Assert.NotEqual("", tag);
            Assert.DoesNotContain("required", tag);
            Assert.DoesNotContain("aria-required", tag);
        }
        Assert.Equal(RequiredIds.Length, Regex.Matches(form, "class=\"req\"").Count);   // 只有 4 个必填标签
    }

    [Fact]
    public async Task Form_HasRequiredNote_AndNoInlineStyleOrScript()
    {
        var html = await Get("/index.html");
        var form = Form(html);
        Assert.Contains("<span class=\"req-mark\">*</span> 为必填", form);
        Assert.DoesNotContain(" style=", html);                                  // CSP 禁内联样式
        Assert.DoesNotMatch("<script(?![^>]*\\bsrc=)", html);                    // 没有内联脚本
        Assert.DoesNotMatch("\\son[a-z]+=\"", html);                             // 没有内联事件处理
        Assert.Contains("novalidate", form);                                     // 保留自定义校验提示，不让浏览器原生气泡接管
    }

    [Fact]
    public async Task Css_DefinesBoldLabelAndRedStar_InStyleFile()
    {
        var css = await Get("/style.css");
        Assert.Matches("\\.req\\{[^}]*font-weight:700", css);
        Assert.Matches("\\.req::after\\{[^}]*content:\" \\*\"[^}]*color:#d00", css);
        Assert.Matches("\\.req-mark\\{[^}]*color:#d00", css);
    }

    [Fact]
    public async Task Csp_ForbidsInlineScriptAndStyle()
    {
        var r = await _app.CreateClient().GetAsync("/index.html");
        var csp = string.Join(";", r.Headers.GetValues("Content-Security-Policy"));
        Assert.Contains("script-src 'self';", csp);      // 不允许内联脚本
        Assert.Contains("style-src 'self';", csp);       // 样式只能来自 style.css
    }

    // ---- 页面标记必须与真实校验一致：必填缺一不可，可选可以不填 ----

    [Theory]
    [InlineData("name")]
    [InlineData("priceCents")]
    [InlineData("date")]
    public async Task Api_MissingRequiredField_IsRejected(string field)
    {
        var c = await _app.LoginAsync(new TestWallet());
        var body = new Dictionary<string, object> { ["name"] = "牛奶", ["priceCents"] = 500, ["quantity"] = 1, ["date"] = "2026-10-05" };
        body.Remove(field);
        Assert.Equal(HttpStatusCode.BadRequest, (await c.Post("/api/records", body)).StatusCode);
    }

    [Fact]
    public async Task Api_QuantityOmitted_DefaultsToOne_ButFormStillRequiresIt()
    {
        // 表单里数量带默认值 1 且 required（不能清空）；API 对省略数量宽容地按 1 处理。显式给 0 则拒绝。
        var c = await _app.LoginAsync(new TestWallet());
        var ok = await c.Post("/api/records", new { name = "牛奶", priceCents = 500, date = "2026-10-05" });
        Assert.Equal(HttpStatusCode.Created, ok.StatusCode);
        Assert.Equal(1m, (await ok.J()).GetProperty("quantity").GetDecimal());
        Assert.Equal(HttpStatusCode.BadRequest, (await c.Post("/api/records", new { name = "牛奶", priceCents = 500, quantity = 0, date = "2026-10-05" })).StatusCode);
    }

    [Fact]
    public async Task Api_OnlyRequiredFields_IsAccepted_BarcodeAndOthersOptional()
    {
        var c = await _app.LoginAsync(new TestWallet());
        var r = await c.Post("/api/records", new { name = "牛奶", priceCents = 500, quantity = 1, date = "2026-10-05" });
        Assert.Equal(HttpStatusCode.Created, r.StatusCode);
        var rec = await r.J();
        Assert.Equal("", rec.GetProperty("barcode").GetString());
        Assert.Equal("未分类", rec.GetProperty("category").GetString());
    }
}
