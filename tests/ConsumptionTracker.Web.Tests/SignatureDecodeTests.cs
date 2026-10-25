using System.Security.Cryptography;
using ConsumptionTracker.Web.Kaspa;

namespace ConsumptionTracker.Web.Tests;

/// <summary>
/// 回归：base64 签名以 "0x"/"0X" 开头时（约 1/2000），曾被误当作十六进制 0x 前缀剥掉，导致登录偶发 401
/// （这就是 ImportRejectionTests 偶发失败的真正原因：测试里用随机私钥登录）。
/// </summary>
public class SignatureDecodeTests
{
    private static byte[] Sig64(byte b0, byte b1)
    {
        var b = new byte[64]; b[0] = b0; b[1] = b1; for (var i = 2; i < 64; i++) b[i] = (byte)i; return b;
    }

    [Theory]
    [InlineData(0xD3, 0x10)] // base64 以 "0x" 开头
    [InlineData(0xD1, 0x70)] // base64 以 "0X" 开头
    [InlineData(0xC3, 0x10)] // 普通开头
    public void Base64_Decodes_EvenWhenItStartsWith0x(int b0, int b1)
    {
        var raw = Sig64((byte)b0, (byte)b1);
        var b64 = Convert.ToBase64String(raw);
        if (b0 == 0xD3) Assert.StartsWith("0x", b64);
        if (b0 == 0xD1) Assert.StartsWith("0X", b64);
        Assert.Equal(raw, KaspaMessageSigner.DecodeSignature(b64));
        Assert.Equal(raw, KaspaMessageSigner.DecodeSignature("  " + b64 + "\n"));
    }

    [Fact]
    public void Hex_WithAndWithout0xPrefix_StillDecodes()
    {
        var raw = Sig64(0x12, 0x34);
        var hex = Convert.ToHexString(raw).ToLowerInvariant();
        Assert.Equal(raw, KaspaMessageSigner.DecodeSignature(hex));
        Assert.Equal(raw, KaspaMessageSigner.DecodeSignature("0x" + hex));
        Assert.Equal(raw, KaspaMessageSigner.DecodeSignature("0X" + hex.ToUpperInvariant()));
    }

    [Fact]
    public void Garbage_And_WrongLength_AreRejected()
    {
        Assert.Null(KaspaMessageSigner.DecodeSignature(null));
        Assert.Null(KaspaMessageSigner.DecodeSignature("0x"));
        Assert.Null(KaspaMessageSigner.DecodeSignature("0x1234"));
        Assert.Null(KaspaMessageSigner.DecodeSignature(Convert.ToBase64String(new byte[63])));
        Assert.Null(KaspaMessageSigner.DecodeSignature("!!!"));
    }

    [Fact]
    public void RealSignature_Starting0x_VerifiesEndToEnd()
    {
        // 磨出一个真实的、base64 以 0x/0X 开头的签名（概率 ≈1/2000，上限 60000 次）
        var w = new TestWallet();
        const string msg = "life.kastop.com 登录验证\nNonce: abc";
        for (var i = 0; i < 60000; i++)
        {
            var sig = KaspaMessageSigner.Sign(msg + i, w.Private, RandomNumberGenerator.GetBytes(32));
            var b64 = Convert.ToBase64String(sig);
            if (!b64.StartsWith("0x", StringComparison.OrdinalIgnoreCase)) continue;
            Assert.True(KaspaMessageSigner.Verify(w.Address, msg + i, b64, "mainnet").Valid);
            return;
        }
        Assert.Fail("没有磨出样本（概率极低）");
    }
}
