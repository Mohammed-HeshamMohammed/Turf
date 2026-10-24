"""A small PDF writer for report tables: Helvetica text, landscape A4 pages, no dependencies (plan 3.6, PDF output)."""

from __future__ import annotations

WIDTH, HEIGHT = 842, 595  # A4 landscape, points
MARGIN = 36
LINE = 14


def _escape(text: str) -> str:
    # PDF strings: escape the delimiters, and keep to Latin-1 for the built-in font.
    text = text.encode("latin-1", "replace").decode("latin-1")
    return text.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")


def _cell(value: object) -> str:
    if value is None:
        return ""
    return str(value)


def table_pdf(title: str, rows: list[dict], subtitle: str = "") -> bytes:
    columns = list(rows[0].keys()) if rows else []
    usable = WIDTH - 2 * MARGIN
    width = usable / max(1, len(columns))
    limit = max(4, int(width / 5.2))  # characters that fit a column at 9 pt

    def clip(text: str) -> str:
        return text if len(text) <= limit else text[: limit - 1] + "…"

    lines_per_page = int((HEIGHT - 2 * MARGIN - 3 * LINE) / LINE)
    body = [[clip(_cell(row.get(column))) for column in columns] for row in rows] or [["No rows"]]
    pages = [body[i:i + lines_per_page] for i in range(0, len(body), lines_per_page)]
    streams = []
    for number, page in enumerate(pages, 1):
        parts = ["BT", "/F2 14 Tf", f"{MARGIN} {HEIGHT - MARGIN} Td", f"({_escape(title)}) Tj", "ET"]
        parts += ["BT", "/F1 9 Tf", f"{MARGIN} {HEIGHT - MARGIN - LINE} Td", f"({_escape(subtitle + f'  ·  page {number} of {len(pages)}')}) Tj", "ET"]
        y = HEIGHT - MARGIN - 3 * LINE
        for index, column in enumerate(columns):
            parts += ["BT", "/F2 9 Tf", f"{MARGIN + index * width:.1f} {y} Td", f"({_escape(clip(column.replace('_', ' ')))}) Tj", "ET"]
        for row in page:
            y -= LINE
            for index, text in enumerate(row):
                parts += ["BT", "/F1 9 Tf", f"{MARGIN + index * width:.1f} {y} Td", f"({_escape(text)}) Tj", "ET"]
        streams.append("\n".join(parts).encode("latin-1"))
    objects: list[bytes] = []
    page_ids = [5 + 2 * i for i in range(len(streams))]
    objects.append(b"<< /Type /Catalog /Pages 2 0 R >>")
    objects.append(f"<< /Type /Pages /Kids [{' '.join(f'{p} 0 R' for p in page_ids)}] /Count {len(page_ids)} >>".encode())
    objects.append(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>")
    objects.append(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>")
    for page_id, stream in zip(page_ids, streams):
        objects.append(f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {WIDTH} {HEIGHT}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> "
                       f"/Contents {page_id + 1} 0 R >>".encode())
        objects.append(f"<< /Length {len(stream)} >>\nstream\n".encode() + stream + b"\nendstream")
    out = bytearray(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
    offsets = []
    for number, obj in enumerate(objects, 1):
        offsets.append(len(out))
        out += f"{number} 0 obj\n".encode() + obj + b"\nendobj\n"
    xref = len(out)
    out += f"xref\n0 {len(objects) + 1}\n0000000000 65535 f \n".encode()
    for offset in offsets:
        out += f"{offset:010d} 00000 n \n".encode()
    out += f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode()
    return bytes(out)
