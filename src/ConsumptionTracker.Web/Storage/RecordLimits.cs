using ConsumptionTracker.Core.Models;

namespace ConsumptionTracker.Web.Storage;

/// <summary>服务端字段上限（防止滥用/超大数据；也避免 price×quantity 溢出）。</summary>
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
    public const long MaxPriceCents = 100_000_000_000L; // 10 亿元
    public const decimal MaxQuantity = 1_000_000m;

    /// <summary>返回中文错误；null 表示通过。不在错误信息中回显记录内容。</summary>
    public static string? Check(RecordItem r)
    {
        if (r.Id.Length > MaxId) return "记录 ID 过长";
        if (r.Barcode.Length > MaxBarcode) return "编码过长";
        if (r.Name.Length > MaxName) return "名称过长（最多 100 字）";
        if (r.Category.Length > MaxCategory) return "分类过长";
        if (r.Note.Length > MaxNote) return "备注过长（最多 1000 字）";
        if (r.BatchName.Length > MaxBatchName) return "批次名过长";
        if (r.Patient.Length > MaxPatient) return "用药人过长";
        if (r.Dosage.Length > MaxDosage) return "剂量/规格过长";
        if (r.PriceCents > MaxPriceCents) return "价格过大";
        if (r.Quantity > MaxQuantity) return "数量过大";
        if (decimal.Round(r.Quantity, 4) != r.Quantity) return "数量最多 4 位小数";
        return null;
    }
}
