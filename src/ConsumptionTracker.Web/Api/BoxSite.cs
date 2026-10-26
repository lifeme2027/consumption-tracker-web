using System.Text.RegularExpressions;
using Microsoft.AspNetCore.StaticFiles;

namespace ConsumptionTracker.Web.Api;

/// <summary>
/// /box：ScaleBridge Web 版（纯静态单页，源码在 composehk/scalebridge 的 web/，构建产物同步到 wwwroot/box）。
/// 它需要 Web Bluetooth，所以只对 /box 路径放行 Permissions-Policy 的 bluetooth=(self)，并使用自己的（比全站更小的）CSP；
/// 站点其它路径的响应头完全不变。/box 页面不调用本站任何接口、不使用 Cookie。
/// </summary>
public static partial class BoxSite
{
    public const string Prefix = "/box";

    /// <summary>与 scalebridge 仓库 web/scripts/headers.mjs 的 BOX_CSP 逐字相同。没有 worker-src：/box 不使用 Web Worker。</summary>
    public const string Csp =
        "default-src 'self'; script-src 'self'; connect-src 'self'; style-src 'self'; img-src 'self' data:; " +
        "object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

    /// <summary>仅 /box：bluetooth 只给本站自己；其它能力与全站一致（camera 也关，/box 用不到）。</summary>
    public const string PermissionsPolicy = "bluetooth=(self), camera=(), microphone=(), geolocation=(), payment=(), usb=()";

    /// <summary>按路径段匹配：/box、/box/、/box/x 是；/boxer、/xbox 不是。</summary>
    public static bool IsBoxPath(PathString path) => path.StartsWithSegments(Prefix, StringComparison.OrdinalIgnoreCase);

    /// <summary>构建产物里带内容哈希的文件（name.&lt;10 位十六进制&gt;.js|css）。</summary>
    [GeneratedRegex(@"\.[0-9a-f]{10}\.(js|css)$")]
    private static partial Regex HashedAsset();

    public static void PrepareResponse(StaticFileResponseContext ctx)
    {
        if (!IsBoxPath(ctx.Context.Request.Path)) return; // 其它路径的缓存行为保持原样
        var name = ctx.File.Name;
        ctx.Context.Response.Headers.CacheControl = HashedAsset().IsMatch(name)
            ? "public, max-age=31536000, immutable"
            : "no-cache";
    }

    /// <summary>GET/HEAD /box → /box/index.html。必须在 UseDefaultFiles 之前：它会把 /box 301 到 /box/，而我们要两种写法都直接 200。</summary>
    public static void UseBoxRewrite(this WebApplication app)
    {
        app.Use(async (ctx, next) =>
        {
            if ((HttpMethods.IsGet(ctx.Request.Method) || HttpMethods.IsHead(ctx.Request.Method))
                && string.Equals(ctx.Request.Path.Value, Prefix, StringComparison.OrdinalIgnoreCase))
                ctx.Request.Path = Prefix + "/index.html";
            await next();
        });
    }
}
