import re
text=open('ollama-pseudocode.txt',encoding='utf-8').read()
for m in re.finditer(r'&DAT_(140[0-9a-f]+),\s*(0x[0-9a-f]+|\d+)',text):
 print(m.group(1),m.group(2))
