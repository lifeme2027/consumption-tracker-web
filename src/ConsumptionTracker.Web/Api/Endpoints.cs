using System.Text;
using ConsumptionTracker.Core.Models;
using ConsumptionTracker.Core.Services;
using ConsumptionTracker.Web.Auth;
using ConsumptionTracker.Web.Storage;
using Microsoft.AspNetCore.Http.Features;

namespace ConsumptionTracker.Web.Api;

public static class Endpoints
{
    private const string AddressKey = "ct.address";
    private const string TokenKey = "ct.token";

    public static void MapLifeApi(this WebApplication app, LifeOptions opt)
    {
        var devLogin = app.Environment.IsDevelopment() && opt.Auth.DevLogin;
        var api = app.MapGroup("/api");

        api.MapGet("/config", () => Results.Ok(new
        {
            domain = opt.Auth.Domain,
            network = opt.Kaspa.Network,
            devLogin,
            categories = Defaults.Categories,
            limits = new
            {
                name = RecordLimits.MaxName, note = RecordLimits.MaxNote, barcode = RecordLimits.MaxBarcode,
                batch = RecordLimits.MaxBatchName, patient = RecordLimits.MaxPatient, dosage = RecordLimits.MaxDosage,
            },
        }));

        // ---------------- 登录 ----------------
        var auth = api.MapGroup("/auth");

        auth.MapPost("/challenge", (AddressRequest body, AuthService svc) =>
        {
            var r = svc.IssueChallenge(body?.Address);
            return r.Ok
                ? Results.Ok(new { nonce = r.Challenge!.Nonce, message = r.Challenge.Message, expiresAt = r.Challenge.ExpiresAt })
                : Results.Json(new { error = r.Error }, statusCode: r.Status);
        }).RequireRateLimiting("challenge");

        auth.MapPost("/verify", (VerifyRequest body, AuthService svc, HttpContext ctx) =>
        {
            var r = svc.Verify(body?.Address, body?.Nonce, body?.Signature);
            if (!r.Ok) return Results.Json(new { error = r.Error }, statusCode: r.Status);
            SetCookie(ctx, opt, r.Token!, r.ExpiresAt);
            return Results.Ok(new { address = r.Address, expiresAt = r.ExpiresAt });
        }).RequireRateLimiting("verify");

        if (devLogin)
        {
            // 仅 Development 环境 + Life:Auth:DevLogin=true 才存在；生产环境此路由根本不会注册（404）。
            auth.MapPost("/dev-login", (AddressRequest body, AuthService svc, HttpContext ctx) =>
            {
                var r = svc.DevLogin(body?.Address);
                if (!r.Ok) return Results.Json(new { error = r.Error }, statusCode: r.Status);
                SetCookie(ctx, opt, r.Token!, r.ExpiresAt);
                return Results.Ok(new { address = r.Address, expiresAt = r.ExpiresAt });
            }).RequireRateLimiting("verify");
        }

        auth.MapGet("/me", (HttpContext ctx, AuthService svc) =>
        {
            var addr = svc.Authenticate(ctx.Request.Cookies[opt.Cookie.Name]);
            return addr == null ? Results.Json(new { error = "未登录" }, statusCode: 401) : Results.Ok(new { address = addr });
        }).RequireRateLimiting("api");

        auth.MapPost("/logout", (HttpContext ctx, AuthService svc) =>
        {
            svc.Logout(ctx.Request.Cookies[opt.Cookie.Name]);
            ctx.Response.Cookies.Delete(opt.Cookie.Name, CookieOptions(ctx, opt, null));
            return Results.Ok(new { ok = true });
        });

        // ---------------- 需要登录的接口 ----------------
        var secured = api.MapGroup("")
            .RequireRateLimiting("api")
            .AddEndpointFilter(async (fc, next) =>
            {
                var ctx = fc.HttpContext;
                var token = ctx.Request.Cookies[opt.Cookie.Name];
                var addr = ctx.RequestServices.GetRequiredService<AuthService>().Authenticate(token);
                if (addr == null) return Results.Json(new { error = "未登录或会话已过期" }, statusCode: 401);
                ctx.Items[AddressKey] = addr;
                ctx.Items[TokenKey] = token;
                return await next(fc);
            });

        secured.MapGet("/meta", (HttpContext ctx, UserStore store) =>
        {
            var repo = Repo(ctx, store);
            var cats = Defaults.Categories.Concat(repo.ListCategories()).Distinct().ToList();
            return Results.Ok(new
            {
                address = Addr(ctx),
                categories = cats,
                batches = repo.ListBatches().Select(b => new { batchId = b.BatchId, batchName = b.BatchName, count = b.Count }),
            });
        });

        secured.MapPost("/products/lookup", (BarcodeRequest body, HttpContext ctx, UserStore store) =>
        {
            var p = Repo(ctx, store).FindProduct(body?.Barcode ?? "");
            return Results.Ok(p == null
                ? new { found = false, name = "", category = "", lastPriceCents = (long?)null }
                : new { found = true, name = p.Name, category = p.Category, lastPriceCents = p.LastPriceCents });
        });

        // 记录：查询用 POST + JSON 体，避免关键词出现在 URL / IIS 访问日志里
        secured.MapPost("/records/query", (QueryRequest body, HttpContext ctx, UserStore store) =>
        {
            var q = ToQuery(body, out var err);
            if (err != null) return Bad(err);
            var qo = opt.Query;
            var limit = body?.Limit ?? qo.DefaultPageSize;
            var offset = body?.Offset ?? 0;
            if (limit < 1 || limit > qo.MaxPageSize)
                return Bad($"limit 必须在 1 到 {qo.MaxPageSize} 之间", $"limit must be between 1 and {qo.MaxPageSize}");
            if (offset < 0) return Bad("offset 不能为负数", "offset must not be negative");
            var rows = Repo(ctx, store).Query(q);
            var page = rows.Skip(offset).Take(limit).ToList();
            return Results.Ok(new
            {
                records = page.Select(RecordDto.From),
                // count / totalCents 是全部命中记录的合计（与分页无关），旧前端不改也显示正确
                count = rows.Count,
                totalCents = Stats.TotalCents(rows),
                total = rows.Count,
                offset,
                limit,
                returned = page.Count,
                hasMore = offset + page.Count < rows.Count,
            });
        });

        secured.MapGet("/records/{id}", (string id, HttpContext ctx, UserStore store) =>
        {
            var r = Repo(ctx, store).Get(id);
            return r == null ? NotFound() : Results.Ok(RecordDto.From(r));
        });

        secured.MapPost("/records", (RecordInput body, HttpContext ctx, UserStore store) =>
        {
            var item = ToItem(body, out var err);
            if (err != null) return Bad(err);
            try { return Results.Created("/api/records/" + item!.Id, RecordDto.From(Repo(ctx, store).Add(item))); }
            catch (Exception e) when (e is ArgumentException or InvalidOperationException) { return Bad(e.Message); }
        });

        secured.MapPut("/records/{id}", (string id, RecordInput body, HttpContext ctx, UserStore store) =>
        {
            var item = ToItem(body, out var err);
            if (err != null) return Bad(err);
            try
            {
                var r = Repo(ctx, store).Update(item! with { Id = id });
                return r == null ? NotFound() : Results.Ok(RecordDto.From(r));
            }
            catch (ArgumentException e) { return Bad(e.Message); }
        });

        secured.MapDelete("/records/{id}", (string id, HttpContext ctx, UserStore store) =>
            Repo(ctx, store).Delete(new[] { id }) > 0 ? Results.Ok(new { deleted = 1 }) : NotFound());

        secured.MapPost("/records/delete", (IdsRequest body, HttpContext ctx, UserStore store) =>
        {
            if (body?.Ids is not { Count: > 0 and <= 1000 } ids) return Bad("请提供 1~1000 个记录 ID");
            return Results.Ok(new { deleted = Repo(ctx, store).Delete(ids) });
        });

        // 撤销删除：写回原记录（含原 id/createdAt/批次）；只作用于当前地址，逐条走与新增相同的校验
        secured.MapPost("/records/restore", (RestoreRequest body, HttpContext ctx, UserStore store) =>
        {
            if (body?.Records is not { Count: > 0 and <= 1000 } list) return Bad("请提供 1~1000 条要恢复的记录");
            var items = new List<RecordItem>();
            foreach (var d in list)
            {
                if (d == null || string.IsNullOrWhiteSpace(d.Id)) return Bad("要恢复的记录缺少 ID");
                var item = RecordValidator.Sanitize(new RecordItem
                {
                    Id = d.Id, Barcode = d.Barcode ?? "", Name = d.Name ?? "", PriceCents = d.PriceCents, Quantity = d.Quantity,
                    Category = d.Category ?? "", Note = d.Note ?? "", BatchId = d.BatchId ?? "", BatchName = d.BatchName ?? "",
                    Patient = d.Patient ?? "", Dosage = d.Dosage ?? "", Date = d.Date ?? "", CreatedAt = d.CreatedAt,
                });
                if (item == null) return Bad("要恢复的记录无效");
                var limit = RecordLimits.Check(item);
                if (limit != null) return Bad(limit);
                items.Add(item);
            }
            try
            {
                var s = Repo(ctx, store).Import(items, Array.Empty<Product>(), ImportMode.Merge);
                return Results.Ok(new { restored = s.Added + s.Updated });
            }
            catch (InvalidOperationException e) { return Bad(e.Message); }
        });

        secured.MapPost("/records/batch", (BatchAssignRequest body, HttpContext ctx, UserStore store) =>
        {
            if (body?.Ids is not { Count: > 0 and <= 1000 } ids) return Bad("请提供 1~1000 个记录 ID");
            var name = (body.Name ?? "").Trim();
            if (name.Length > RecordLimits.MaxBatchName) return Bad("批次名过长");
            return Results.Ok(new { updated = Repo(ctx, store).AssignBatch(ids, name) });
        });

        // 统计：与列表使用同一个 Query + 同一套金额算法，所以必然一致
        secured.MapGet("/stats", (string? month, string? day, HttpContext ctx, UserStore store) =>
        {
            month ??= DateUtil.Today()[..7];
            if (month.Length != 7 || !DateUtil.IsValid(month + "-01")) return Bad("月份格式应为 YYYY-MM");
            day ??= DateUtil.Today();
            if (!DateUtil.IsValid(day)) return Bad("日期格式应为 YYYY-MM-DD");
            var (from, to) = DateUtil.MonthRange(month);
            var repo = Repo(ctx, store);
            var rows = repo.Query(new RecordQuery { From = from, To = to });
            var dayRows = repo.Query(new RecordQuery { From = day, To = day });
            return Results.Ok(new
            {
                month,
                monthTotalCents = Stats.TotalCents(rows),
                monthCount = rows.Count,
                day,
                dayTotalCents = Stats.TotalCents(dayRows),
                dayCount = dayRows.Count,
                categories = Stats.SumByCategory(rows).Select(c => new { category = c.Key, cents = c.Cents, count = c.Count, ratio = c.Ratio }),
                days = Stats.SumByDay(rows).Select(b => new { date = b.Key, cents = b.Cents, count = b.Count }),
            });
        });

        // ---------------- 导出 / 导入 / 一键删除 ----------------
        secured.MapGet("/export.json", (HttpContext ctx, UserStore store) =>
        {
            var repo = Repo(ctx, store);
            var json = BackupService.BuildJson(repo.Query(), repo.ListProducts());
            return File(ctx, Encoding.UTF8.GetBytes(json), "application/json; charset=utf-8", $"consumption-{DateUtil.Today()}.json");
        });

        secured.MapGet("/export.csv", (HttpContext ctx, UserStore store) =>
        {
            var csv = CsvService.ToCsv(Repo(ctx, store).Query()); // 字符串已带 BOM，用无 BOM 编码避免双重 BOM
            return File(ctx, new UTF8Encoding(false).GetBytes(csv), "text/csv; charset=utf-8", $"consumption-{DateUtil.Today()}.csv");
        });

        secured.MapPost("/import", async (string? mode, string? confirm, HttpContext ctx, UserStore store) =>
        {
            var importMode = string.Equals(mode, "replace", StringComparison.OrdinalIgnoreCase) ? ImportMode.Replace : ImportMode.Merge;
            if (importMode == ImportMode.Replace && confirm != "yes") return Bad("覆盖导入会清空现有数据，需要确认（confirm=yes）", "Replace-import clears your existing data and needs confirmation (confirm=yes)");
            var limit = ctx.Features.Get<IHttpMaxRequestBodySizeFeature>();
            if (limit is { IsReadOnly: false }) limit.MaxRequestBodySize = opt.Limits.ImportBodyBytes;
            string text;
            try
            {
                using var reader = new StreamReader(ctx.Request.Body, new UTF8Encoding(false), true);
                text = await reader.ReadToEndAsync();
            }
            catch (BadHttpRequestException) { return Results.Json(new { error = "文件过大", errorEn = "The file is too large" }, statusCode: 413); }
            if (string.IsNullOrWhiteSpace(text)) return Bad("内容为空", "The content is empty");

            ImportResult parsed;
            try { parsed = text.TrimStart('\uFEFF', ' ', '\t', '\r', '\n').StartsWith('{') ? BackupService.ParseJson(text) : CsvService.Parse(text); }
            catch (InvalidDataException e) when (ImportFormat.English(e) is { } en)
            { return Bad(e.Message, en); }   // Core 给出的具体原因（中英文）
            catch (Exception e) when (e is FormatException or System.Text.Json.JsonException or InvalidDataException or ArgumentException or OverflowException or InvalidOperationException)
            { return Bad("无法解析导入内容，请确认是本应用导出的 JSON 或 CSV", "Could not read the import content; please use a JSON or CSV file exported by this app"); }

            var totalRows = parsed.Records.Count + parsed.Issues.Count;
            // 覆盖模式：全量预检——只要有一条不合格就整体中止，返回逐条原因，绝不清空现有数据
            if (importMode == ImportMode.Replace && parsed.Issues.Count > 0)
                return Rejected(parsed.Issues, totalRows);
            try
            {
                var s = Repo(ctx, store).Import(parsed.Records, parsed.Products, importMode);
                var skipped = s.Skipped + parsed.Issues.Count;
                return Results.Ok(new { added = s.Added, updated = s.Updated, skipped, skippedRows = IssueRows(parsed.Issues), total = totalRows });
            }
            catch (ImportRejectedException e) { return Rejected(e.Issues, e.Total); }
            catch (InvalidOperationException e) { return Bad(e.Message); }
        });

        secured.MapPost("/account/delete-data", (ConfirmRequest body, HttpContext ctx, UserStore store) =>
        {
            if (body?.Confirm != "DELETE") return Bad("需要二次确认：confirm 必须为 DELETE");
            return Results.Ok(new { deleted = Repo(ctx, store).DeleteAll() });
        });
    }

