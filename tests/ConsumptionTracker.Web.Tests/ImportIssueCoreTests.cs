using ConsumptionTracker.Core.Models;
using ConsumptionTracker.Core.Services;

namespace ConsumptionTracker.Web.Tests;

// 注意：本文件与桌面版仓库中的同名测试保持一致（Core 共用）
public class ImportIssueCoreTests
{
    private const string Head = "{\"app\":\"consumption-tracker\",\"version\":2,\"records\":[";

    [Fact]
    public void Json_Issues_CarryRowLabelAndBilingualReason_AndSkippedMatches()
    {
        var json = Head +
            "{\"name\":\"好\",\"priceCents\":100,\"quantity\":1,\"date\":\"2026-10-01\"}," +
            "{\"name\":\"\",\"priceCents\":100,\"quantity\":1,\"date\":\"2026-10-01\"}," +
            "\"x\"," +
            "{\"name\":\"备\",\"priceCents\":100,\"quantity\":1,\"date\":\"2026-10-01\",\"note\":\"" + new string('a', 1001) + "\"}]}";
        var r = BackupService.ParseJson(json);
        Assert.Single(r.Records);
        Assert.Equal(3, r.Skipped);
        Assert.Equal(r.Skipped, r.Issues.Count);
        Assert.Equal(new[] { 2, 3, 4 }, r.Issues.Select(i => i.Row));
        Assert.Equal("第 2 条", r.Issues[0].Label);
        Assert.Contains("商品名不能为空", r.Issues[0].Reason);
        Assert.Contains("Name is required", r.Issues[0].ReasonEn);
        Assert.Equal("Record #3", r.Issues[1].LabelEn);
        Assert.Contains("备注过长（最多 1000 字）", r.Issues[2].Reason);
        Assert.Contains("Note too long", r.Issues[2].ReasonEn);
    }

    [Theory]
    [InlineData("\"priceCents\":100000000001", "价格过大")]
    [InlineData("\"priceCents\":100000000000,\"quantity\":0.0000001", "数量最多 6 位小数")]
    [InlineData("\"priceCents\":5,\"quantity\":1000000.5", "数量过大")]
    [InlineData("\"priceCents\":5,\"quantity\":0", "数量必须大于 0")]
    [InlineData("\"priceCents\":1e300", "价格过大")]
    [InlineData("\"price\":1e300", "价格过大")]
    [InlineData("\"priceCents\":5,\"quantity\":1e300", "数量过大")]
    [InlineData("\"priceCents\":-5", "价格不能为负数")]
    [InlineData("\"quantity\":1", "缺少有效的价格")]
    public void Json_NumericProblems_GetSpecificReasons(string fields, string reason)
    {
        var body = fields.Contains("quantity") ? fields : fields + ",\"quantity\":1";
        var r = BackupService.ParseJson(Head + "{\"name\":\"n\",\"date\":\"2026-10-01\"," + body + "}]}");
        Assert.Empty(r.Records);
        Assert.Contains(reason, Assert.Single(r.Issues).Reason);
    }

    [Fact]
    public void Json_BoundaryValues_AreAccepted()
    {
        var r = BackupService.ParseJson(Head + "{\"name\":\"n\",\"date\":\"2026-10-01\",\"priceCents\":100000000000,\"quantity\":1000000}," +
            "{\"name\":\"m\",\"date\":\"2026-10-01\",\"priceCents\":0,\"quantity\":0.000001,\"note\":\"" + new string('a', 1000) + "\"}]}");
        Assert.Equal(2, r.Records.Count);
        Assert.Empty(r.Issues);
    }

    [Fact]
    public void Csv_Issues_HeaderIsRow1_AndReasonsAreSpecific()
    {
        var csv = "日期,商品名,单价,数量,备注\n" +
                  "2026-10-01,好,1.00,1,\n" +
                  "2026-10-02,坏价,abc,1,\n" +
                  "2026-10-03,坏量,1.00,2.1234567,\n" +
                  "2026-10-04,大价,9999999999,1,\n" +
                  "2026-10-05,备注,1.00,1," + new string('x', 1001) + "\n";
        var r = CsvService.Parse(csv);
        Assert.Single(r.Records);
        Assert.Equal(new[] { 3, 4, 5, 6 }, r.Issues.Select(i => i.Row));
        Assert.Equal("第 3 行", r.Issues[0].Label);
        Assert.Equal("Row 4", r.Issues[1].LabelEn);
        Assert.Contains("价格无效", r.Issues[0].Reason);
        Assert.Contains("数量最多 6 位小数", r.Issues[1].Reason);
        Assert.Contains("价格过大", r.Issues[2].Reason);
        Assert.Contains("备注过长", r.Issues[3].Reason);
    }

    [Theory]
    [InlineData("", "价格为空")]
    [InlineData("-1", "价格不能为负数")]
    [InlineData("1000000000.01", "价格过大")]
    [InlineData("99999999999999999999", "价格过大")]
    [InlineData("12,5", "价格无效")]
    [InlineData("abc", "价格无效")]
    public void Money_PriceProblem(string text, string reason) => Assert.Contains(reason, Money.PriceProblem(text)!.Value.Zh);

    [Theory]
    [InlineData("", "数量为空")]
    [InlineData("0", "数量必须大于 0")]
    [InlineData("-2", "数量必须大于 0")]
    [InlineData("1.1234567", "数量最多 6 位小数")]
    [InlineData("1000001", "数量过大")]
    [InlineData("123456789012345678901234", "数量过大")]
    [InlineData("1e3", "数量无效")]
    public void Money_QuantityProblem(string text, string reason) => Assert.Contains(reason, Money.QuantityProblem(text)!.Value.Zh);

    [Fact]
    public void Money_Problem_NullWhenValid()
    {
        Assert.Null(Money.PriceProblem("12.50"));
        Assert.Null(Money.QuantityProblem("2.5"));
    }

    [Fact]
    public void Draft_RejectsOverLimitFields_WithSameRulesAsImport()
    {
        var d = new RecordDraft { Name = "n", PriceText = "1", QuantityText = "1", Date = "2026-10-01", Note = new string('x', 1001) };
        Assert.False(d.TryBuild(out var rec, out var errors));
        Assert.Null(rec);
        Assert.Contains(errors, e => e.Contains("备注过长"));
        d.Note = new string('x', 1000);
        Assert.True(d.TryBuild(out _, out _));
        d.Patient = new string('p', 41);
        Assert.False(d.TryBuild(out _, out errors));
        Assert.Contains(errors, e => e.Contains("用药人过长"));
    }
}
