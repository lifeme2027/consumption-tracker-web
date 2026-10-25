using System.Net;

namespace ConsumptionTracker.Web.Tests;

/// <summary>L-8：/api/records/query 分页。count / totalCents 始终是全部命中记录的合计，records 只是当前页。</summary>
public class QueryPaginationTests : IDisposable
{
    private readonly TestApp _app = new() { Settings = { ["Life:Query:DefaultPageSize"] = "5", ["Life:Query:MaxPageSize"] = "8" } };
    public void Dispose() => _app.Dispose();

    private async Task<HttpClient> Seed(int n)
    {
        var c = await _app.LoginAsync(new TestWallet());
        for (int i = 0; i < n; i++) await c.AddAsync(Http.Rec(name: "药" + i.ToString("00"), priceCents: 100 + i, qty: 1, date: "2026-10-" + (10 + i % 10)));
        return c;
    }
    private static async Task<System.Text.Json.JsonElement> Q(HttpClient c, object body)
    {
        var r = await c.Post("/api/records/query", body);
        Assert.Equal(HttpStatusCode.OK, r.StatusCode);
        return await r.J();
    }

    [Fact]
    public async Task NoLimit_UsesDefaultPageSize_AndReportsTotals()
    {
        var c = await Seed(12);
        var j = await Q(c, new { });
        Assert.Equal(5, j.GetProperty("records").GetArrayLength());
        Assert.Equal(5, j.GetProperty("returned").GetInt32());
        Assert.Equal(12, j.GetProperty("count").GetInt32());   // 全部命中数，旧前端仍显示正确
        Assert.Equal(12, j.GetProperty("total").GetInt32());
        Assert.Equal(0, j.GetProperty("offset").GetInt32());
        Assert.Equal(5, j.GetProperty("limit").GetInt32());
        Assert.True(j.GetProperty("hasMore").GetBoolean());
        Assert.Equal(Enumerable.Range(0, 12).Sum(i => 100L + i), j.GetProperty("totalCents").GetInt64());
    }

    [Fact]
    public async Task Pages_Concatenate_ToFullSet_WithoutOverlap()
    {
        var c = await Seed(12);
        var ids = new List<string>();
        for (int off = 0, guard = 0; guard < 10; guard++)
        {
            var j = await Q(c, new { limit = 5, offset = off });
            foreach (var r in j.GetProperty("records").EnumerateArray()) ids.Add(r.GetProperty("id").GetString()!);
            off += j.GetProperty("returned").GetInt32();
            if (!j.GetProperty("hasMore").GetBoolean()) break;
        }
        var all = await Q(c, new { limit = 8 });
        Assert.Equal(12, ids.Count);
        Assert.Equal(12, ids.Distinct().Count());
        Assert.Equal(all.GetProperty("records").EnumerateArray().Take(8).Select(r => r.GetProperty("id").GetString()), ids.Take(8));
    }

    [Fact]
    public async Task LastPage_HasMoreFalse_AndOffsetPastEnd_IsEmpty()
    {
        var c = await Seed(12);
        var last = await Q(c, new { limit = 5, offset = 10 });
        Assert.Equal(2, last.GetProperty("returned").GetInt32());
        Assert.False(last.GetProperty("hasMore").GetBoolean());
        var past = await Q(c, new { limit = 5, offset = 500 });
        Assert.Equal(0, past.GetProperty("records").GetArrayLength());
        Assert.False(past.GetProperty("hasMore").GetBoolean());
        Assert.Equal(12, past.GetProperty("count").GetInt32());
        var exact = await Q(c, new { limit = 6, offset = 6 });
        Assert.False(exact.GetProperty("hasMore").GetBoolean());
    }

    [Fact]
    public async Task Filters_ApplyBeforePaging_TotalsCoverAllMatches()
    {
        var c = await Seed(12);
        var j = await Q(c, new { keyword = "药0", limit = 3 });   // 药00..药09 共 10 条
        Assert.Equal(10, j.GetProperty("count").GetInt32());
        Assert.Equal(3, j.GetProperty("records").GetArrayLength());
        Assert.True(j.GetProperty("hasMore").GetBoolean());
        Assert.Equal(Enumerable.Range(0, 10).Sum(i => 100L + i), j.GetProperty("totalCents").GetInt64());
    }

    [Theory]
    [InlineData(0, 0)]
    [InlineData(-1, 0)]
    [InlineData(9, 0)]      // > MaxPageSize(8)
    [InlineData(5, -1)]
    public async Task InvalidLimitOrOffset_Is400_Bilingual(int limit, int offset)
    {
        var c = await Seed(1);
        var r = await c.Post("/api/records/query", new { limit, offset });
        Assert.Equal(HttpStatusCode.BadRequest, r.StatusCode);
        var j = await r.J();
        Assert.False(string.IsNullOrWhiteSpace(j.GetProperty("error").GetString()));
        Assert.False(string.IsNullOrWhiteSpace(j.GetProperty("errorEn").GetString()));
    }

    [Fact]
    public async Task OldClientBody_StillWorks_AndSmallSetsReturnEverything()
    {
        var c = await Seed(3);
        var j = await Q(c, new { from = "2026-10-01", to = "2026-10-31", keyword = "" });
        Assert.Equal(3, j.GetProperty("records").GetArrayLength());
        Assert.False(j.GetProperty("hasMore").GetBoolean());
        Assert.Equal(3, j.GetProperty("count").GetInt32());
    }

    [Fact]
    public void Defaults_AreSane()
    {
        var o = new LifeOptions().Query;
        Assert.Equal(2000, o.DefaultPageSize);
        Assert.Equal(5000, o.MaxPageSize);
    }
}
