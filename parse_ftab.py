import struct
b=open('client-0.3.2/beenet.exe','rb').read(); image=0x140000000; base=0x4715a0; nfunc=struct.unpack_from('<Q',b,base+8)[0]; namebase=base+0x48; p=base+0x1a0578
print('nfunc',nfunc,'p',hex(p),'namebase',hex(namebase))
for i in range(nfunc):
 entry,fo=struct.unpack_from('<II',b,p+i*8)
 u=p+fo
 if u+8>len(b): continue
 nameoff=struct.unpack_from('<i',b,u+4)[0]
 no=namebase+nameoff
 if 0<=no<len(b):
  end=b.find(b'\0',no); name=b[no:end].decode('utf8','ignore')
  if any(k in name for k in ['Server).signup','Server).localAPI','Platform).Signup','Server).v1Chat','Server).ollamaChat','Server).chatSearch','Server).Handler']):
   print(i, 'entry',hex(entry),'funcOff',hex(fo),'funcFile',hex(u),'nameOff',nameoff,name)
