b=open('client-0.3.2/beenet.exe','rb').read();
for name,start,end in [('ui1.js',0x430000,0x440000),('chat.js',0x440000,0x45c000)]:
 open(name,'wb').write(b[start:end])
