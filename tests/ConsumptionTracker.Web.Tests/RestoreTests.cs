using System.Net;
using System.Text;

namespace ConsumptionTracker.Web.Tests;

/// <summary>删除撤销（POST /api/records/restore）：原样写回，仍受登录、CSRF、每地址隔离与校验约束。</summary>
public class RestoreTests : IDisposable
{
    private readonly TestApp _app = new();
    public void Dispose() => _app.Dispose();

    [Fact]
    public async Task Restore_RequiresLogin_AndCsrfHeader()
    {
        var anon = _app.NewClient();
        Assert.Equal(HttpStatusCode.Unauthorized, (await anon.Post("/api/records/restore", new { records = new object[0] })).StatusCode);

        var c = await _app.LoginAsync(new TestWallet());
        var noHeader = new HttpRequestMessage(HttpMethod.Post, "/api/records/restore") { Content = new StringContent("{\"records\":[]}", Encoding.UTF8, "application/json") };
        Assert.Equal(HttpStatusCode.Forbidden, (await c.SendAsync(noHeader)).StatusCode);
    }

    [Fact]
    public async Task Delete_ThenRestore_PutsBackSameIdCreatedAtAndBatch()
    {
        var c = await _app.LoginAsync(new TestWallet());
        var id = await c.AddAsync(Http.Rec(note: "饭后", patient: "妈妈", dosage: "0.5g", batch: "方1"));
        var before = await (await c.GetAsync($"/api/records/{id}")).J();

        Assert.Equal(HttpStatusCode.OK, (await c.Del($"/api/records/{id}")).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await c.GetAsync($"/api/records/{id}")).StatusCode);

        var r = await c.Post("/api/records/restore", new { records = new[] { before } });
        Assert.Equal(HttpStatusCode.OK, r.StatusCode);
        Assert.Equal(1, (await r.J()).GetProperty("restored").GetInt32());

        var after = await (await c.GetAsync($"/api/records/{id}")).J();
        Assert.Equal(before.ToString(), after.ToString());   // 逐字段相同：id、createdAt、batchId、金额…
    }

    [Fact]
    public async Task Restore_RejectsInvalid_AndWritesNothing()
    {
        var c = await _app.LoginAsync(new TestWallet());
        var bad = new object[]
        {
            new { id = "", name = "x", priceCents = 1, quantity = 1, date = "2026-10-20" },
            new { id = "a", name = "", priceCents = 1, quantity = 1, date = "2026-10-20" },
            new { id = "a", name = "x", priceCents = 1, quantity = 0, date = "2026-10-20" },
            new { id = "a", name = "x", priceCents = 1, quantity = 1, date = "bad" },
            new { id = "a", name = "x", priceCents = 1, quantity = 1, date = "2026-10-20", note = new string('n', 1001) },
            new { id = "a", name = "x", priceCents = 100_000_000_001, quantity = 1, date = "2026-10-20" },
        };
        foreach (var b in bad)
            Assert.Equal(HttpStatusCode.BadRequest, (await c.Post("/api/records/restore", new { records = new[] { b } })).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await c.Post("/api/records/restore", new { records = new object[0] })).StatusCode);
        Assert.Equal(0, (await (await c.Post("/api/records/query", new { })).J()).GetProperty("count").GetInt32());
    }

    [Fact]
    public async Task Restore_IsPerAddress_BCannotOverwriteA()
    {
        var a = await _app.LoginAsync(new TestWallet());
        var b = await _app.LoginAsync(new TestWallet());
        var id = await a.AddAsync(Http.Rec(name: "A的药"));
        var rec = await (await a.GetAsync($"/api/records/{id}")).J();

        // B 用 A 的 id 恢复一条不同内容：只会写进 B 自己的库，A 不受影响
        var r = await b.Post("/api/records/restore", new { records = new[] { new { id, name = "B的", priceCents = 1, quantity = 1, date = "2026-10-20" } } });
        Assert.Equal(HttpStatusCode.OK, r.StatusCode);
        Assert.Equal(rec.ToString(), (await (await a.GetAsync($"/api/records/{id}")).J()).ToString());
        Assert.Equal("B的", (await (await b.GetAsync($"/api/records/{id}")).J()).GetProperty("name").GetString());
    }
}
