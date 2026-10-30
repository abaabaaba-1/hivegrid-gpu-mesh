import re,struct
# setup map
b=open('client-0.3.2/beenet.exe','rb').read(); image=0x140000000; e=struct.unpack_from('<I',b,0x3c)[0]; fh=e+4; ns=struct.unpack_from('<H',b,fh+2)[0]; opt=fh+20; sz=struct.unpack_from('<H',b,fh+16)[0]; sh=opt+sz; secs=[]
for i in range(ns):
 o=sh+i*40; name=b[o:o+8].split(b'\0')[0].decode(); vs,va,rs,rp=struct.unpack_from('<IIII',b,o+8); secs.append((name,va,vs,rp,rs))
def at(va):
 rva=va-image
 for name,sv,vs,rp,rs in secs:
  if sv<=rva<sv+max(vs,rs):
   fo=rp+rva-sv; x=b[fo:fo+80];
   # printable prefix; decode
   return x.split(b'\0')[0].decode('utf-8','replace')
text=open('ollama-pseudocode.txt',encoding='utf-8').read()
addrs=sorted(set(int(x,16) for x in re.findall(r'DAT_(140[0-9a-f]+)',text)))
for va in addrs:
 s=at(va)
 if s and any(c.isalpha() for c in s): print(hex(va),repr(s[:80]))
