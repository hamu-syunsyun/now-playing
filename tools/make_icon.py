"""アイコンを描いて icons/ に書き出す。外部ライブラリなし。 python tools/make_icon.py"""
import os
import struct
import zlib

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "icons")

INK = (20, 50, 58)       # 地の色
JACKET = (240, 160, 75)  # ジャケット
PAPER = (251, 233, 198)  # 歌詞の行

SS = 4  # 1ピクセルを 4x4 に割ってなめらかにする


def in_round_rect(x, y, x0, y0, x1, y1, r):
    if not (x0 <= x <= x1 and y0 <= y <= y1):
        return False
    cx = min(max(x, x0 + r), x1 - r)
    cy = min(max(y, y0 + r), y1 - r)
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r


def shapes(corner):
    # (判定, 色, 不透明度) を下から順に
    return [
        (lambda x, y: in_round_rect(x, y, 0, 0, 1, 1, corner), INK, 1),
        (lambda x, y: in_round_rect(x, y, .13, .32, .49, .68, .04), JACKET, 1),
        (lambda x, y: (x - .35) ** 2 + (y - .46) ** 2 <= .085 ** 2, PAPER, 1),
        (lambda x, y: in_round_rect(x, y, .57, .35, .82, .42, .035), PAPER, .4),
        (lambda x, y: in_round_rect(x, y, .57, .465, .87, .535, .035), PAPER, 1),
        (lambda x, y: in_round_rect(x, y, .57, .58, .76, .65, .035), PAPER, .4),
    ]


def render(size, corner=.22):
    layers = shapes(corner)
    rows = []
    for py in range(size):
        row = bytearray([0])  # PNG の行フィルタ（なし）
        for px in range(size):
            r = g = b = a = 0.0
            for sy in range(SS):
                for sx in range(SS):
                    x = (px + (sx + .5) / SS) / size
                    y = (py + (sy + .5) / SS) / size
                    cr = cg = cb = ca = 0.0
                    for hit, color, alpha in layers:
                        if hit(x, y):
                            cr = color[0] * alpha + cr * (1 - alpha)
                            cg = color[1] * alpha + cg * (1 - alpha)
                            cb = color[2] * alpha + cb * (1 - alpha)
                            ca = alpha + ca * (1 - alpha)
                    r += cr * ca; g += cg * ca; b += cb * ca; a += ca
            n = SS * SS
            if a:
                row += bytes((round(r / a), round(g / a), round(b / a), round(a / n * 255)))
            else:
                row += b"\0\0\0\0"
        rows.append(bytes(row))
    return png(size, b"".join(rows))


def png(size, raw):
    def chunk(kind, data):
        body = kind + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body))
    return (b"\x89PNG\r\n\x1a\n"
            + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw, 9))
            + chunk(b"IEND", b""))


def ico(images):
    head = struct.pack("<HHH", 0, 1, len(images))
    offset = 6 + 16 * len(images)
    entries = b""
    for size, data in images:
        entries += struct.pack("<BBBBHHII", size % 256, size % 256, 0, 0, 1, 32, len(data), offset)
        offset += len(data)
    return head + entries + b"".join(d for _, d in images)


if __name__ == "__main__":
    os.makedirs(OUT, exist_ok=True)
    with open(os.path.join(OUT, "app.ico"), "wb") as f:
        f.write(ico([(s, render(s)) for s in (16, 32, 48, 64, 256)]))
    # iPhone のホーム画面用は角を丸めない（iOS が自分で丸める）
    for name, size, corner in (("icon-180.png", 180, 0), ("icon-512.png", 512, 0), ("favicon.png", 64, .22)):
        with open(os.path.join(OUT, name), "wb") as f:
            f.write(render(size, corner))
    print("icons/ に書き出しました")
