using System.Globalization;
using System.Text.Json;
using ConsumptionTracker.Core.Services;
using ConsumptionTracker.Core.Models;
using ConsumptionTracker.Web.Storage;

namespace ConsumptionTracker.Web.Tests;

public class MoneyTests
{
    [Fact]
    public void AmountCents_AvoidsFloatError()
    {
        // 手机版注释里的经典例子：7.77 × 2.5 = 19.425 → 1943 分
        Assert.Equal(1943, Money.AmountCents(777, 2.5m));
        Assert.Equal(1, Money.AmountCents(1, 1m));
        Assert.Equal(30, Money.AmountCents(10, 3m));
    }

    public static IEnumerable<object?[]> MoneyVectors() => Vectors("money.json", "cents");
    public static IEnumerable<object?[]> QuantityVectors() => Vectors("quantity.json", "quantity");

    private static IEnumerable<object?[]> Vectors(string file, string key)
    {
        var path = Path.Combine(AppContext.BaseDirectory, "shared-vectors", file);
        using var doc = JsonDocument.Parse(File.ReadAllText(path));
        foreach (var e in doc.RootElement.EnumerateArray())
        {
            var v = e.GetProperty(key);
            yield return new object?[]
            {
                e.GetProperty("input").GetString(),
                v.ValueKind == JsonValueKind.Null ? null : v.ValueKind == JsonValueKind.Number ? v.GetInt64().ToString() : v.GetString(),
            };
        }
    }

    [Fact]
    public void SharedVectorFiles_AreLoadedAndNotEmpty()
    {
        Assert.True(MoneyVectors().Count() >= 50);
        Assert.True(QuantityVectors().Count() >= 20);
    }

    [Theory]
    [MemberData(nameof(MoneyVectors))]
    public void TryParseYuan_SharedVectors(string input, string? expectedCents)
    {
        var ok = Money.TryParseYuan(input, out var c);
        if (expectedCents == null) Assert.False(ok, $"应拒绝: '{input}' 却得到 {c}");
        else
        {
            Assert.True(ok, $"应接受: '{input}'");
            Assert.Equal(long.Parse(expectedCents, CultureInfo.InvariantCulture), c);
        }
    }

    [Theory]
    [MemberData(nameof(QuantityVectors))]
    public void TryParseQuantity_SharedVectors(string input, string? expected)
    {
        var ok = Money.TryParseQuantity(input, out var q);
        if (expected == null) Assert.False(ok, $"应拒绝: '{input}' 却得到 {q}");
        else
        {
            Assert.True(ok, $"应接受: '{input}'");
            Assert.Equal(decimal.Parse(expected, CultureInfo.InvariantCulture), q);
        }
    }

    [Theory]
    [InlineData("1.005", 101)]
    [InlineData("2.675", 268)]
    [InlineData("0.005", 1)]
    [InlineData("0.004", 0)]
    [InlineData("1234.5", 123450)]
    [InlineData("12.345", 1235)]
    [InlineData("¥1,234.50", 123450)]
    public void TryParseYuan_HalfUp_Required(string text, long expected)
    {
        Assert.True(Money.TryParseYuan(text, out var c));
        Assert.Equal(expected, c);
    }

    [Theory]
    [InlineData("12,5")]
    [InlineData("1,5")]
    [InlineData("1,234")] // 单个逗号分组且无小数点：可能是 1.234，拒绝歧义
    [InlineData("1,2345")]
    [InlineData("-1")]
    [InlineData("")]
    [InlineData(null)]
    public void TryParseYuan_RejectsAmbiguousAndInvalid(string? text) => Assert.False(Money.TryParseYuan(text, out _));

    [Fact]
    public void ParseYuan_NeverUsesBinaryFloat_ClassicCases()
    {
        // double 下 1.005*100 = 100.49999999999999 → 100（手机版旧行为）；十进制精确解析必须是 101
        Assert.True(Money.TryParseYuan("1.005", out var a));
        Assert.Equal(101, a);
        Assert.True(Money.TryParseYuan("0.30", out var b));
        Assert.Equal(30, b);
        Assert.True(Money.TryParseYuan("4.35", out var c)); // 4.35*100 = 434.99999999999994
        Assert.Equal(435, c);
        Assert.True(Money.TryParseYuan("1.15", out var d)); // 1.15*100 = 114.99999999999999
        Assert.Equal(115, d);
    }

    [Fact]
    public void FormatQuantity_KeepsPrecision()
    {
        Assert.Equal("2.5", Money.FormatQuantity(2.50m));
        Assert.Equal("0.123456", Money.FormatQuantity(0.123456m));
        Assert.Equal("12", Money.FormatQuantity(12m));
        Assert.Equal("0.12345678", Money.FormatQuantity(0.12345678m));
    }

    [Theory]
    [InlineData(0, "¥0.00")]
    [InlineData(5, "¥0.05")]
    [InlineData(123456, "¥1234.56")]
    [InlineData(-250, "-¥2.50")]
    public void FormatYuan(long cents, string expected) => Assert.Equal(expected, Money.FormatYuan(cents));

    [Theory]
    [InlineData("0.000001", true)]
    [InlineData("0.123456", true)]
    [InlineData("1000000", true)]
    [InlineData("0.0000001", false)] // 超过 6 位小数
    [InlineData("1000000.000001", false)]
    public void RecordLimits_Quantity_SixDecimalsAndCap(string qty, bool ok)
    {
        var r = new RecordItem { Id = "a", Name = "x", Quantity = decimal.Parse(qty, CultureInfo.InvariantCulture), Date = "2026-10-01" };
        Assert.Equal(ok, RecordLimits.Check(r) == null);
    }

    [Fact]
    public void RecordLimits_Price_CapMatchesSharedVectors()
    {
        Assert.Equal(100_000_000_000L, RecordLimits.MaxPriceCents);
        Assert.True(Money.TryParseYuan("1000000000", out var c) && c == RecordLimits.MaxPriceCents);
        Assert.False(Money.TryParseYuan("1000000000.01", out _));
    }
}
