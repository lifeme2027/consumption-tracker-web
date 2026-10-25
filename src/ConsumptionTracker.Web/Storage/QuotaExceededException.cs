namespace ConsumptionTracker.Web.Storage;

/// <summary>记录数超过每用户上限。继承 InvalidOperationException（旧调用方照常处理），并带英文消息供接口返回 errorEn。</summary>
public sealed class QuotaExceededException : InvalidOperationException
{
    public string MessageEn { get; }
    public QuotaExceededException(string zh, string en) : base(zh) { MessageEn = en; }
}
