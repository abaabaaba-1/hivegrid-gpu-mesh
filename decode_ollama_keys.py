# load functions from prior script without run
exec(open('decode_chat_strings.py').read().split('addrs=')[0])
addrs=[(0x1403fc470,4),(0x1403ff00f,11),(0x140400adc,14),(0x1403fe728,10),(0x1403fcca2,6),(0x1403fc418,4),(0x1403fc7e1,5),(0x1403fc3f8,4),(0x140404652,20),(0x1403fd14c,7),(0x1403fc3fc,4),(0x1403fc414,4),(0x1403fcc96,6),(0x1403fcc9c,6),(0x1403fc470,4)]
for va,n in addrs:
 x=sliceat(va,n); print(hex(va),n,repr(x.decode('utf-8','replace')))
