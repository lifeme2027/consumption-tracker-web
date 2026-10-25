using ConsumptionTracker.Web.Kaspa;

namespace ConsumptionTracker.Web.Tests;

public class KaspaAddressTests
{
    private static string ValidAddress() => new TestWallet().Address;

    [Fact]
    public void ValidMainnetSchnorrAddress_Normalizes()
    {
        var a = ValidAddress();
        Assert.StartsWith("kaspa:q", a);
        Assert.True(KaspaAddress.TryNormalize("  " + a + " ", "mainnet", out var n, out _));
        Assert.Equal(a, n);
    }

    [Fact]
    public void UpperCaseAddress_IsAcceptedAndLowercased()
    {
        var a = ValidAddress();
        Assert.True(KaspaAddress.TryNormalize(a.ToUpperInvariant(), "mainnet", out var n, out _));
        Assert.Equal(a, n);
    }

    [Fact]
    public void MixedCase_IsRejected()
    {
        var a = ValidAddress();
        var mixed = char.ToUpperInvariant(a[7]) + a[8..];
        mixed = a[..7] + mixed;
        Assert.False(KaspaAddress.TryNormalize(mixed, "mainnet", out _, out _));
    }

    [Fact]
    public void ChangedCharacter_FailsChecksum()
    {
        var a = ValidAddress();
        var i = 10;
        var repl = a[i] == 'q' ? 'p' : 'q';
        var bad = a[..i] + repl + a[(i + 1)..];
        Assert.False(KaspaAddress.TryNormalize(bad, "mainnet", out _, out var err));
        Assert.Contains("校验和", err);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("   ")]
    [InlineData("kaspa:")]
    [InlineData("kaspa:q")]
    [InlineData("bitcoin:q1234")]
    [InlineData("0x1234567890abcdef")]
    [InlineData("kaspa:qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq")]
    public void Garbage_IsRejected(string? s) =>
        Assert.False(KaspaAddress.TryNormalize(s, "mainnet", out _, out _));

    [Fact]
    public void TestnetAddress_IsRejectedOnMainnet()
    {
        var w = new TestWallet();
        var test = KaspaMessageSigner.AddressFromXOnly(KaspaMessageSigner.XOnlyPublicKey(w.Private), "testnet-10");
        Assert.StartsWith("kaspatest:", test);
        Assert.False(KaspaAddress.TryNormalize(test, "mainnet", out _, out _));
    }

    [Fact]
    public void EcdsaAndScriptHashAddresses_AreRejected()
    {
        var payload33 = new byte[33];
        payload33[0] = 2; payload33[1] = 1;
        var ecdsa = KaspaBech32.Encode("kaspa", KaspaBech32.PubKeyEcdsaVersion, payload33);
        Assert.False(KaspaAddress.TryNormalize(ecdsa, "mainnet", out _, out _));
        var p2sh = KaspaBech32.Encode("kaspa", KaspaBech32.ScriptHashVersion, new byte[32]);
        Assert.False(KaspaAddress.TryNormalize(p2sh, "mainnet", out _, out _));
    }
}

public class KaspaSignatureTests
{
    // Vectors from rusty-kaspa wallet/core/src/message.rs (same ones the Xiangqi server tests use).
    private const string PubKey0 = "F9308A019258C31049344F85F89D5229B531C845836F99B08601F113BCE036F9";
    private const string Sig0 =
        "40B9BB2BE0AE02607279EDA64015A8D86E37632791703 40B8243F7CE5344D77AFF1191598BAF2FD26149CAC3B4B12C2C433261C00834DB6098CB172AA48EF522";
    private const string PubKey1 = "DFF1D77F2A671C5F36183726DB2341BE58FEAE1DA2DECED843240F7B502BA659";
    private const string Priv1 = "B7E151628AED2A6ABF7158809CF4F3C762E7160F38B4DA56A784D9045190CFEF";
    private const string Sig1 =
        "EB9E8A3C547EB91B6A7592644F328F0648BDD21ABA3CD44787D429D4D790AA8B962745691F3B472ED8D65F3B770ECB4F777BD17B1D309100919B53E0E206B4C6";

    private static byte[] Hex(string s) => Convert.FromHexString(s.Replace(" ", ""));

    [Fact]
    public void RustyKaspaVector0_Verifies()
    {
        var address = KaspaMessageSigner.AddressFromXOnly(Hex(PubKey0), "mainnet");
        var check = KaspaMessageSigner.Verify(address, "Hello Kaspa!", Sig0.Replace(" ", ""), "mainnet");
        Assert.True(check.Valid, check.Error);
    }

    [Fact]
    public void RustyKaspaVector1_SignsIdenticallyAndVerifies()
    {
        var aux = new byte[32];
        aux[31] = 1;
        var sig = KaspaMessageSigner.Sign("Hello Kaspa!", Hex(Priv1), aux);
        Assert.Equal(Sig1, Convert.ToHexString(sig));
        Assert.Equal(PubKey1, Convert.ToHexString(KaspaMessageSigner.XOnlyPublicKey(Hex(Priv1))));
        var address = KaspaMessageSigner.AddressFromXOnly(Hex(PubKey1), "mainnet");
        Assert.True(KaspaMessageSigner.Verify(address, "Hello Kaspa!", Convert.ToBase64String(sig), "mainnet").Valid);
    }

    [Fact]
    public void GeneratedKey_RoundTrips_AndRejectsTampering()
    {
        var w = new TestWallet();
        const string msg = "life.kastop.com 登录验证\nNonce: abc";
        var sigHex = Convert.ToHexString(KaspaMessageSigner.Sign(msg, w.Private)).ToLowerInvariant();
        Assert.True(KaspaMessageSigner.Verify(w.Address, msg, sigHex, "mainnet").Valid);
        Assert.True(KaspaMessageSigner.Verify(w.Address, msg, w.Sign(msg), "mainnet").Valid); // base64 也接受
        Assert.False(KaspaMessageSigner.Verify(w.Address, msg + "x", sigHex, "mainnet").Valid);
        Assert.False(KaspaMessageSigner.Verify(new TestWallet().Address, msg, sigHex, "mainnet").Valid); // 别人的地址
        Assert.False(KaspaMessageSigner.Verify(w.Address, msg, "zz", "mainnet").Valid);
        Assert.False(KaspaMessageSigner.Verify(w.Address, msg, null, "mainnet").Valid);
        var flipped = sigHex[..^1] + (sigHex[^1] == '0' ? '1' : '0');
        Assert.False(KaspaMessageSigner.Verify(w.Address, msg, flipped, "mainnet").Valid);
    }
}
