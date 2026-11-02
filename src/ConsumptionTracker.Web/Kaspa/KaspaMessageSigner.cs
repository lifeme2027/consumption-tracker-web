using NK = NKaspa;
using NKaspa.Crypto;

namespace ConsumptionTracker.Web.Kaspa;

/// <summary>
/// Thin facade over NKaspa's <see cref="NK.PersonalMessage"/> (rusty-kaspa wallet/core/src/message.rs,
/// as used by KasWare's Schnorr signMessage). Crypto is delegated to NKaspa 0.1.11-alpha; this class keeps
/// the app's network-name mapping, signature-encoding quirks and friendly error messages.
/// </summary>
public static class KaspaMessageSigner
{
    public static byte[] PersonalMessageHash(string message) => NK.PersonalMessage.Hash(message);

    public static NK.Network ToNetwork(string network) =>
        network.Trim().ToLowerInvariant() switch
        {
            "mainnet" or "" => NK.Network.Mainnet,
            "testnet" or "testnet-10" or "testnet-11" => NK.Network.Testnet,
            "devnet" => NK.Network.Devnet,
            "simnet" => NK.Network.Simnet,
            _ => throw new ArgumentException($"Unknown Kaspa network '{network}'."),
        };

    public static string AddressPrefix(string network) => ToNetwork(network).AddressPrefix;

    /// <summary>Decodes a 64-byte Schnorr signature from hex (128 chars) or base64.</summary>
    public static byte[]? DecodeSignature(string? signature)
    {
        if (string.IsNullOrWhiteSpace(signature))
            return null;
        string s = signature.Trim();
        // 仅当「0x + 128 位十六进制」时才剥前缀。base64 签名约有 1/2000 的概率以 "0x"/"0X" 开头，
        // 不能无条件剥掉（否则这类签名会被误判为格式无效，登录偶发 401）。
        var hex = s.Length == 130 && s.StartsWith("0x", StringComparison.OrdinalIgnoreCase) ? s[2..] : s;
        if (hex.Length == 128)
        {
            try { return Convert.FromHexString(hex); } catch (FormatException) { }
        }
        try
        {
            byte[] raw = Convert.FromBase64String(s);
            return raw.Length == 64 ? raw : null;
        }
        catch (FormatException)
        {
            return null;
        }
    }

    public static bool VerifyDigest(ReadOnlySpan<byte> xOnly, ReadOnlySpan<byte> digest, ReadOnlySpan<byte> sig)
    {
        if (xOnly.Length != 32 || digest.Length != 32 || sig.Length != 64)
            return false;
        try { return new NK.PubKey(xOnly).Verify(new SchnorrSignature(sig), digest); }
        catch (Exception e) when (e is ArgumentException or FormatException or InvalidOperationException) { return false; }
    }

    /// <summary>
    /// Verifies that <paramref name="signature"/> signs <paramref name="message"/> with the key
    /// encoded in a Schnorr P2PK <paramref name="address"/> on the expected network.
    /// </summary>
    public static SignatureCheck Verify(string? address, string message, string? signature, string network)
    {
        var status = KaspaBech32.Decode(address?.Trim().ToLowerInvariant(), out var info);
        if (status != KaspaBech32Status.Ok)
            return SignatureCheck.Fail("地址格式无效 / invalid Kaspa address");
        if (!string.Equals(info.Prefix, AddressPrefix(network), StringComparison.Ordinal))
            return SignatureCheck.Fail($"地址网络不匹配，需要 {AddressPrefix(network)}: 前缀 / wrong network");
        if (info.Version != KaspaBech32.PubKeyVersion)
            return SignatureCheck.Fail("仅支持 Schnorr 地址（kaspa:q…）签名验证 / only Schnorr P2PK addresses are supported");
        byte[]? sig = DecodeSignature(signature);
        if (sig is null)
            return SignatureCheck.Fail("签名格式无效（需 64 字节 Schnorr 签名，hex 或 base64） / invalid signature encoding");
        bool ok;
        try { ok = NK.PersonalMessage.VerifyMessage(new NK.PubKey(info.Payload), message, new SchnorrSignature(sig)); }
        catch (Exception e) when (e is ArgumentException or FormatException or InvalidOperationException) { ok = false; }
        return ok ? SignatureCheck.Ok() : SignatureCheck.Fail("签名验证失败 / signature does not match address");
    }

    /// <summary>Signs like rusty-kaspa sign_message (used by tests and tooling).</summary>
    public static byte[] Sign(string message, ReadOnlySpan<byte> privateKey32, byte[]? auxRand32 = null)
    {
        using var key = CreateKey(privateKey32);
        byte[] aux = auxRand32 is { Length: 32 } ? auxRand32 : System.Security.Cryptography.RandomNumberGenerator.GetBytes(32);
        return NK.PersonalMessage.SignMessage(key, message, aux).ToBytes();
    }

    public static byte[] XOnlyPublicKey(ReadOnlySpan<byte> privateKey32)
    {
        using var key = CreateKey(privateKey32);
        return key.PubKey.ToBytes();
    }

    public static string AddressFromXOnly(ReadOnlySpan<byte> xOnly, string network) =>
        new NK.PubKey(xOnly).GetAddress(ToNetwork(network)).ToString();

    private static NK.Key CreateKey(ReadOnlySpan<byte> privateKey32)
    {
        try { return new NK.Key(privateKey32); }
        catch (Exception e) when (e is ArgumentException or FormatException) { throw new ArgumentException("Invalid private key.", e); }
    }
}

public sealed record SignatureCheck(bool Valid, string? Error)
{
    public static SignatureCheck Ok() => new(true, null);
    public static SignatureCheck Fail(string error) => new(false, error);
}
