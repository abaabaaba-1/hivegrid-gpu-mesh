import struct
b=open('client-0.3.2/beenet.exe','rb').read(); base=0x4715a0
for rel in [0x48,0x69c80,0x6ec78,0x74740,0x1a0578,0x1a0578+0x100,0x1a0578+0x5000]:
 print(hex(rel),hex(base+rel),b[base+rel:base+rel+32].hex())