    // ---------------- helpers ----------------

    private static string Addr(HttpContext ctx) => (string)ctx.Items[AddressKey]!;
    private static UserRepository Repo(HttpContext ctx, UserStore store) => store.ForUser(Addr(ctx));
    private static IResult Bad(string? msg, string? en = null) =>
        Results.Json(new { error = msg ?? "请求无效", errorEn = en ?? (msg is null ? "Invalid request" : null) }, statusCode: 400);
    private const int MaxIssueRows = 200;   // 响应里最多列出的行数；总数另有 rejectedCount / skipped

    private static object[] IssueRows(IReadOnlyList<ImportIssue> issues) =>
        issues.Take(MaxIssueRows).Select(i => (object)new { row = i.Row, label = i.Label, labelEn = i.LabelEn, reason = i.Reason, reasonEn = i.ReasonEn }).ToArray();

    private static IResult Rejected(IReadOnlyList<ImportIssue> issues, int total) =>
        Results.Json(new
        {
            error = $"导入已中止：{total} 条中有 {issues.Count} 条不合格，现有数据没有任何改动",
            errorEn = $"Import aborted: {issues.Count} of {total} records are invalid; your existing data was not changed",
            rejected = IssueRows(issues), rejectedCount = issues.Count, total,
        }, statusCode: 422);

