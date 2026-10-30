import re
b=open('client-0.3.2/beenet.exe','rb').read()
# print ASCII runs containing keywords; includes Go names and strings
for kw in ['signup','localapi','chat','gateway','signin','presets','apiSignup','handle']:
 print('\n###',kw)
 seen=set();
 for m in re.finditer(rb'[ -~]{4,}',b):
  s=m.group().decode('ascii','ignore')
  if kw.lower() in s.lower():
   t=s[:300]
   if t not in seen: print(hex(0x140000000+m.start()),repr(t)); seen.add(t)
