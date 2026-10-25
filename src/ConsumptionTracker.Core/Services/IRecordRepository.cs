using ConsumptionTracker.Core.Models;

namespace ConsumptionTracker.Core.Services;

public enum ImportMode
{
    /// <summary>按 id 合并：同 id 覆盖，其余保留。</summary>
    Merge,
    /// <summary>先清空再导入。</summary>
    Replace,
}

public sealed record ImportSummary(int Added, int Updated, int Skipped);

/// <summary>记录仓储抽象（实现见 ConsumptionTracker.Data）。</summary>
public interface IRecordRepository
{
    RecordItem Add(RecordItem record);
    RecordItem? Update(RecordItem record);
    int Delete(IEnumerable<string> ids);
    RecordItem? Get(string id);
    /// <summary>按条件查询，日期降序、同日按创建时间降序。</summary>
    List<RecordItem> Query(RecordQuery? query = null);
    List<string> ListCategories();
    List<BatchInfo> ListBatches();
    /// <summary>把多条记录标记为同一批次（同名批次复用同一 ID）；name 为空则移出批次。返回受影响行数。</summary>
    int AssignBatch(IEnumerable<string> ids, string name);
    int RenameBatch(string batchId, string name);
    Product? FindProduct(string barcode);
    List<Product> ListProducts();
    ImportSummary Import(IEnumerable<RecordItem> records, IEnumerable<Product> products, ImportMode mode);
}
