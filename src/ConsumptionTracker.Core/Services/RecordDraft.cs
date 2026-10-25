using ConsumptionTracker.Core.Models;

namespace ConsumptionTracker.Core.Services;

/// <summary>
/// 登记/编辑表单的原始文本输入（UI 无关）。TryBuild 完成解析与校验，便于单元测试。
/// </summary>
public sealed class RecordDraft
{
    public string Barcode { get; set; } = "";
    public string Name { get; set; } = "";
    public string PriceText { get; set; } = "";
    public string QuantityText { get; set; } = "1";
    public string Category { get; set; } = "";
    public string Note { get; set; } = "";
    public string Date { get; set; } = "";
    public string BatchName { get; set; } = "";
    public string Patient { get; set; } = "";
    public string Dosage { get; set; } = "";

    public bool TryBuild(out RecordItem? record, out List<string> errors)
    {
        errors = new List<string>();
        record = null;
        if (string.IsNullOrWhiteSpace(Name)) errors.Add("请填写商品名");
        if (!Money.TryParseYuan(PriceText, out var cents)) errors.Add("价格无效（需为不小于 0 的数字）");
        if (!Money.TryParseQuantity(QuantityText, out var qty)) errors.Add("数量无效（需大于 0）");
        if (!DateUtil.IsValid(Date)) errors.Add("日期无效（格式 YYYY-MM-DD）");
        if (errors.Count > 0) return false;

        record = new RecordItem
        {
            Barcode = Barcode.Trim(),
            Name = Name.Trim(),
            PriceCents = cents,
            Quantity = qty,
            Category = string.IsNullOrWhiteSpace(Category) ? Defaults.UncategorizedName : Category.Trim(),
            Note = Note ?? "",
            Date = Date,
            BatchName = BatchName.Trim(),
            Patient = Patient.Trim(),
            Dosage = Dosage.Trim(),
        };
        return true;
    }

    public static RecordDraft From(RecordItem r) => new()
    {
        Barcode = r.Barcode,
        Name = r.Name,
        PriceText = (r.PriceCents / 100m).ToString("0.00", System.Globalization.CultureInfo.InvariantCulture),
        QuantityText = r.Quantity.ToString("0.####", System.Globalization.CultureInfo.InvariantCulture),
        Category = r.Category,
        Note = r.Note,
        Date = r.Date,
        BatchName = r.BatchName,
        Patient = r.Patient,
        Dosage = r.Dosage,
    };
}
