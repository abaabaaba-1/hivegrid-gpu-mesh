import json
p=json.load(open('beenet-ollama-chat-evidence.json',encoding='utf-8')); n=p['records'][0]['normalized_result']; open('ollama-pseudocode.txt','w',encoding='utf-8').write(n['pseudocode']); print('chars',len(n['pseudocode']))
