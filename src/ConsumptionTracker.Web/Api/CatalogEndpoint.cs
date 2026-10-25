using System.Text.Json;
using ConsumptionTracker.Core.Services;
using ConsumptionTracker.Web.Catalog;
using Microsoft.AspNetCore.Http.Features;

namespace ConsumptionTracker.Web.Api;

/// <summary>
/// POST /api/catalog/lookup  body {"barcode":"…"}  → {available, found, name, category, unit, spec, salePriceCents}。
/// 为什么是 POST：条码不能出现在 URL 里（IIS 访问日志会记录 URL）。无需登录、不读 Cookie；仍走 /api 的同源校验（X-Requested-With + Origin）。
/// 请求体由本处理器手工解析（不用框架参数绑定），这样框架的 JSON 绑定失败日志/异常消息里也不会出现请求体片段；
/// 处理器不注入日志接口、不写日志。响应 Cache-Control: no-store。服务端不保存条码。
/// </summary>
public static class CatalogEndpoint
{
    public static void MapCatalogLookup(this RouteGroupBuilder api)
    {
        api.MapPost("/catalog/lookup", async (HttpContext ctx, CatalogLookup catalog) =>
        {
            ctx.Response.Headers.CacheControl = "no-store";
            if (!ctx.Request.HasJsonContentType()) return Results.Json(ApiErrors.Body(415), statusCode: 415);
            string? raw;
            try
            {
                var lim = ctx.Features.Get<IHttpMaxRequestBodySizeFeature>();
                if (lim is { IsReadOnly: false }) lim.MaxRequestBodySize = 1024;   // 条码 ≤64 字，请求体不需要更大
                using var doc = await JsonDocument.ParseAsync(ctx.Request.Body, cancellationToken: ctx.RequestAborted);
                raw = doc.RootElement.ValueKind == JsonValueKind.Object
                      && doc.RootElement.TryGetProperty("barcode", out var p) && p.ValueKind == JsonValueKind.String
                    ? p.GetString() : null;
            }
            catch (OperationCanceledException) { throw; }
            catch { return Bad("请求格式有误（JSON 无效或为空）", "Malformed request (invalid or empty JSON body)"); }

            var code = (raw ?? "").Trim();
            if (code.Length == 0) return Bad("条码不能为空", "The barcode must not be empty");
            if (code.Length > RecordLimits.MaxBarcode) return Bad($"条码过长（最多 {RecordLimits.MaxBarcode} 字）", $"The barcode is too long (max {RecordLimits.MaxBarcode} characters)");

            var r = catalog.Lookup(code);
            return Results.Ok(new { available = r.Available, found = r.Found, name = r.Name, category = r.Category, unit = r.Unit, spec = r.Spec, salePriceCents = r.SalePriceCents });
        }).RequireRateLimiting("catalog");
    }

    private static IResult Bad(string zh, string en) => Results.Json(new { error = zh, errorEn = en }, statusCode: 400);
}
