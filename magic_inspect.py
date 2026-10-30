b=open('client-0.3.2/beenet.exe','rb').read()
for off in [0x283ff7,0x2b70e4,0x2c0f6d,0x470a4c]: print(hex(off),b[off:off+64].hex())
