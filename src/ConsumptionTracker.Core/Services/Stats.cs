using ConsumptionTracker.Core.Models;

namespace ConsumptionTracker.Core.Services;

public sealed record Bucket(string Key, long Cents, int Count);

public sealed record CategoryShare(string Key, long Cents, int Count, double Ratio);

/// <summary>统计：全部基于 RecordItem.AmountCents（分），与列表金额同一算法。</summary>
public static class Stats
{
    public static long TotalCents(IEnumerable<RecordItem> records) => records.Sum(r => r.AmountCents);

    private static List<Bucket> GroupBy(IEnumerable<RecordItem> records, Func<RecordItem, string> keyOf) =>
        records.GroupBy(keyOf)
               .Select(g => new Bucket(g.Key, g.Sum(r => r.AmountCents), g.Count()))
               .ToList();

    /// <summary>按日汇总（Key = YYYY-MM-DD），日期升序。</summary>
    public static List<Bucket> SumByDay(IEnumerable<RecordItem> records) =>
        GroupBy(records, r => r.Date).OrderBy(b => b.Key, StringComparer.Ordinal).ToList();

    /// <summary>按月汇总（Key = YYYY-MM），月份升序。</summary>
    public static List<Bucket> SumByMonth(IEnumerable<RecordItem> records) =>
        GroupBy(records, r => r.Date.Length >= 7 ? r.Date[..7] : r.Date).OrderBy(b => b.Key, StringComparer.Ordinal).ToList();

    /// <summary>按分类汇总，金额降序，含占比（0~1）。</summary>
    public static List<CategoryShare> SumByCategory(IEnumerable<RecordItem> records)
    {
        var buckets = GroupBy(records, r => string.IsNullOrEmpty(r.Category) ? Defaults.UncategorizedName : r.Category)
            .OrderByDescending(b => b.Cents).ThenBy(b => b.Key, StringComparer.Ordinal).ToList();
        var total = buckets.Sum(b => b.Cents);
        return buckets.Select(b => new CategoryShare(b.Key, b.Cents, b.Count, total > 0 ? (double)b.Cents / total : 0)).ToList();
    }

    /// <summary>某一天的总额（分）。</summary>
    public static long DayTotal(IEnumerable<RecordItem> records, string date) =>
        records.Where(r => r.Date == date).Sum(r => r.AmountCents);

    /// <summary>某月（YYYY-MM）的总额（分）。</summary>
    public static long MonthTotal(IEnumerable<RecordItem> records, string month) =>
        records.Where(r => r.Date.StartsWith(month, StringComparison.Ordinal)).Sum(r => r.AmountCents);
}
