b=open('client-0.3.2/beenet.exe','rb').read(); s=b'main.(*Server).signup'; off=b.find(s); print(hex(off),hex(0x140000000+off))
for i in range(off-64,off+128,16): print(hex(i),b[i:i+16].hex())
