using System.Globalization;

namespace ConsumptionTracker.Core.Services;

public static class DateUtil
{
    public const string Format = "yyyy-MM-dd";

    public static string ToText(DateTime d) => d.ToString(Format, CultureInfo.InvariantCulture);

    public static string Today() => ToText(DateTime.Now);

    public static bool IsValid(string? s) =>
        s is { Length: 10 } &&
        DateTime.TryParseExact(s, Format, CultureInfo.InvariantCulture, DateTimeStyles.None, out _);

    public static DateTime Parse(string s) =>
        DateTime.ParseExact(s, Format, CultureInfo.InvariantCulture);

    /// <summary>某月（YYYY-MM）的起止日期（含）。</summary>
    public static (string From, string To) MonthRange(string month)
    {
        var d = DateTime.ParseExact(month + "-01", Format, CultureInfo.InvariantCulture);
        var last = d.AddMonths(1).AddDays(-1);
        return (ToText(d), ToText(last));
    }
}
