import struct
b=open('client-0.3.2/beenet.exe','rb').read(); image=0x140000000; e=struct.unpack_from('<I',b,0x3c)[0]; fh=e+4; ns=struct.unpack_from('<H',b,fh+2)[0]; opt=fh+20; sz=struct.unpack_from('<H',b,fh+16)[0]; sh=opt+sz; secs=[]
for i in range(ns):
 o=sh+i*40; name=b[o:o+8].split(b'\0')[0].decode(); vs,va,rs,rp=struct.unpack_from('<IIII',b,o+8); secs.append((name,va,vs,rp,rs))
def sliceat(va,n):
 rva=va-image
 for name,sv,vs,rp,rs in secs:
  if sv<=rva<sv+max(vs,rs):
   fo=rp+rva-sv; return b[fo:fo+n]
addrs=[(0x1403fc7eb,5),(0x1403fcbe2,6),(0x1403fd751,8),(0x1403fcbd6,6),(0x1403fc40c,4),(0x1403fd14c,7),(0x1403fcc90,6),(0x1403fcc8a,6),(0x1403fcc96,6),(0x1403fcc9c,6),(0x1403feff9,11),(0x140401344,15),(0x1403fd1c3,7),(0x1403fef80,11),(0x1403fc7ff,5),(0x1403fc468,4),(0x1403fc418,4),(0x1403ff004,11),(0x140401c82,16),(0x1404001de,13),(0x140400a7a,14)]
for va,n in addrs:
 x=sliceat(va,n); print(hex(va),n,repr(x.decode('utf-8','replace')),x.hex())
