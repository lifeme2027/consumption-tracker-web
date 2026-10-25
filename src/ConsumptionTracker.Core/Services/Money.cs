using System.Globalization;
using ConsumptionTracker.Core.Models;

namespace ConsumptionTracker.Core.Services;

/// <summary>金额工具：全部按「分」整数计算，避免浮点误差。</summary>
public static class Money
{
    public static long ToCents(decimal yuan) => (long)Math.Round(yuan * 100m, MidpointRounding.AwayFromZero);

    public static decimal ToYuan(long cents) => cents / 100m;

    /// <summary>单价(分) × 数量 = 金额(分)，四舍五入。例：777 分 × 2.5 = 1943 分。</summary>
    public static long AmountCents(long priceCents, decimal quantity) =>
        (long)Math.Round(priceCents * quantity, MidpointRounding.AwayFromZero);

    public static string FormatYuan(long cents)
    {
        var sign = cents < 0 ? "-" : "";
        var abs = Math.Abs(cents);
        return $"{sign}¥{abs / 100}.{abs % 100:00}";
    }

    /// <summary>解析用户输入的元金额（允许 ¥/￥、千分位逗号、空白）。负数/非数字返回 false。</summary>
    public static bool TryParseYuan(string? text, out long cents)
    {
        cents = 0;
        if (string.IsNullOrWhiteSpace(text)) return false;
        var s = text.Trim().TrimStart('¥', '￥').Replace(",", "").Replace("，", "").Trim();
        if (!decimal.TryParse(s, NumberStyles.AllowDecimalPoint, CultureInfo.InvariantCulture, out var v) || v < 0) return false;
        cents = ToCents(v);
        return true;
    }

    public static bool TryParseQuantity(string? text, out decimal quantity)
    {
        quantity = 0;
        if (string.IsNullOrWhiteSpace(text)) return false;
        return decimal.TryParse(text.Trim(), NumberStyles.AllowDecimalPoint, CultureInfo.InvariantCulture, out quantity) && quantity > 0;
    }
}
