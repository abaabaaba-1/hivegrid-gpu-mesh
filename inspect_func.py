import struct
b=open('client-0.3.2/beenet.exe','rb').read(); base=0x4715a0; p=base+0x1a0578
for rel in [0x110d8,0x11108,0x11160,0x11188]:
 o=p+rel; print(hex(rel),hex(o),b[o:o+64].hex())
