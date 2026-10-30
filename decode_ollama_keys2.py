exec(open('decode_chat_strings.py').read().split('addrs=')[0])
for va,n in [(0x1403fe656,10),(0x1403fe71e,10),(0x1403fe728,10),(0x1403ff00f,11),(0x1403ff857,12),(0x140400adc,14),(0x1403fd7d9,8),(0x1403fd7e1,8)]: print(hex(va),repr(sliceat(va,n).decode('utf-8','replace')))
