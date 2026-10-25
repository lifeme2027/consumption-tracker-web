using ConsumptionTracker.Core.Models;
using ConsumptionTracker.Core.Services;
using ConsumptionTracker.Web;
using ConsumptionTracker.Web.Storage;

namespace ConsumptionTracker.Web.Tests;

public sealed class RepoFixture : IDisposable
{
    public string Dir { get; } = Path.Combine(Path.GetTempPath(), "life-repo-" + Guid.NewGuid().ToString("N"));
    public LifeOptions Options { get; } = new();
    public UserStore Store { get; }
    public RepoFixture(int maxRecords = 50000)
    {
        Options.Storage.MaxRecordsPerUser = maxRecords;
        Store = new UserStore(new Database(Path.Combine(Dir, "t.db")), Options);
    }
    public UserRepository User(TestWallet w) => Store.ForUser(w.Address);
    public void Dispose()
    {
        ConsumptionTracker.Web.Storage.Database.ClearPoolFor(Path.Combine(Dir, "t.db"));
        try { Directory.Delete(Dir, true); } catch { }
    }
}

public class RepositoryTests : IDisposable
{
    private readonly RepoFixture _f = new();
    private readonly TestWallet _a = new(), _b = new();
    public void Dispose() => _f.Dispose();

    private static RecordItem R(string name = "阿莫西林", long cents = 1250, decimal qty = 2, string cat = "药品", string date = "2026-10-20",
        string barcode = "6901", string batch = "", string note = "") =>
        new() { Name = name, PriceCents = cents, Quantity = qty, Category = cat, Date = date, Barcode = barcode, BatchName = batch, Note = note };

    [Fact]
    public void Crud_AddGetUpdateDelete()
    {
        var repo = _f.User(_a);
        var added = repo.Add(R(note: "饭后"));
        Assert.Equal(2500, added.AmountCents);
        Assert.Equal("饭后", repo.Get(added.Id)!.Note);

        var upd = repo.Update(added with { Name = "头孢", PriceCents = 2000, Quantity = 1.5m });
        Assert.NotNull(upd);
        Assert.Equal("头孢", repo.Get(added.Id)!.Name);
        Assert.Equal(3000, repo.Get(added.Id)!.AmountCents);
        Assert.Equal(added.CreatedAt, repo.Get(added.Id)!.CreatedAt);

        Assert.Equal(1, repo.Delete(new[] { added.Id }));
        Assert.Null(repo.Get(added.Id));
        Assert.Equal(0, repo.Delete(new[] { added.Id }));
    }

    [Fact]
    public void Add_RejectsInvalid()
    {
        var repo = _f.User(_a);
        Assert.Throws<ArgumentException>(() => repo.Add(R(name: "")));
        Assert.Throws<ArgumentException>(() => repo.Add(R(cents: -1)));
        Assert.Throws<ArgumentException>(() => repo.Add(R(qty: 0)));
        Assert.Throws<ArgumentException>(() => repo.Add(R(date: "2026-13-40")));
        Assert.Throws<ArgumentException>(() => repo.Add(R(name: new string('x', 101))));
        Assert.Throws<ArgumentException>(() => repo.Add(R(cents: RecordLimits.MaxPriceCents + 1)));
        Assert.Throws<ArgumentException>(() => repo.Add(R(qty: 1_000_001m)));
        Assert.Throws<ArgumentException>(() => repo.Add(R(qty: 0.0000001m)));
        Assert.Equal(0, repo.Count());
    }

    [Fact]
    public void Filters_ByDateCategoryBatchKeyword()
    {
        var repo = _f.User(_a);
        repo.Add(R("A药", date: "2026-10-01", batch: "方1"));
        repo.Add(R("B饭", cat: "餐饮", date: "2026-10-15", barcode: ""));
        repo.Add(R("C药", date: "2026-11-02", note: "Special"));
        Assert.Equal(2, repo.Query(new RecordQuery { From = "2026-10-01", To = "2026-10-31" }).Count);
        Assert.Equal(2, repo.Query(new RecordQuery { Category = "药品" }).Count);
        var bid = repo.ListBatches().Single().BatchId;
        Assert.Single(repo.Query(new RecordQuery { BatchId = bid }));
        Assert.Equal(2, repo.Query(new RecordQuery { BatchId = RecordQuery.NoBatch }).Count);
        Assert.Single(repo.Query(new RecordQuery { Keyword = "special" }));
        Assert.Equal("C药", repo.Query().First().Name); // 日期降序
    }

    [Fact]
    public void SameBatchName_ReusesBatchId_AndAssignWorks()
    {
        var repo = _f.User(_a);
        var r1 = repo.Add(R("a", batch: "方1"));
        var r2 = repo.Add(R("b", batch: "方1"));
        Assert.Equal(r1.BatchId, r2.BatchId);
        var r3 = repo.Add(R("c"));
        Assert.Equal(1, repo.AssignBatch(new[] { r3.Id }, "方1"));
        Assert.Equal(3, repo.ListBatches().Single().Count);
        Assert.Equal(3, repo.RenameBatch(r1.BatchId, "方2"));
        Assert.All(repo.Query(), r => Assert.Equal("方2", r.BatchName));
    }