    private static IResult NotFound() => Results.Json(new { error = "记录不存在" }, statusCode: 404);

    private static IResult File(HttpContext ctx, byte[] bytes, string contentType, string fileName)
    {
        ctx.Response.Headers.ContentDisposition = $"attachment; filename=\"{fileName}\"";
        return Results.Bytes(bytes, contentType);
    }

    private static RecordItem? ToItem(RecordInput? b, out string? error)
    {
        error = null;
        if (b == null) { error = "请求体为空"; return null; }
        if (b.PriceCents is null or < 0) { error = "价格不能为空或为负"; return null; }
        var item = new RecordItem
        {
            Barcode = (b.Barcode ?? "").Trim(),
            Name = (b.Name ?? "").Trim(),
            PriceCents = b.PriceCents.Value,
            Quantity = b.Quantity ?? 1m,
            Category = (b.Category ?? "").Trim(),
            Note = b.Note ?? "",
            Date = (b.Date ?? "").Trim(),
            BatchName = (b.BatchName ?? "").Trim(),
            Patient = (b.Patient ?? "").Trim(),
            Dosage = (b.Dosage ?? "").Trim(),
        };
        var errs = RecordValidator.Validate(item);
        if (errs.Count > 0) { error = string.Join("；", errs); return null; }
        error = RecordLimits.Check(item);
        return error == null ? item : null;
    }

