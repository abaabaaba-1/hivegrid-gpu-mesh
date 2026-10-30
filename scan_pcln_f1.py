b=open('client-0.3.2/beenet.exe','rb').read()
for i in range(len(b)-8):
 if b[i:i+4]==b'\xf1\xff\xff\xff':
  x=b[i:i+20]
  if x[4] < 10 and x[5] < 10 and x[6] in (1,2,4,8) and x[7] in (4,8): print(hex(i),x.hex())
