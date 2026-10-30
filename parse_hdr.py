import struct
b=open('client-0.3.2/beenet.exe','rb').read(); off=0x4715a0
print('hdr',b[off:off+80].hex())
for i in range(8,80,8): print(i,hex(struct.unpack_from('<Q',b,off+i)[0]))