    [Fact]
    public void Stats_AreConsistentWithList()
    {
        var repo = _f.User(_a);
        repo.Add(R("a", 333, 3m, "药品", "2026-10-05"));          // 999
        repo.Add(R("b", 199, 0.5m, "食品", "2026-10-05"));        // 99.5 -> 100
        repo.Add(R("c", 1000, 1m, "药品", "2026-10-31"));         // 1000
        repo.Add(R("d", 5000, 1m, "药品", "2026-11-01"));         // 另一个月
        var (from, to) = DateUtil.MonthRange("2026-10");
        var rows = repo.Query(new RecordQuery { From = from, To = to });
        Assert.Equal(999 + 100 + 1000, Stats.TotalCents(rows));
        Assert.Equal(Stats.TotalCents(rows), Stats.MonthTotal(repo.Query(), "2026-10"));
        Assert.Equal(1099, Stats.DayTotal(repo.Query(), "2026-10-05"));
        var shares = Stats.SumByCategory(rows);
        Assert.Equal(Stats.TotalCents(rows), shares.Sum(s => s.Cents));
        Assert.Equal(1.0, shares.Sum(s => s.Ratio), 6);
        Assert.Equal(Stats.TotalCents(rows), Stats.SumByDay(rows).Sum(b => b.Cents));
    }

    [Fact]
    public void Products_AreRemembered_PerAddress()
    {
        var ra = _f.User(_a); var rb = _f.User(_b);
        ra.Add(R("药A", 880, barcode: "123"));
        Assert.Equal("药A", ra.FindProduct("123")!.Name);
        Assert.Equal(880, ra.FindProduct("123")!.LastPriceCents);
        Assert.Null(rb.FindProduct("123"));
        Assert.Empty(rb.ListProducts());
    }

    [Fact]
    public void RecordCap_IsEnforced()
    {
        using var f = new RepoFixture(maxRecords: 2);
        var repo = f.User(_a);
        repo.Add(R("1")); repo.Add(R("2"));
        Assert.Throws<InvalidOperationException>(() => repo.Add(R("3")));
        var imp = new[] { R("x") with { Id = "new-1" } };
        Assert.Throws<InvalidOperationException>(() => repo.Import(imp, Array.Empty<Product>(), ImportMode.Merge));
        Assert.Equal(2, repo.Count()); // 导入事务整体回滚
    }

    [Fact]
    public void UserStore_RejectsInvalidAddress()
    {
        Assert.Throws<ArgumentException>(() => _f.Store.ForUser("kaspa:qnotvalid"));
        Assert.Throws<ArgumentException>(() => _f.Store.ForUser(_a.Address.ToUpperInvariant())); // 必须是规范小写形式
    }

    [Fact]
    public void DeleteAll_OnlyAffectsOwner()
    {
        var ra = _f.User(_a); var rb = _f.User(_b);
        ra.Add(R("a1")); ra.Add(R("a2")); rb.Add(R("b1"));
        Assert.Equal(2, ra.DeleteAll());
        Assert.Empty(ra.Query());
        Assert.Empty(ra.ListProducts());
        Assert.Single(rb.Query());
        Assert.Single(rb.ListProducts());
    }

    // ---- 隔离（仓储层） ----

    [Fact]
    public void Isolation_BCannotSeeReadUpdateOrDeleteAsRecords()
    {
        var ra = _f.User(_a); var rb = _f.User(_b);
        var secret = ra.Add(R("A的药", note: "隐私", batch: "A方"));

        Assert.Empty(rb.Query());
        Assert.Empty(rb.Query(new RecordQuery { Keyword = "A的药" }));
        Assert.Empty(rb.ListBatches());
        Assert.Empty(rb.ListCategories());
        Assert.Null(rb.Get(secret.Id));
        Assert.Null(rb.Update(secret with { Name = "被改" }));
        Assert.Equal(0, rb.Delete(new[] { secret.Id }));
        Assert.Equal(0, rb.AssignBatch(new[] { secret.Id }, "劫持"));
        Assert.Equal(0, rb.RenameBatch(secret.BatchId, "劫持"));

        var still = ra.Get(secret.Id)!;
        Assert.Equal("A的药", still.Name);
        Assert.Equal("A方", still.BatchName);
    }

    [Fact]
    public void Isolation_SameIdForTwoUsers_DoNotCollide()
    {
        var ra = _f.User(_a); var rb = _f.User(_b);
        var item = R("共享id") with { Id = "fixed-id" };
        ra.Import(new[] { item }, Array.Empty<Product>(), ImportMode.Merge);
        rb.Import(new[] { item with { Name = "B的" } }, Array.Empty<Product>(), ImportMode.Merge);
        Assert.Equal("共享id", ra.Get("fixed-id")!.Name);
        Assert.Equal("B的", rb.Get("fixed-id")!.Name);
    }

    [Fact]
    public void Isolation_ReplaceImportByB_DoesNotWipeA()
    {
        var ra = _f.User(_a); var rb = _f.User(_b);
        ra.Add(R("A1")); rb.Add(R("B1"));
        rb.Import(new[] { R("B2") }, Array.Empty<Product>(), ImportMode.Replace);
        Assert.Single(ra.Query());
        Assert.Equal("B2", rb.Query().Single().Name);
    }

    [Fact]
    public void Isolation_SqlInjectionAttempts_AreInert()
    {
        var ra = _f.User(_a); var rb = _f.User(_b);
        ra.Add(R("A1"));
        Assert.Empty(rb.Query(new RecordQuery { Category = "x' OR '1'='1", Keyword = "' OR 1=1 --", BatchId = "' OR '1'='1" }));
        Assert.Null(rb.Get("' OR '1'='1"));
        Assert.Equal(0, rb.Delete(new[] { "' OR 1=1 --" }));
        Assert.Single(ra.Query());
    }
}
