import struct
b=open('client-0.3.2/beenet.exe','rb').read(); image=0x140000000; e=struct.unpack_from('<I',b,0x3c)[0]; fh=e+4; ns=struct.unpack_from('<H',b,fh+2)[0]; opt=fh+20; sz=struct.unpack_from('<H',b,fh+16) [0]; sh=opt+sz; secs=[]
for i in range(ns):
 o=sh+i*40; name=b[o:o+8].split(b'\0')[0].decode(); vs,va,rs,rp=struct.unpack_from('<IIII',b,o+8); secs.append((name,va,vs,rp,rs))
def get(va):
 rva=va-image
 for name,sv,vs,rp,rs in secs:
  if sv<=rva<sv+max(vs,rs):
   fo=rp+rva-sv; end=fo
   while end<len(b) and 32<=b[end]<127: end+=1
   print(hex(va),repr(b[fo:end].decode('ascii','ignore')),b[fo:fo+80])
for va in [0x1403fd7f1,0x1403fd1df,0x1403fd145,0x140400205,0x1404002ae,0x140407427,0x1403fc7e1,0x1403fc84f,0x1403fc186]: get(va)
