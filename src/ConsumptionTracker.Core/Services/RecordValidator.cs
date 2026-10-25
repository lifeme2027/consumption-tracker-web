using ConsumptionTracker.Core.Models;

namespace ConsumptionTracker.Core.Services;

public static class RecordValidator
{
    /// <summary>校验一条记录，返回中文错误列表（空表示通过）。</summary>
    public static List<string> Validate(RecordItem r)
    {
        var errors = new List<string>();
        if (string.IsNullOrWhiteSpace(r.Name)) errors.Add("商品名不能为空");
        if (r.PriceCents < 0) errors.Add("价格不能为负数");
        if (r.Quantity <= 0) errors.Add("数量必须大于 0");
        if (!DateUtil.IsValid(r.Date)) errors.Add("日期格式应为 YYYY-MM-DD");
        return errors;
    }

    /// <summary>清洗：去空白、补默认分类、批次名与批次ID同步；非法返回 null（与手机版 sanitizeRecord 一致）。</summary>
    public static RecordItem? Sanitize(RecordItem r)
    {
        var batchId = (r.BatchId ?? "").Trim();
        var cleaned = r with
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
        return Validate(cleaned).Count == 0 ? cleaned : null;
    }
}
