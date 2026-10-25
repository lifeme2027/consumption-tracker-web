# 生成一个校验和合法的随机 kaspa:q 主网地址（仅用于本地冒烟测试，没有对应私钥）
import os
CH="qpzry9x8gf2tvdw0s3jn54khce6mua7l"
def polymod(v):
    c=1
    for d in v:
        c0=c>>35; c=((c&0x07ffffffff)<<5)^d
        for i,g in enumerate([0x98f2bc8e61,0x79b76d99e2,0xf33e5fb3c4,0xae2eabe2a8,0x1e4f43e470]):
            if (c0>>i)&1: c^=g
    return c^1
def conv(data):
    acc=0;bits=0;out=[]
    for b in data:
        acc=(acc<<8)|b;bits+=8
        while bits>=5: bits-=5; out.append((acc>>bits)&31)
    if bits: out.append((acc<<(5-bits))&31)
    return out
def addr(payload):
    pre=[ord(c)&31 for c in "kaspa"]+[0]
    data=conv(bytes([0])+payload)
    cs=polymod(pre+data+[0]*8)
    cs5=[(cs>>(5*(7-i)))&31 for i in range(8)]
    return "kaspa:"+"".join(CH[d] for d in data+cs5)
print(addr(os.urandom(32)))
