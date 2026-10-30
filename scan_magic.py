b=open('client-0.3.2/beenet.exe','rb').read()
for magic in [b'\xfb\xff\xff\xff',b'\xfa\xff\xff\xff',b'\xf1\xff\xff\xff']:
 print(magic,[hex(i) for i in range(len(b)) if b.startswith(magic,i)][:20])
