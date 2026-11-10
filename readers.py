"""Turning an uploaded file into batches of rows of text. Pieces are joined into one file as they are used (and deleted as they are
joined); CSV and TXT are read by polars in batches, XLSX row by row, so memory stays small however big the list is."""
import codecs
import csv
import datetime
import itertools
import os
import zipfile
from pathlib import Path
from typing import Iterator

import polars as pl
from openpyxl.utils.exceptions import InvalidFileException
from xlrd import XLRDError

# Keep each database transaction small enough for ordinary hosted PostgreSQL limits.
BATCH_ROWS = 5_000
_PROGRESS = "assembled.progress"
_PARTIAL = "assembled.part"


def assemble(folder: Path, sizes: list[int], extension: str) -> Path:
    """Joins the pieces 0.part, 1.part... into source<extension>, deleting each once it is in. A restart carries on: how many
    pieces are in is written down after each one, and a half-written tail is cut off before going on."""
    final = folder / f"source{extension}"
    if final.exists():
        return final
    partial, progress = folder / _PARTIAL, folder / _PROGRESS
    done = int(progress.read_text()) if progress.exists() else 0
    expected = sum(sizes[:done])
    if not partial.exists():
        done, expected = 0, 0
        partial.touch()
    with open(partial, "r+b") as out:
        out.truncate(expected)
        out.seek(expected)
        for n in range(done, len(sizes)):
            piece = folder / f"{n}.part"
            with open(piece, "rb") as src:
                while block := src.read(1 << 20):
                    out.write(block)
            out.flush()
            os.fsync(out.fileno())
            progress.write_text(str(n + 1))
            piece.unlink()
    os.replace(partial, final)
    progress.unlink(missing_ok=True)
    return final


def prepare(folder: Path, sizes: list[int], extension: str) -> Path:
    """The upload as one file ready to read (text lists as UTF-8), made once; a restart finds it again."""
    done = folder / f"source.utf8{extension}"
    if done.exists():
        return done
    source = assemble(folder, sizes, extension)
    return to_utf8(source) if extension in (".csv", ".txt") else source


def headers_of(path: Path, has_header: bool) -> list[str]:
    for headers, _ in read_batches(path, has_header):
        return headers
    return []


def survey(path: Path, has_header: bool, sample: int = 300) -> tuple[list[str], list[int], int, int, list[tuple]]:
    """What the list holds, without storing any of it: (headers, cells filled per column, rows, blank rows, the first `sample` rows).
    One pass over the file; the person is then asked what each column is before a single row is loaded."""
    headers: list[str] = []
    filled: list[int] = []
    rows = blank = 0
    first: list[tuple] = []
    for headers, frame in read_batches(path, has_header):
        has_text = frame.select(pl.all().str.strip_chars() != "")
        counts = has_text.sum().row(0)
        filled = [a + b for a, b in zip(filled, counts)] if filled else list(counts)
        blank += frame.height - has_text.select(pl.any_horizontal(pl.all())).to_series().sum()
        rows += frame.height
        if len(first) < sample:
            first += frame.head(sample - len(first)).rows()
    return headers, filled, rows, blank, first


def detect_encoding(sample: bytes) -> str:
    if sample.startswith(codecs.BOM_UTF8):
        return "utf-8-sig"
    if sample.startswith((codecs.BOM_UTF16_LE, codecs.BOM_UTF16_BE)):
        return "utf-16"
    try:
        sample.decode("utf-8")
    except UnicodeDecodeError as error:
        # A multi-byte character cut by the end of the sample is not a different encoding.
        if error.start < len(sample) - 4:
            return "cp1252"
    return "utf-8"


def is_utf8(path: Path) -> bool:
    """Whether the whole file is valid UTF-8; a bad byte far past the first sample is what makes a list Windows-1252."""
    decoder = codecs.getincrementaldecoder("utf-8")()
    try:
        with open(path, "rb") as f:
            while block := f.read(1 << 20):
                decoder.decode(block)
        decoder.decode(b"", final=True)
    except UnicodeDecodeError:
        return False
    return True


def to_utf8(path: Path) -> Path:
    """The same text as UTF-8: lists exported from Excel are often Windows-1252 or UTF-16."""
    with open(path, "rb") as f:
        encoding = detect_encoding(f.read(1 << 18))
    if encoding == "utf-8" and not is_utf8(path):
        encoding = "cp1252"
    if encoding == "utf-8":
        return path
    target = path.with_suffix(".utf8" + path.suffix)
    with open(path, "r", encoding=encoding, errors="replace", newline="") as src, open(target, "w", encoding="utf-8", newline="") as out:
        while block := src.read(1 << 20):
            out.write(block)
    path.unlink()
    return target


