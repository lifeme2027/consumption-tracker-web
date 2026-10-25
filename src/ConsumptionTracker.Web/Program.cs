using System.Threading.RateLimiting;
using ConsumptionTracker.Web;
using ConsumptionTracker.Web.Api;
using ConsumptionTracker.Web.Auth;
using ConsumptionTracker.Web.Storage;
using Microsoft.AspNetCore.RateLimiting;

var builder = WebApplication.CreateBuilder(args);

var options = builder.Configuration.GetSection(LifeOptions.Section).Get<LifeOptions>() ?? new LifeOptions();

builder.WebHost.ConfigureKestrel(k =>
{
    k.AddServerHeader = false;
    k.Limits.MaxRequestBodySize = options.Limits.ImportBodyBytes;
});
builder.Services.Configure<Microsoft.AspNetCore.Builder.IISServerOptions>(o => o.MaxRequestBodySize = options.Limits.ImportBodyBytes);

// 日志：不记录请求体/记录内容。框架日志只保留 Warning 以上（见 appsettings.json）。
builder.Services.AddSingleton(options);
builder.Services.AddSingleton(TimeProvider.System);
builder.Services.AddSingleton(sp =>
{
    var env = sp.GetRequiredService<IWebHostEnvironment>();
    var dir = Path.IsPathRooted(options.Storage.DataDir) ? options.Storage.DataDir : Path.Combine(env.ContentRootPath, options.Storage.DataDir);
    return new Database(Path.Combine(dir, options.Storage.DatabaseFile));
});
builder.Services.AddSingleton<UserStore>();
builder.Services.AddSingleton<MaintenanceService>();
builder.Services.AddHostedService(sp => sp.GetRequiredService<MaintenanceService>());
builder.Services.AddSingleton<ChallengeStore>();
builder.Services.AddSingleton<SessionStore>();
builder.Services.AddSingleton<AuthService>();

builder.Services.AddRateLimiter(rl =>
{
    rl.RejectionStatusCode = StatusCodes.Status429TooManyRequests;
    rl.OnRejected = async (ctx, ct) =>
    {
        // 真实的剩余等待秒数（向上取整，至少 1），而不是固定 60
        var wait = ctx.Lease.TryGetMetadata(MetadataName.RetryAfter, out var ra) ? ra : TimeSpan.FromSeconds(60);
        var secs = Math.Max(1, (int)Math.Ceiling(wait.TotalSeconds));
        ctx.HttpContext.Response.Headers.RetryAfter = secs.ToString(System.Globalization.CultureInfo.InvariantCulture);
        await ctx.HttpContext.Response.WriteAsJsonAsync(new
        {
            error = $"请求过于频繁，请 {secs} 秒后再试",
            errorEn = $"Too many requests. Please try again in {secs} seconds.",
            retryAfterSeconds = secs,
        }, ct);
    };
    static string Ip(HttpContext c) => c.Connection.RemoteIpAddress?.ToString() ?? "unknown";
    RateLimitPartition<string> Win(HttpContext c, string prefix, int n) =>
        RateLimitPartition.Get(prefix + Ip(c), _ => new ClockFixedWindowLimiter(n, TimeSpan.FromMinutes(1), c.RequestServices.GetRequiredService<TimeProvider>()));
    rl.AddPolicy("challenge", c => Win(c, "c:", options.Limits.ChallengePerMinute));
    rl.AddPolicy("verify", c => Win(c, "v:", options.Limits.VerifyPerMinute));
    rl.AddPolicy("api", c => Win(c, "a:", options.Limits.ApiPerMinute));
});

var app = builder.Build();

// 启动即建库（并在配置异常时尽早失败）
app.Services.GetRequiredService<Database>();

app.UseSecurityHeaders();
if (!app.Environment.IsDevelopment())
{
    app.UseExceptionHandler(e => e.Run(async ctx =>
    {
        ctx.Response.StatusCode = 500;
        await ctx.Response.WriteAsJsonAsync(new { error = "服务器内部错误" });
    }));
}
app.UseRateLimiter();
app.UseApiGuards(options);
app.UseDefaultFiles();
app.UseStaticFiles();

app.MapGet("/healthz", () => Results.Text("ok"));
app.MapLifeApi(options);
app.Map("/api/{**rest}", () => Results.Json(new { error = "接口不存在" }, statusCode: 404));

app.Run();

public partial class Program;