    private static RecordQuery ToQuery(QueryRequest? b, out string? error)
    {
        error = null;
        if (b == null) return new RecordQuery();
        if (!string.IsNullOrEmpty(b.From) && !DateUtil.IsValid(b.From)) error = "起始日期格式无效";
        if (!string.IsNullOrEmpty(b.To) && !DateUtil.IsValid(b.To)) error = "结束日期格式无效";
        if ((b.Keyword?.Length ?? 0) > 100) error = "关键词过长";
        return new RecordQuery { From = b.From, To = b.To, Category = b.Category, BatchId = b.BatchId, Keyword = b.Keyword };
    }

    private static CookieOptions CookieOptions(HttpContext ctx, LifeOptions opt, DateTimeOffset? expires) => new()
    {
        HttpOnly = true,
        SameSite = SameSiteMode.Strict,
        Secure = ctx.RequestServices.GetRequiredService<IWebHostEnvironment>().IsDevelopment()
            ? ctx.Request.IsHttps
            : opt.Cookie.RequireSecure,
        Path = "/",
        Expires = expires,
        IsEssential = true,
    };

    private static void SetCookie(HttpContext ctx, LifeOptions opt, string token, DateTimeOffset expires) =>
        ctx.Response.Cookies.Append(opt.Cookie.Name, token, CookieOptions(ctx, opt, expires));
}