def delimiter(path: Path) -> str:
    with open(path, "r", encoding="utf-8", errors="replace", newline="") as f:
        sample = f.read(1 << 16)
    if not sample.strip():
        return ","
    try:
        return csv.Sniffer().sniff(sample, delimiters=",;\t|").delimiter
    except csv.Error:
        return "\t" if sample.count("\t") > sample.count(",") else ","


def clean_headers(raw: list) -> list[str]:
    """Names for the columns: blanks become "Column N" and repeats get a number, so every column can be told apart."""
    seen: dict[str, int] = {}
    out = []
    for i, value in enumerate(raw):
        name = str(value if value is not None else "").strip() or f"Column {i + 1}"
        seen[name] = seen.get(name, 0) + 1
        out.append(name if seen[name] == 1 else f"{name} ({seen[name]})")
    return out


def cell_text(value) -> str:
    """A spreadsheet cell as the text a person would see: whole numbers without ".0", dates as dates."""
    if value is None:
        return ""
    if isinstance(value, float):
        return str(int(value)) if value.is_integer() and abs(value) < 1e15 else repr(value)
    if isinstance(value, (datetime.datetime, datetime.date)):
        return value.isoformat()
    return str(value).strip()


def read_batches(path: Path, has_header: bool, skip_rows: int = 0) -> Iterator[tuple[list[str], pl.DataFrame]]:
    """(headers, a batch of rows as text) until the file ends. The first `skip_rows` data rows are passed over (a restart)."""
    suffix = path.suffix.lower()
    try:
        if suffix in (".xlsx", ".xlsm"):
            yield from _spreadsheet(_xlsx_rows(path), has_header, skip_rows)
        elif suffix == ".xls":
            yield from _spreadsheet(_xls_rows(path), has_header, skip_rows)
        else:
            yield from _csv_batches(path, has_header, skip_rows)
    except UnsafeFile:
        raise
    except (pl.exceptions.PolarsError, zipfile.BadZipFile, UnicodeError, csv.Error, ValueError,
            InvalidFileException, XLRDError) as error:
        raise UnreadableFile(str(error)) from error


def _spreadsheet(sheet: tuple[int, Iterator], has_header: bool, skip_rows: int):
    width, rows = sheet
    yield from _row_batches(rows, has_header, skip_rows, width)


def leading_junk(rows: list) -> int:
    """How many rows at the top are blank or a lone title line ("Leads export"), before the real header row. A file that is one column
    wide has no such rows."""
    filled = [sum(1 for v in row if cell_text(v)) for row in rows[:30]]
    if max(filled, default=0) < 2:
        return 0
    return next(i for i, n in enumerate(filled) if n >= 2)


def _row_batches(rows, has_header: bool, skip_rows: int, min_width: int = 0):
    lead = list(itertools.islice(rows, 230))
    lead = lead[leading_junk(lead) if has_header else 0:]
    if not lead:
        return
    first, head = lead[0], lead[1:]
    # shortcut: the columns are the widest of the sheet's declared width and the first 200 rows; a CSV's stray wider row after that loses its extra cells.
    width = max([len(first), min_width] + [len(r) for r in head])
    headers = clean_headers(list(first) + [None] * (width - len(first))) if has_header else [f"Column {i + 1}" for i in range(width)]
    data = itertools.chain(head, rows) if has_header else itertools.chain([first], head, rows)
    batch: list[list[str]] = []
    for number, row in enumerate(data):
        if number < skip_rows:
            continue
        batch.append(_fit(row, width))
        if len(batch) >= BATCH_ROWS:
            yield headers, _frame(headers, batch)
            batch = []
    if batch:
        yield headers, _frame(headers, batch)


def _fit(row, width: int) -> list[str]:
    cells = [cell_text(v) for v in row[:width]]
    return cells + [""] * (width - len(cells))


def _frame(headers: list[str], rows: list[list[str]]) -> pl.DataFrame:
    columns = list(zip(*rows)) if rows else [()] * len(headers)
    return pl.DataFrame({h: list(c) for h, c in zip(headers, columns)}, schema={h: pl.String for h in headers})


MAX_UNPACKED = int(os.environ.get("IMPORT_MAX_UNPACKED_MB", "8192")) << 20  # a spreadsheet may not unpack to more than this
MAX_SQUASH = 200  # nor have a big part squashed more than this many times: that is a zip bomb, not a spreadsheet


class UnsafeFile(ValueError):
    """The file would use far more memory than a real spreadsheet; it is refused before it is opened."""


class UnreadableFile(ValueError):
    """The source file has an invalid or unsupported structure."""


def check_unpacked(path: Path) -> None:
    import zipfile

    with zipfile.ZipFile(path) as archive:
        total = 0
        for part in archive.infolist():
            total += part.file_size
            if part.file_size > (50 << 20) and part.compress_size and part.file_size / part.compress_size > MAX_SQUASH:
                raise UnsafeFile(f"{part.filename} is squashed {part.file_size // part.compress_size} times")
        if total > MAX_UNPACKED:
            raise UnsafeFile(f"unpacks to {total >> 20} MB")


