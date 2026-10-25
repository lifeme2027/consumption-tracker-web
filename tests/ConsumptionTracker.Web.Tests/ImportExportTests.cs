using System.Text;
using System.Text.Json;
using ConsumptionTracker.Core.Models;
using ConsumptionTracker.Core.Services;

namespace ConsumptionTracker.Web.Tests;

public class ImportExportTests : IDisposable
{
    private readonly RepoFixture _f = new();
    private readonly TestWallet _a = new(), _b = new();
    public void Dispose() => _f.Dispose();

    private static RecordItem R(string name, long cents = 1250, decimal qty = 2, string date = "2026-10-20", string barcode = "6901", string patient = "", string dosage = "") =>
        new() { Name = name, PriceCents = cents, Quantity = qty, Category = "药品", Date = date, Barcode = barcode, Patient = patient, Dosage = dosage, Note = "含,逗号和\"引号\"\n换行" };

    [Fact]
    public void Json_RoundTrip_AndFormatMatchesPhoneAndDesktop()
    {
        var src = _f.User(_a);
        src.Add(R("药A", 1999, 1.5m, patient: "妈妈", dosage: "0.5g×24片"));
        src.Add(R("药B", 5, 3m, "2026-09-01", ""));
        var json = BackupService.BuildJson(src.Query(), src.ListProducts());

        using var doc = JsonDocument.Parse(json);
        Assert.Equal("consumption-tracker", doc.RootElement.GetProperty("app").GetString());
        Assert.Equal(2, doc.RootElement.GetProperty("version").GetInt32());
        var first = doc.RootElement.GetProperty("records")[0];
        Assert.Equal(19.99m, first.GetProperty("price").GetDecimal());   // 手机版读 price（元）
        Assert.Equal(1999, first.GetProperty("priceCents").GetInt64());  // 桌面/网页读 priceCents

        var dst = _f.User(_b);
        var parsed = BackupService.ParseJson(json);
        var s = dst.Import(parsed.Records, parsed.Products, ImportMode.Merge);
        Assert.Equal(2, s.Added);
        Assert.Equal(src.Query().Select(r => (r.Id, r.Name, r.AmountCents, r.Patient, r.Dosage, r.Note)),
                     dst.Query().Select(r => (r.Id, r.Name, r.AmountCents, r.Patient, r.Dosage, r.Note)));
        Assert.Equal("药A", dst.FindProduct("6901")!.Name);
    }

    [Fact]
    public void Json_PhoneVersion1_PriceInYuanOnly_IsAccepted()
    {
        const string phone = """
            {"app":"consumption-tracker","version":1,"records":[
              {"id":"p1","barcode":"123","name":"手机版记录","price":12.34,"quantity":2,"category":"食品","note":"","date":"2026-10-01","createdAt":1700000000000}]}
            """;
        var parsed = BackupService.ParseJson(phone);
        var repo = _f.User(_a);
        repo.Import(parsed.Records, parsed.Products, ImportMode.Merge);
        var r = repo.Get("p1")!;
        Assert.Equal(1234, r.PriceCents);
        Assert.Equal(2468, r.AmountCents);
    }

    [Fact]
    public void Csv_HasUtf8Bom_AndRoundTrips()
    {
        var src = _f.User(_a);
        src.Add(R("药A", 1999, 1.5m, patient: "妈妈", dosage: "0.5g×24片"));
        src.Add(R("food", 300, 1m, "2026-10-02", ""));
        var csv = CsvService.ToCsv(src.Query());
        var bytes = new UTF8Encoding(false).GetBytes(csv);
        Assert.Equal(new byte[] { 0xEF, 0xBB, 0xBF }, bytes[..3]);
        Assert.NotEqual(new byte[] { 0xEF, 0xBB, 0xBF }, bytes[3..6]); // 没有双重 BOM

        var dst = _f.User(_b);
        var parsed = CsvService.Parse(Encoding.UTF8.GetString(bytes));
        dst.Import(parsed.Records, parsed.Products, ImportMode.Merge);
        Assert.Equal(src.Query().Select(r => (r.Name, r.AmountCents, r.Note, r.Patient, r.Dosage, r.Date)).OrderBy(x => x.Name),
                     dst.Query().Select(r => (r.Name, r.AmountCents, r.Note, r.Patient, r.Dosage, r.Date)).OrderBy(x => x.Name));
        Assert.Equal("药A", dst.FindProduct("6901")!.Name); // CSV 导入补出商品记忆
    }

    [Fact]
    public void Import_Merge_UpdatesSameId_ReplaceClears()
    {
        var repo = _f.User(_a);
        var first = repo.Add(R("旧"));
        repo.Add(R("另一条", date: "2026-10-21"));
        var summary = repo.Import(new[] { first with { Name = "新" }, R("全新") with { Id = "z" } }, Array.Empty<Product>(), ImportMode.Merge);
        Assert.Equal((1, 1), (summary.Added, summary.Updated));
        Assert.Equal(3, repo.Count());
        Assert.Equal("新", repo.Get(first.Id)!.Name);

        repo.Import(new[] { R("唯一") }, Array.Empty<Product>(), ImportMode.Replace);
        Assert.Equal("唯一", repo.Query().Single().Name);
    }

    [Fact]
    public void Import_SkipsInvalidAndOversizedRows()
    {
        var repo = _f.User(_a);
        var s = repo.Import(new[]
        {
            R("ok"),
            R("") ,
            R("neg", -5),
            R(new string('n', 500)),
            R("badDate", date: "nope"),
            R("huge", 1_000_000_000_000_000L),
            R("idlong") with { Id = new string('i', 200) },
        }, Array.Empty<Product>(), ImportMode.Merge);
        Assert.Equal(1, s.Added);
        Assert.Equal(6, s.Skipped);
    }
}
