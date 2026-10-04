"""index.html の中の ?v=... を今の時刻に書き換える。公開前に実行する。 python tools/stamp.py

GitHub Pages はファイルを10分ほど端末に覚えさせるので、これをしないと
新しい HTML と古い CSS/JS が混ざって画面が崩れる。
"""
import os
import re
import time

path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "index.html")
with open(path, encoding="utf-8") as f:
    html = f.read()
stamp = time.strftime("%Y%m%d%H%M%S")
html, n = re.subn(r"\?v=\w+", "?v=" + stamp, html)
with open(path, "w", encoding="utf-8", newline="\n") as f:
    f.write(html)
print(f"{n} か所を v={stamp} にしました")
