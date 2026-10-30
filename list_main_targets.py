import struct
b=open('client-0.3.2/beenet.exe','rb').read(); image=0x140000000; base=0x4715a0; nfunc=struct.unpack_from('<Q',b,base+8)[0]; namebase=base+0x48; p=base+0x1a0578
for i in range(nfunc):
 entry,fo=struct.unpack_from('<II',b,p+i*8); u=p+fo
 if u+8>len(b): continue
 no=struct.unpack_from('<i',b,u+4)[0]; off=namebase+no
 if not (0<=off<len(b)): continue
 end=b.find(b'\0',off); name=b[off:end].decode('utf8','ignore')
 if name.startswith('main.') and any(k in name.lower() for k in ['signup','localapi','chat','handler','gateway','signin','preset','account','consent','state','recovery','key']):
  print(f'{i:5} {image+0x1000+entry:#x} {name}')
