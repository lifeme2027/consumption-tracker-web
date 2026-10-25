using System.Globalization;
using ConsumptionTracker.Core.Models;
using ConsumptionTracker.Core.Services;

namespace ConsumptionTracker.Web.Tests;

/// <summary>CSV 保真：字段内换行（\r\n / \r / \n）原样保留；数量保留输入的小数位（最多 6 位），不再截成 4 位。</summary>
public class CsvFidelityTests
{
    private static RecordItem Rec(string name, long priceCents, decimal qty, string date, string note = "", string id = "x") => new()
    {
        Id = id, Name = name, PriceCents = priceCents, Quantity = qty, Date = date, Category = "食品", Note = note, CreatedAt = 1,
    };

    [Theory]
    [InlineData("a\r\nb")]
    [InlineData("a\rb")]
    [InlineData("a\nb")]
    [InlineData("\r\n")]
    [InlineData("末尾换行\r\n")]
    [InlineData("a\r\n\r\nb\r\n")]
    [InlineData("混合\r\n\rx\ny")]
    public void QuotedFieldNewlines_ArePreservedExactly(string note)
    {
        var rows = CsvService.ParseRows("\"" + note + "\",z\r\n");
        Assert.Single(rows);
        Assert.Equal(note, rows[0][0]);
        Assert.Equal("z", rows[0][1]);
    }

    [Theory]
    [InlineData("a\r\nb")]
    [InlineData("a\rb")]
    [InlineData("a\nb")]
    [InlineData("含,逗号\r\n和\"引号\"\r\n")]
    public void NoteWithNewlines_RoundTripsThroughCsv(string note)
    {
        var rec = Rec("x", 100, 1, "2026-10-05", note: note, id: "n1");
        var csv = CsvService.ToCsv(new[] { rec });
        var back = Assert.Single(CsvService.Parse(csv).Records);
        Assert.Equal(note, back.Note);
    }

    [Fact]
    public void UnquotedLineBreaks_CrLfCrAndLf_AllSeparateRows()
    {
        Assert.Equal(2, CsvService.ParseRows("a,b\r\nc,d").Count);
        Assert.Equal(2, CsvService.ParseRows("a,b\nc,d\n").Count);
        var cr = CsvService.ParseRows("a,b\rc,d\r");
        Assert.Equal(2, cr.Count);
        Assert.Equal(new[] { "c", "d" }, cr[1]);
        Assert.Single(CsvService.ParseRows("a,b\r\n\r\n"));   // 空行忽略
    }

    [Theory]
    [InlineData("0.123456", "0.123456")]
    [InlineData("12.345678", "12.345678")]
    [InlineData("2.5", "2.5")]
    [InlineData("0.00001", "0.00001")]
    [InlineData("1.50", "1.5")]
    [InlineData("1000000", "1000000")]
    public void Quantity_KeepsInputPrecision_InCsvAndJson(string input, string expectedText)
    {
        Assert.True(Money.TryParseQuantity(input, out var q));
        var rec = Rec("散装", 333, q, "2026-10-05", id: "q1");

        var csv = CsvService.ToCsv(new[] { rec });
        Assert.Contains("," + expectedText + ",", csv);
        Assert.Equal(q, Assert.Single(CsvService.Parse(csv).Records).Quantity);

        var json = BackupService.BuildJson(new[] { rec }, Array.Empty<Product>());
        Assert.Equal(q, Assert.Single(BackupService.ParseJson(json).Records).Quantity);
    }

    [Theory]
    [InlineData("1.1234567")]   // 超过 6 位小数：整行跳过（规则同 shared-vectors/quantity.json）
    [InlineData("1000001")]
    [InlineData("0")]
    public void ImportCsv_QuantityOutsideRule_IsSkipped(string qty)
    {
        var csv = $"日期,商品名,单价,数量\r\n2026-10-05,甲,1.00,{qty}\r\n2026-10-05,乙,1.00,1\r\n";
        var res = CsvService.Parse(csv);
        Assert.Equal(1, res.Skipped);
        Assert.Equal("乙", Assert.Single(res.Records).Name);
    }

    [Fact]
    public void AmountCents_UsesFullQuantityPrecision()
    {
        // 100 元 × 0.00005 = 0.5 分 → 1 分（若数量被截成 4 位小数就会变成 0）
        Assert.Equal(1, Money.AmountCents(10000, 0.00005m));
        Assert.Equal(0, Money.AmountCents(10000, 0.000049m));
    }
}
