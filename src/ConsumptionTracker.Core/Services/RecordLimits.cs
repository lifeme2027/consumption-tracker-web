using ConsumptionTracker.Core.Models;

namespace ConsumptionTracker.Core.Services;

/// <summary>一条校验问题（中英文成对，供网站/桌面按界面语言显示）。不回显记录内容。</summary>
public readonly record struct RuleProblem(string Zh, string En);

/// <summary>
/// 字段上限（三端统一，见 shared-vectors/limits.json；也避免 price×quantity 溢出）。
/// 桌面与网站共用同一份 Core 代码，保证登记/导入使用相同规则。
/// </summary>
public static class RecordLimits
{
    public const int MaxId = 64;
    public const int MaxBarcode = 64;
    public const int MaxName = 100;
    public const int MaxCategory = 30;
    public const int MaxNote = 1000;
    public const int MaxBatchName = 60;
    public const int MaxPatient = 40;
    public const int MaxDosage = 60;
    public const long MaxPriceCents = Money.MaxPriceCents;   // 10 亿元
    public const decimal MaxQuantity = Money.MaxQuantity;

    /// <summary>返回中文错误；null 表示通过。不在错误信息中回显记录内容。</summary>
    public static string? Check(RecordItem r) => Problem(r)?.Zh;

    /// <summary>返回中英文错误；null 表示通过。</summary>
    public static RuleProblem? Problem(RecordItem r)
    {
        if (r.Id.Length > MaxId) return new("记录 ID 过长", $"Record ID too long (max {MaxId} characters)");
        if (r.Barcode.Length > MaxBarcode) return new("编码过长", $"Barcode too long (max {MaxBarcode} characters)");
        if (r.Name.Length > MaxName) return new("名称过长（最多 100 字）", $"Name too long (max {MaxName} characters)");
        if (r.Category.Length > MaxCategory) return new("分类过长", $"Category too long (max {MaxCategory} characters)");
        if (r.Note.Length > MaxNote) return new("备注过长（最多 1000 字）", $"Note too long (max {MaxNote} characters)");
        if (r.BatchName.Length > MaxBatchName) return new("批次名过长", $"Batch name too long (max {MaxBatchName} characters)");
        if (r.Patient.Length > MaxPatient) return new("用药人过长", $"Patient too long (max {MaxPatient} characters)");
        if (r.Dosage.Length > MaxDosage) return new("剂量/规格过长", $"Dosage/spec too long (max {MaxDosage} characters)");
        if (r.PriceCents > MaxPriceCents) return new("价格过大", "Price too large (max 1,000,000,000 yuan)");
        if (r.Quantity > MaxQuantity) return new("数量过大", "Quantity too large (max 1,000,000)");
        if (decimal.Round(r.Quantity, Money.MaxQuantityDecimals) != r.Quantity)
            return new($"数量最多 {Money.MaxQuantityDecimals} 位小数", $"Quantity allows at most {Money.MaxQuantityDecimals} decimal places");
        return null;
    }
}
