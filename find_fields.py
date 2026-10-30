b=open('client-0.3.2/beenet.exe','rb').read()
for kw in [b'invite_code',b'recovery_code',b'api_key',b'account',b'key']:
 print('\n',kw)
 pos=0
 while True:
  pos=b.find(kw,pos)
  if pos<0: break
  print(hex(pos),b[max(0,pos-80):pos+160].decode('utf-8','ignore').replace('\n',' ')); pos+=1
