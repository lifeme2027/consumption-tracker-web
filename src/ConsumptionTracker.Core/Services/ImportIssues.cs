using ConsumptionTracker.Core.Models;
namespace ConsumptionTracker.Core.Services;

/// <summary>导入时被拒绝/跳过的一行：行号（JSON 为第 N 条，CSV 表头为第 1 行）与具体原因（中英文）。</summary>
public sealed record ImportIssue(int Row, string Label, string LabelEn, string Reason, string ReasonEn)
{
    public static ImportIssue Json(int row, RuleProblem p) => new(row, $"第 {row} 条", $"Record #{row}", p.Zh, p.En);
    public static ImportIssue Csv(int row, RuleProblem p) => new(row, $"第 {row} 行", $"Row {row}", p.Zh, p.En);
}

/// <summary>
/// 覆盖导入的全量预检未通过：没有清空任何现有数据，Issues 为逐条原因（Total 为被检查的总条数）。
/// 继承 InvalidOperationException，旧的调用方照常当作「导入被取消」处理。
/// </summary>
public sealed class ImportRejectedException : InvalidOperationException
{
    public IReadOnlyList<ImportIssue> Issues { get; }
    public int Total { get; }

    public ImportRejectedException(IReadOnlyList<ImportIssue> issues, int total)
        : base($"导入已中止：{total} 条中有 {issues.Count} 条不合格，现有数据没有任何改动")
    {
        Issues = issues;
        Total = total;
    }

    public string MessageEn => $"Import aborted: {Issues.Count} of {Total} records are invalid; your existing data was not changed";

    /// <summary>对一批记录做全量预检，返回按顺序的问题清单（行号 = 序号 + 1）。</summary>
    public static List<ImportIssue> Precheck(IReadOnlyList<RecordItem> records)
    {
        var issues = new List<ImportIssue>();
        for (var i = 0; i < records.Count; i++)
        {
            RecordValidator.SanitizeChecked(records[i], out var problems);
            if (problems.Count > 0) issues.Add(ImportIssue.Json(i + 1, RecordValidator.Join(problems)));
        }
        return issues;
    }
}

/// <summary>
/// 导入文件整体不可用（不是本应用的备份、缺少必需列等）时抛出的异常：类型仍是 InvalidDataException（中文消息），
/// 英文消息放在 Data["en"]，调用方用 <see cref="English"/> 取出。
/// </summary>
public static class ImportFormat
{
    public static InvalidDataException Error(string zh, string en)
    {
        var e = new InvalidDataException(zh);
        e.Data["en"] = en;
        return e;
    }

    /// <summary>异常的英文消息；没有则返回 null。</summary>
    public static string? English(Exception e) => e.Data["en"] as string;
}
