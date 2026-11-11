"""Generate standalone barcode PNGs and an offline, phone-friendly sample sheet."""
import base64
import html
import json
import struct
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
# ISO Code 128 symbol widths, indexed by symbol value (stop is 106).
PATTERNS = '''212222 222122 222221 121223 121322 131222 122213 122312 132212 221213 221312 231212 112232 122132 122231 113222 123122 123221 223211 221132 221231 213212 223112 312131 311222 321122 321221 312212 322112 322211 212123 212321 232121 111323 131123 131321 112313 132113 132311 211313 231113 231311 112133 112331 132131 113123 113321 133121 313121 211331 231131 213113 213311 213131 311123 311321 331121 312113 312311 332111 314111 221411 431111 111224 111422 121124 121421 141122 141221 112214 112412 122114 122411 142112 142211 241211 221114 413111 241112 134111 111242 121142 121241 114212 124112 124211 411212 421112 421211 212141 214121 412121 111143 111341 131141 114113 114311 411113 411311 113141 114131 311141 411131 211412 211214 211232 2331112'''.split()


def code128(value):
    symbols = [ord(c) - 32 for c in value]
    if not all(0 <= s <= 94 for s in symbols):
        raise ValueError('Sample generator supports printable ASCII in Code 128 B.')
    checksum = (104 + sum(i * v for i, v in enumerate(symbols, 1))) % 103
    bits = '0' * 12
    for symbol in [104, *symbols, checksum, 106]:
        bits += ''.join(('1' if i % 2 == 0 else '0') * int(width)
                        for i, width in enumerate(PATTERNS[symbol]))
    return bits + '0' * 12


def ean13(value):
    if len(value) != 13 or not value.isdigit():
        raise ValueError('EAN-13 needs 13 digits.')
    if sum(int(c) * (1 if i % 2 == 0 else 3) for i, c in enumerate(value[:12])) % 10 != (10-int(value[-1])) % 10:
        raise ValueError('Invalid EAN checksum.')
    left = ['0001101','0011001','0010011','0111101','0100011','0110001','0101111','0111011','0110111','0001011']
    parity = ['LLLLLL','LLGLGG','LLGGLG','LLGGGL','LGLLGG','LGGLLG','LGGGLL','LGLGLG','LGLGGL','LGGLGL'][int(value[0])]
    bits = '0'*12 + '101'
    for c, mode in zip(value[1:7], parity):
        pattern = left[int(c)]
        bits += pattern if mode == 'L' else ''.join('1' if b == '0' else '0' for b in pattern[::-1])
    bits += '01010'
    bits += ''.join(''.join('1' if b == '0' else '0' for b in left[int(c)]) for c in value[7:])
    return bits + '101' + '0'*12


def png(bits, scale=5, height=260):
    width = len(bits)*scale
    bar_row = b''.join((b'\x00' if bit == '1' else b'\xff')*scale for bit in bits)
    rows = b''.join(b'\x00' + (b'\xff'*width if y < 24 or y >= height-24 else bar_row) for y in range(height))
    def chunk(kind, data):
        return struct.pack('!I',len(data)) + kind + data + struct.pack('!I',zlib.crc32(kind+data)&0xffffffff)
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR',struct.pack('!2I5B',width,height,8,0,0,0,0)) + chunk(b'IDAT',zlib.compress(rows)) + chunk(b'IEND',b'')


def main():
    target = ROOT / 'samples'
    target.mkdir(exist_ok=True)
    products = json.loads((ROOT / 'data/products.json').read_text(encoding='utf-8'))
    products.append({'barcode':'UNKNOWN999', 'name':'Unknown product test', 'priceCentavos':0})
    cards=[]
    for product in products:
        value = product['barcode']
        retail = value.isdigit() and len(value)==13
        image = png(ean13(value) if retail else code128(value))
        (target / (value+'.png')).write_bytes(image)
        uri='data:image/png;base64,'+base64.b64encode(image).decode()
        note='Expected: unknown product; cart unchanged.' if value=='UNKNOWN999' else f"Expected: {product['name']} / PHP {product['priceCentavos']/100:.2f}"
        cards.append(f'<article><h2>{html.escape(product["name"])}</h2><p>{"EAN-13" if retail else "Code 128"} · <strong>{value}</strong></p><img src="{uri}" alt="Barcode encoding {value}"><p>{html.escape(note)}</p><a href="{uri}" download="{value}.png">Save PNG</a></article>')
    page='''<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Smart Shopping barcode samples</title>
<style>body{font-family:system-ui;margin:0;padding:20px;background:#edf3e9;color:#18362f}main{max-width:760px;margin:auto}article{background:white;padding:20px;margin:24px 0;border-radius:12px;break-inside:avoid}img{width:100%;height:auto;display:block}p{line-height:1.5}h2{font-size:20px}a{color:#216344}</style><main><h1>Scan from your phone</h1><p>Open this file on your phone, or send a PNG to your phone and open it full screen. Hold one code in front of the laptop camera. Raise screen brightness, keep the white margins visible, and avoid reflections. These are synthetic demo labels, not registered commercial product codes.</p><p>Start with DEMO004. Each click on Scan one item should add exactly one packet of noodles. Click again deliberately to add another.</p>'''+''.join(cards)+'</main></html>'
    (target / 'barcode-samples.html').write_text(page,encoding='utf-8')
    print(f'Generated {len(cards)} PNGs and standalone sample sheet in {target}')


if __name__ == '__main__':
    main()
