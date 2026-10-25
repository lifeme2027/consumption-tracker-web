using ConsumptionTracker.Core.Models;

namespace ConsumptionTracker.Web.Api;

public sealed record AddressRequest(string? Address);
public sealed record VerifyRequest(string? Address, string? Nonce, string? Signature);

/// <summary>新增/修改记录的请求体。价格为「分」整数。</summary>
public sealed record RecordInput(
    string? Barcode, string? Name, long? PriceCents, decimal? Quantity, string? Category,
    string? Note, string? Date, string? BatchName, string? Patient, string? Dosage);

public sealed record RecordDto(
    string Id, string Barcode, string Name, long PriceCents, decimal Quantity, long AmountCents,
    string Category, string Note, string BatchId, string BatchName, string Patient, string Dosage,
    string Date, long CreatedAt)
{
    public static RecordDto From(RecordItem r) => new(
        r.Id, r.Barcode, r.Name, r.PriceCents, r.Quantity, r.AmountCents,
        r.Category, r.Note, r.BatchId, r.BatchName, r.Patient, r.Dosage, r.Date, r.CreatedAt);
}

public sealed record QueryRequest(string? From, string? To, string? Category, string? BatchId, string? Keyword);
public sealed record IdsRequest(List<string>? Ids);
public sealed record BatchAssignRequest(List<string>? Ids, string? Name);
public sealed record BarcodeRequest(string? Barcode);
public sealed record ConfirmRequest(string? Confirm);
