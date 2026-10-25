using Microsoft.AspNetCore.Http.Features;

namespace ConsumptionTracker.Web.Api;

public static class Security
{
    public const string CsrfHeader = "X-Requested-With";
    public const string CsrfValue = "life-web";

    public const string Csp =
        "default-src 'none'; script-src 'self'; style-src 'self'; style-src-attr 'unsafe-inline'; " +
        "img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; font-src 'self'; " +
        "manifest-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'";

    /// <summary>安全响应头（CSP 禁止一切外部连接/脚本）+ API 禁缓存。</summary>
    public static void UseSecurityHeaders(this WebApplication app)
    {
        app.Use(async (ctx, next) =>
        {
            ctx.Response.OnStarting(() =>
            {
                var h = ctx.Response.Headers;
                h["Content-Security-Policy"] = Csp;
                h["X-Content-Type-Options"] = "nosniff";
                h["X-Frame-Options"] = "DENY";
                h["Referrer-Policy"] = "no-referrer";
                h["Permissions-Policy"] = "camera=(self), microphone=(), geolocation=(), payment=(), usb=()";
                h["Cross-Origin-Opener-Policy"] = "same-origin";
                h["Cross-Origin-Resource-Policy"] = "same-origin";
                if (ctx.Request.IsHttps) h["Strict-Transport-Security"] = "max-age=31536000";
                if (ctx.Request.Path.StartsWithSegments("/api"))
                {
                    h["Cache-Control"] = "no-store";
                    h["Pragma"] = "no-cache";
                }
                h.Remove("Server");
                h.Remove("X-Powered-By");
                return Task.CompletedTask;
            });
            await next();
        });
    }

    /// <summary>
    /// CSRF 防护（与 SameSite=Strict 会话 Cookie 叠加）：/api 下所有非 GET/HEAD 请求必须带自定义头
    /// X-Requested-With: life-web（跨站表单无法设置），且若带 Origin 则必须与本站 Host 一致。
    /// 另外限制请求体大小（默认小，导入端点自行放宽）。
    /// </summary>
    public static void UseApiGuards(this WebApplication app, LifeOptions options)
    {
        app.Use(async (ctx, next) =>
        {
            if (ctx.Request.Path.StartsWithSegments("/api"))
            {
                var limit = ctx.Features.Get<IHttpMaxRequestBodySizeFeature>();
                if (limit is { IsReadOnly: false }) limit.MaxRequestBodySize = options.Limits.DefaultBodyBytes;

                var m = ctx.Request.Method;
                if (!(HttpMethods.IsGet(m) || HttpMethods.IsHead(m) || HttpMethods.IsOptions(m)))
                {
                    if (ctx.Request.Headers[CsrfHeader] != CsrfValue || !OriginOk(ctx.Request))
                    {
                        ctx.Response.StatusCode = StatusCodes.Status403Forbidden;
                        await ctx.Response.WriteAsJsonAsync(new { error = "请求被拒绝（缺少或不匹配的来源校验）" });
                        return;
                    }
                }
            }
            await next();
        });
    }

    private static bool OriginOk(HttpRequest req)
    {
        var origin = req.Headers.Origin.ToString();
        if (string.IsNullOrEmpty(origin)) return true; // 非浏览器客户端/同源旧浏览器；仍需自定义头
        if (!Uri.TryCreate(origin, UriKind.Absolute, out var u)) return false;
        return string.Equals(u.Authority, req.Host.Value, StringComparison.OrdinalIgnoreCase)
               && string.Equals(u.Scheme, req.Scheme, StringComparison.OrdinalIgnoreCase);
    }
}
