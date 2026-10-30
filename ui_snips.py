b=open('client-0.3.2/beenet.exe','rb').read();
for off in [0x435700,0x435800,0x43b900,0x43ba00,0x43bbe0,0x43d800,0x440000]:
 print('\n--',hex(off),'--'); print(b[off:off+1200].decode('utf-8','ignore'))
