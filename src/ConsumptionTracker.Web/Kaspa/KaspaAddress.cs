namespace ConsumptionTracker.Web.Kaspa;

/// <summary>
/// 用户身份 = Kaspa Schnorr 地址（kaspa:q…，主网）。校验包含 bech32（cashaddr 风格 40 位）校验和、
/// 网络前缀、地址版本（仅 Schnorr P2PK）。地址在系统内一律以小写规范形式存储与比较。
/// </summary>
public static class KaspaAddress
{
    public const int MaxLength = 100;

    public static bool TryNormalize(string? input, string network, out string normalized, out string error)
    {
        normalized = "";
        error = "";
        if (string.IsNullOrWhiteSpace(input))
        {
            error = "请输入 Kaspa 地址";
            return false;
        }
        var s = input.Trim();
        if (s.Length > MaxLength)
        {
            error = "地址格式无效";
            return false;
        }
        // bech32 不允许大小写混用
        if (s.Any(char.IsLower) && s.Any(char.IsUpper))
        {
            error = "地址格式无效（大小写混用）";
            return false;
        }
        s = s.ToLowerInvariant();

        var status = KaspaBech32.Decode(s, out var info);
        switch (status)
        {
            case KaspaBech32Status.BadChecksum:
                error = "地址校验和错误，请检查是否抄错";
                return false;
            case not KaspaBech32Status.Ok:
                error = "地址格式无效";
                return false;
        }
        var expectedPrefix = KaspaMessageSigner.AddressPrefix(network);
        if (!string.Equals(info.Prefix, expectedPrefix, StringComparison.Ordinal))
        {
            error = $"地址网络不匹配，需要 {expectedPrefix}: 开头的主网地址";
            return false;
        }
        if (info.Version != KaspaBech32.PubKeyVersion)
        {
            error = "仅支持 Schnorr 地址（kaspa:q… 开头）";
            return false;
        }
        normalized = s;
        return true;
    }
}
