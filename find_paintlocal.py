b=open('client-0.3.2/beenet.exe','rb').read(); key=b'paintLocal'; pos=0
while True:
 pos=b.find(key,pos)
 if pos<0: break
 print(hex(pos)); print(b[max(0,pos-1500):pos+1500].decode('utf-8','ignore')); pos+=1
