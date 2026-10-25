using ConsumptionTracker.Core.Models;

namespace ConsumptionTracker.Core.Services;

public static class RecordValidator
{
    /// <summary>校验一条记录，返回中文错误列表（空表示通过）。</summary>
    public static List<string> Validate(RecordItem r) => Problems(r).Select(p => p.Zh).ToList();

    /// <summary>同 Validate，但中英文成对。</summary>
    public static List<RuleProblem> Problems(RecordItem r)
    {
        var errors = new List<RuleProblem>();
        if (string.IsNullOrWhiteSpace(r.Name)) errors.Add(new("商品名不能为空", "Name is required"));
        if (r.PriceCents < 0) errors.Add(new("价格不能为负数", "Price cannot be negative"));
        if (r.Quantity <= 0) errors.Add(new("数量必须大于 0", "Quantity must be greater than 0"));
        if (!DateUtil.IsValid(r.Date)) errors.Add(new("日期格式应为 YYYY-MM-DD", "Date must be YYYY-MM-DD"));
        return errors;
    }

    /// <summary>把多条问题合成一条（中文用「；」，英文用「; 」）。</summary>
    public static RuleProblem Join(IEnumerable<RuleProblem> problems)
    {
        var list = problems.ToList();
        return new(string.Join("；", list.Select(p => p.Zh)), string.Join("; ", list.Select(p => p.En)));
    }

    private static RecordItem Normalize(RecordItem r)
    {
        var batchId = (r.BatchId ?? "").Trim();
        return r with
        {
            Id = string.IsNullOrWhiteSpace(r.Id) ? Guid.NewGuid().ToString() : r.Id,
            Barcode = (r.Barcode ?? "").Trim(),
            Name = (r.Name ?? "").Trim(),
            Category = string.IsNullOrWhiteSpace(r.Category) ? Defaults.UncategorizedName : r.Category.Trim(),
            Note = r.Note ?? "",
            BatchId = batchId,
            BatchName = batchId == "" ? "" : (r.BatchName ?? "").Trim(),
            Patient = (r.Patient ?? "").Trim(),
            Dosage = (r.Dosage ?? "").Trim(),
        };
    }

    /// <summary>清洗：去空白、补默认分类、批次名与批次ID同步；非法返回 null（与手机版 sanitizeRecord 一致）。</summary>
    public static RecordItem? Sanitize(RecordItem r)
    {
        var cleaned = Normalize(r);
        return Validate(cleaned).Count == 0 ? cleaned : null;
    }

    /// <summary>
    /// 清洗并做完整校验（必填/格式 + 字段上限 RecordLimits）。有任何问题返回 null，problems 为全部原因（中英文）。
    /// </summary>
    public static RecordItem? SanitizeChecked(RecordItem r, out List<RuleProblem> problems)
    {
        var cleaned = Normalize(r);
        problems = Problems(cleaned);
        if (problems.Count == 0 && RecordLimits.Problem(cleaned) is { } lim) problems.Add(lim);
        return problems.Count == 0 ? cleaned : null;
    }
}
