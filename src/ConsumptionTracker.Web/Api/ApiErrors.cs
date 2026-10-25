using Microsoft.AspNetCore.Routing.Patterns;
using Microsoft.AspNetCore.Routing.Template;

namespace ConsumptionTracker.Web.Api;

/// <summary>/api 下统一的错误语义：404 / 405(+Allow) / 415，以及为空正文的 4xx/5xx 补上中英文 JSON 正文。</summary>
public static class ApiErrors
{
    private const string CatchAll = "/api/{**rest}";

    public static (string Zh, string En) Messages(int status) => status switch
    {
        400 => ("请求格式有误（JSON 无效或为空）", "Malformed request (invalid or empty JSON body)"),
        401 => ("未登录或会话已过期", "Not signed in or the session has expired"),
        403 => ("请求被拒绝", "Request forbidden"),
        404 => ("接口不存在", "Endpoint not found"),
        405 => ("请求方法不被允许", "Method not allowed"),
        408 => ("请求超时", "Request timed out"),
        413 => ("请求内容过大", "Request body too large"),
        415 => ("不支持的内容类型，请使用 application/json", "Unsupported media type; use application/json"),
        429 => ("请求过于频繁，请稍后再试", "Too many requests, please try again later"),
        500 => ("服务器内部错误", "Internal server error"),
        >= 400 and < 500 => ("请求有误", "Bad request"),
        _ => ("服务器错误", "Server error"),
    };

    public static object Body(int status)
    {
        var (zh, en) = Messages(status);
        return new { error = zh, errorEn = en };
    }

    public static void MapApiFallback(this WebApplication app)
    {
        app.Map(CatchAll, (HttpContext ctx, EndpointDataSource data) =>
        {
            var path = ctx.Request.Path;
            var method = ctx.Request.Method;
            var allowed = new SortedSet<string>(StringComparer.Ordinal);
            var matched = false; var anyMethod = false;
            foreach (var e in data.Endpoints.OfType<RouteEndpoint>())
            {
                if (e.RoutePattern.RawText == CatchAll) continue;
                var tm = new TemplateMatcher(TemplateParser.Parse(e.RoutePattern.RawText ?? ""), new RouteValueDictionary());
                if (!tm.TryMatch(path, new RouteValueDictionary())) continue;
                matched = true;
                var ms = e.Metadata.GetMetadata<HttpMethodMetadata>()?.HttpMethods;
                if (ms == null || ms.Count == 0) anyMethod = true;
                else foreach (var m in ms) allowed.Add(m.ToUpperInvariant());
            }
            if (!matched) return Results.Json(Body(404), statusCode: 404);
            if (anyMethod || allowed.Contains(method.ToUpperInvariant()) || (HttpMethods.IsHead(method) && allowed.Contains("GET")))
                return Results.Json(Body(415), statusCode: 415); // 路径与方法都对，只剩 Content-Type 不匹配
            ctx.Response.Headers.Allow = string.Join(", ", allowed);
            return Results.Json(Body(405), statusCode: 405);
        });
    }

    /// <summary>仅 /api：空正文的错误响应（400/413/415 等框架直接给的）补一个中英文 JSON 正文。</summary>
    public static void UseApiStatusBodies(this WebApplication app) =>
        app.UseStatusCodePages(async ctx =>
        {
            var r = ctx.HttpContext.Response;
            if (!ctx.HttpContext.Request.Path.StartsWithSegments("/api")) return;
            r.ContentType = "application/json; charset=utf-8";
            await r.WriteAsJsonAsync(Body(r.StatusCode));
        });
}
