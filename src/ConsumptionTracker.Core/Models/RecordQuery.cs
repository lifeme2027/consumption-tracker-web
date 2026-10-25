namespace ConsumptionTracker.Core.Models;

/// <summary>记录筛选条件。日期为 YYYY-MM-DD，范围两端均含。</summary>
public sealed record RecordQuery
{
    /// <summary>BatchId 取该值表示仅「未分批」记录。</summary>
    public const string NoBatch = "__none__";

    public string? From { get; init; }
    public string? To { get; init; }
    public string? Category { get; init; }
    public string? Keyword { get; init; }
    public string? BatchId { get; init; }

    /// <summary>内存中判断一条记录是否满足条件（Data 层与统计共用，保证一致）。</summary>
    public bool Matches(RecordItem r)
    {
        if (!string.IsNullOrEmpty(From) && string.CompareOrdinal(r.Date, From) < 0) return false;
        if (!string.IsNullOrEmpty(To) && string.CompareOrdinal(r.Date, To) > 0) return false;
        if (!string.IsNullOrEmpty(Category) && r.Category != Category) return false;
        if (BatchId == NoBatch) { if (r.BatchId != "") return false; }
        else if (!string.IsNullOrEmpty(BatchId) && r.BatchId != BatchId) return false;
        var kw = Keyword?.Trim();
        if (!string.IsNullOrEmpty(kw))
        {
            string[] hay = { r.Name, r.Barcode, r.Note, r.Category, r.BatchName, r.Patient, r.Dosage };
            if (!hay.Any(s => s.Contains(kw, StringComparison.OrdinalIgnoreCase))) return false;
        }
        return true;
    }
}