def _data_sheet(book):
    """The first visible sheet that has anything in it (a workbook often opens on an empty cover sheet), and its rows from the first
    nonblank one. Returns (sheet, rows)."""
    for sheet in book.worksheets:
        if sheet.sheet_state != "visible":
            continue
        rows = sheet.iter_rows(values_only=True)
        for row in rows:
            if any(cell_text(v) for v in row):
                return sheet, itertools.chain([row], rows)
    return book.worksheets[0], iter(())


def _xlsx_rows(path: Path) -> tuple[int, Iterator]:
    """(the width the sheet declares, its rows). The declared width catches a wide cell far down that the first 200 rows do not show."""
    from openpyxl import load_workbook

    check_unpacked(path)
    book = load_workbook(path, read_only=True, data_only=True)
    sheet, rows = _data_sheet(book)
    if sheet.max_column is None:  # a writer that left out the sheet's size: ask the sheet by reading it through once
        sheet.calculate_dimension(force=True)

    def generate():
        try:
            yield from rows
        finally:
            book.close()

    return sheet.max_column or 0, generate()


def _xls_rows(path: Path) -> tuple[int, Iterator]:
    import xlrd

    book = xlrd.open_workbook(path, on_demand=True)
    sheet = next((s for s in book.sheets() if s.nrows and s.visibility == 0), book.sheet_by_index(0))

    def generate():
        try:
            for r in range(sheet.nrows):
                yield sheet.row_values(r)
        finally:
            book.release_resources()

    return sheet.ncols, generate()


def other_sheets(path: Path) -> list[str]:
    """Names of the workbook's other sheets, which are not imported; empty for a CSV or a one-sheet workbook."""
    suffix = path.suffix.lower()
    try:
        if suffix in (".xlsx", ".xlsm"):
            from openpyxl import load_workbook

            book = load_workbook(path, read_only=True)
            try:
                used = _data_sheet(book)[0].title
                return [n for n in book.sheetnames if n != used]
            finally:
                book.close()
        if suffix == ".xls":
            import xlrd

            book = xlrd.open_workbook(path, on_demand=True)
            try:
                used = next((s for s in book.sheets() if s.nrows and s.visibility == 0), book.sheet_by_index(0)).name
                return [n for n in book.sheet_names() if n != used]
            finally:
                book.release_resources()
    except (zipfile.BadZipFile, ValueError, InvalidFileException, XLRDError):
        pass
    return []


def widest_line(path: Path, sep: str) -> int:
    """The most fields any line of a text list has, counted by polars over the whole file without parsing it. Quoted text is taken out of
    each line first; a quoted value that runs over several lines can still make the answer too big, and the extra columns, which are empty,
    are dropped after loading. Too small is the loss to avoid: a wide row far down the file would lose its extra cells."""
    counts = pl.scan_csv(path, has_header=False, separator="\x1f", quote_char=None, infer_schema=False, truncate_ragged_lines=True,
                         encoding="utf8-lossy").select(
        pl.col("column_1").str.replace_all('"[^"]*"', "").str.count_matches(sep, literal=True).max())
    return int(counts.collect(engine="streaming").item() or 0) + 1


def _csv_batches(path: Path, has_header: bool, skip_rows: int):
    sep = delimiter(path)
    # polars takes the column count from the first line it reads, so a title line above the header, or a data row wider than the
    # header, would lose cells. Look at the top of the file here and give it the skip and the width.
    try:
        with open(path, "r", encoding="utf-8", errors="replace", newline="") as f:
            top = list(itertools.islice(csv.reader(f, delimiter=sep), 230))
    except csv.Error:  # a cell over the csv module's size limit: read the file as it comes
        top = []
    junk = leading_junk(top) if has_header else 0
    width = max(max((len(r) for r in top[junk:]), default=1), widest_line(path, sep)) or 1
    # Read without a header row and take the first line as the header here, so the names are made unique the same way for every format.
    lazy = pl.scan_csv(path, separator=sep, has_header=False, schema={f"c{i}": pl.String for i in range(width)}, skip_rows=junk,
                       encoding="utf8-lossy", truncate_ragged_lines=True, quote_char='"')
    headers: list[str] | None = None
    skipped = 0
    for frame in lazy.collect_batches(chunk_size=BATCH_ROWS):
        frame = frame.with_columns(pl.all().fill_null(""))
        if headers is None:
            headers = clean_headers(list(frame.row(0))) if has_header else [f"Column {i + 1}" for i in range(frame.width)]
            if has_header:
                frame = frame.slice(1)
        frame = frame.rename(dict(zip(frame.columns, headers)))
        if skipped < skip_rows:
            drop = min(skip_rows - skipped, frame.height)
            skipped += drop
            frame = frame.slice(drop)
        if frame.height:
            yield headers, frame
