using ConsumptionTracker.Core.Services;

namespace ConsumptionTracker.Core.Models;

/// <summary>
/// 一条消费/用药记录。字段命名与手机版 (consumption-tracker) 的 RecordItem 保持一致，
/// 区别：金额以「分」整数存储（PriceCents），JSON 导出时同时写出 price（元）以兼容手机版。
/// </summary>
public sealed record RecordItem
{
    public string Id { get; init; } = Guid.NewGuid().ToString();
    /// <summary>商品条码 / 药品追溯码，可为空（手动记账）。</summary>
    public string Barcode { get; init; } = "";
    public string Name { get; init; } = "";
    /// <summary>单价（分）。</summary>
    public long PriceCents { get; init; }
    public decimal Quantity { get; init; } = 1m;
    public string Category { get; init; } = Defaults.UncategorizedName;
    public string Note { get; init; } = "";
    /// <summary>批次/药方 ID，空串表示未分批。</summary>
    public string BatchId { get; init; } = "";
    /// <summary>批次名（与 BatchId 同步，冗余存储便于导出）。</summary>
    public string BatchName { get; init; } = "";
    /// <summary>用药人（可选）。</summary>
    public string Patient { get; init; } = "";
    /// <summary>剂量/规格（可选），如 "0.5g×24片"。</summary>
    public string Dosage { get; init; } = "";
    /// <summary>YYYY-MM-DD（本地日期）。</summary>
    public string Date { get; init; } = "";
    /// <summary>创建时间，Unix 毫秒。</summary>
    public long CreatedAt { get; init; } = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

    /// <summary>金额（分）= 单价 × 数量，四舍五入。</summary>
    public long AmountCents => Money.AmountCents(PriceCents, Quantity);
}

/// <summary>编码 → 商品记忆（扫码后自动带出名称/分类/上次价格）。</summary>
public sealed record Product
{
    public string Barcode { get; init; } = "";
    public string Name { get; init; } = "";
    public string Category { get; init; } = "";
    public long? LastPriceCents { get; init; }
    public long UpdatedAt { get; init; } = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
}

public sealed record BatchInfo(string BatchId, string BatchName, int Count);

public static class Defaults
{
    public const string UncategorizedName = "未分类";

    /// <summary>与手机版一致的内置分类。</summary>
    public static readonly IReadOnlyList<string> Categories =
        new[] { "药品", "食品", "饮料", "日用", "餐饮", "交通", "服饰", "数码", "医疗", "娱乐", "其他" };
}
