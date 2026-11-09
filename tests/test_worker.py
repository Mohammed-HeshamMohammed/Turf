"""The import worker. The reading and column-matching tests need only the libraries; the end-to-end test needs a disposable PostgreSQL
(CRM_TEST_ADMIN_URL, a superuser) and builds crm-core's tables from its numbered scripts, so it is skipped without one."""
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(HERE))

import polars as pl  # noqa: E402

import matching  # noqa: E402
import readers  # noqa: E402

CSV = """Owner Name,Cell,Email,Address,City,State,Zip,Bathroom style
Pat Owner,(512) 555-0100,pat@example.com,1 Main St,Austin,tx,78701,modern
Pat Owner,(512) 555-0100,pat@example.com,1 Main St,Austin,tx,78701,modern
Pat O.,512.555.0100,,,,,,
Sam Seller,5125550101,SAM@Example.com,2 Oak Ave,Austin,TX,78702,rustic
,,,,,,,
Lee Existing,+1 512 555 0199,,,,,,
"""


class MatchingTest(unittest.TestCase):
    def test_headers_are_read_however_they_are_written(self) -> None:
        for header, field in [("Owner Name", "name"), ("OWNER_NAME", "name"), ("ownerName", "name"), ("Cell Phone", "phone"), ("Phone 3", "phone"),
                              ("ZIP Code", "zip"), ("Bathroom style", None), ("Relative 6", None), ("Mailing Address", None), ("State", "region")]:
            self.assertEqual(matching.suggest(header), field, header)

    def test_a_field_that_cannot_repeat_goes_to_its_first_column_only(self) -> None:
        self.assertEqual(matching.suggest_all(["Name", "Owner", "Phone", "Phone 2"]), ["name", None, "phone", "phone"])


class ReadersTest(unittest.TestCase):
    def test_pieces_join_in_order_and_a_restart_carries_on(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp)
            data = CSV.encode()
            pieces = [data[:40], data[40:90], data[90:]]
            for n, piece in enumerate(pieces):
                (folder / f"{n}.part").write_bytes(piece)
            sizes = [len(p) for p in pieces]
            # A first run stopped after two pieces, leaving a half-written third on the end of the joined file.
            (folder / "assembled.part").write_bytes(data[:90] + b"garbage")
            (folder / "assembled.progress").write_text("2")
            (folder / "0.part").unlink()
            (folder / "1.part").unlink()
            joined = readers.assemble(folder, sizes, ".csv")
            self.assertEqual(joined.read_bytes(), data)
            self.assertEqual(list(folder.glob("*.part")), [])

    def test_csv_batches_are_text_with_the_headers_made_unique(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "list.csv"
            path.write_text("Name,Phone,,Phone\nA,5551234,x,1\nB,,,\n")
            (headers, frame), = list(readers.read_batches(path, True))
            self.assertEqual(headers, ["Name", "Phone", "Column 3", "Phone (2)"])
            self.assertEqual(frame.rows(), [("A", "5551234", "x", "1"), ("B", "", "", "")])
            (_, rest), = list(readers.read_batches(path, True, skip_rows=1))
            self.assertEqual(rest.rows()[0][0], "B")

    def test_large_csv_is_read_in_resumable_database_sized_batches(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "list.csv"
            path.write_text("Address,City,,State,Zip,,,First Name,Last Name\n" +
                            "1 Main St,Austin,,TX,78701,,,A,B\n" * 12_005)
            batches = list(readers.read_batches(path, True))
            self.assertEqual(sum(frame.height for _, frame in batches), 12_005)
            self.assertGreater(len(batches), 1)
            self.assertLessEqual(max(frame.height for _, frame in batches), readers.BATCH_ROWS)
            self.assertEqual(batches[0][0][2], "Column 3")
            resumed = list(readers.read_batches(path, True, skip_rows=10_000))
            self.assertEqual(sum(frame.height for _, frame in resumed), 2_005)

    def test_invalid_spreadsheet_is_reported_as_a_file_problem(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "broken.xlsx"
            path.write_bytes(b"not an Excel workbook")
            with self.assertRaises(readers.UnreadableFile):
                list(readers.read_batches(path, True))

    def test_a_semicolon_list_in_windows_1252_is_read(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "source.csv"
            path.write_bytes("Name;Phone\nJosé Müller;5551234\n".encode("cp1252"))
            utf8 = readers.to_utf8(path)
            (_, frame), = list(readers.read_batches(utf8, True))
            self.assertEqual(frame.rows(), [("José Müller", "5551234")])

    def test_a_spreadsheet_that_unpacks_into_something_absurd_is_refused_before_it_is_opened(self) -> None:
        import zipfile

        with tempfile.TemporaryDirectory() as tmp:
            bomb = Path(tmp) / "bomb.xlsx"
            with zipfile.ZipFile(bomb, "w", zipfile.ZIP_DEFLATED) as archive:
                archive.writestr("xl/worksheets/sheet1.xml", b"0" * (60 << 20))  # 60 MB that squashes to a few KB
            with self.assertRaises(readers.UnsafeFile):
                list(readers.read_batches(bomb, True))
            big = Path(tmp) / "big.xlsx"
            with zipfile.ZipFile(big, "w", zipfile.ZIP_STORED) as archive:
                archive.writestr("xl/a.xml", b"x" * 2048)
            old, readers.MAX_UNPACKED = readers.MAX_UNPACKED, 1024
            try:
                with self.assertRaises(readers.UnsafeFile):
                    readers.check_unpacked(big)
            finally:
                readers.MAX_UNPACKED = old

    def test_a_spreadsheet_with_an_xml_entity_trick_inside_is_refused(self) -> None:
        import zipfile

        from openpyxl import Workbook

        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
            honest, tricky = Path(tmp) / "honest.xlsx", Path(tmp) / "tricky.xlsx"
            book = Workbook()
            book.active.append(["Name", "Phone"])
            book.active.append(["A", "5551234"])
            book.save(honest)
            with zipfile.ZipFile(honest) as src, zipfile.ZipFile(tricky, "w", zipfile.ZIP_DEFLATED) as out:
                for part in src.infolist():
                    data = src.read(part.filename)
                    if part.filename == "xl/worksheets/sheet1.xml":
                        marker = data.index(b"<worksheet")
                        data = data[:marker] + b'<!DOCTYPE x [<!ENTITY a "aaaaaaaaaa"><!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;">]>' + data[marker:]
                    out.writestr(part.filename, data)
            self.assertEqual(len(list(readers.read_batches(honest, True))), 1)
            with self.assertRaises(ValueError):  # openpyxl reports the refused XML as an unreadable workbook
                list(readers.read_batches(tricky, True))

    def test_spreadsheet_numbers_do_not_grow_a_point_zero(self) -> None:
        from openpyxl import Workbook

        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "list.xlsx"
            book = Workbook()
            book.active.append(["Name", "Phone", "Value"])
            book.active.append(["A", 5125550100, 250000.5])
            book.active.append(["B", None, None])
            book.save(path)
            (headers, frame), = list(readers.read_batches(path, True))
            self.assertEqual(headers, ["Name", "Phone", "Value"])
            self.assertEqual(frame.rows(), [("A", "5125550100", "250000.5"), ("B", "", "")])


@unittest.skipUnless(os.environ.get("CRM_TEST_ADMIN_URL"), "set CRM_TEST_ADMIN_URL to run the database test")
class EndToEndTest(unittest.TestCase):
    def setUp(self) -> None:
        import psycopg

        import worker

        self.worker = worker
        self.tmp = tempfile.TemporaryDirectory()
        worker.IMPORT_DIR = Path(self.tmp.name)
        self.conn = psycopg.connect(os.environ["CRM_TEST_ADMIN_URL"])
        self.addCleanup(self.conn.close)
        self.addCleanup(self.tmp.cleanup)
        with self.conn.cursor() as cur:
            cur.execute("DROP SCHEMA IF EXISTS crm CASCADE; DROP SCHEMA IF EXISTS importing CASCADE; CREATE SCHEMA crm; SET search_path = crm, public")
            for script in sorted((HERE.parent.parent / "crm-core" / "migrations").glob("*.sql")):
                cur.execute(script.read_text(encoding="utf8"))
            cur.execute("INSERT INTO crm.orgs (id, name) VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Test')")
            cur.execute("INSERT INTO crm.leads (org_id, name, phone) VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Lee Existing', '(512) 555-0199')")
        self.conn.commit()
        self.conn.execute("SET search_path = importing, public")

    def queue(self, content: bytes, filename: str = "owners.csv") -> str:
        pieces = [content[i:i + 70] for i in range(0, len(content), 70)]
        with self.conn.cursor() as cur:
            cur.execute("""INSERT INTO importing.jobs (org_id, user_id, name, filename, size, chunk_size, total_chunks, status)
                           VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '11111111-1111-4111-8111-111111111111', 'Austin', %s, %s, 70, %s, 'queued')
                           RETURNING id::text""", (filename, len(content), len(pieces)))
            job_id = cur.fetchone()[0]
            (self.worker.IMPORT_DIR / job_id).mkdir()
            for n, piece in enumerate(pieces):
                (self.worker.IMPORT_DIR / job_id / f"{n}.part").write_bytes(piece)
                cur.execute("INSERT INTO importing.chunks (job_id, n, size, sha256) VALUES (%s, %s, %s, 'x')", (job_id, n, len(piece)))
        self.conn.commit()
        return job_id

    def job(self, job_id: str) -> dict:
        with self.conn.cursor(row_factory=__import__("psycopg").rows.dict_row) as cur:
            cur.execute("SELECT * FROM importing.jobs WHERE id = %s", (job_id,))
            row = cur.fetchone()
        self.conn.commit()
        return row

    def test_an_upload_is_loaded_confirmed_cleaned_and_its_repeats_found(self) -> None:
        job_id = self.queue(CSV.encode())
        claimed = self.worker.claim(self.conn)
        self.assertEqual(claimed["id"], job_id)
        # Only one import works at a time: a second waits.
        second = self.queue(b"Name,Phone\nX,5550000\n")
        self.assertIsNone(self.worker.claim(self.conn))
        self.worker.load(self.conn, claimed)

        job = self.job(job_id)
        self.assertEqual(job["status"], "mapping")
        self.assertEqual(job["report"]["exact_duplicates"], 1)
        self.assertEqual(job["report"]["empty_rows"], 1)
        self.assertEqual(job["report"]["exact_examples"], [{"row": 2, "same_as": 1}])
        self.assertEqual(job["report"]["rows"], 4)
        columns = job["columns"]
        self.assertEqual([c["suggested"] for c in columns], ["name", "phone", "email", "address", "city", "region", "zip", None])
        self.assertEqual(columns[1]["populated"], 4)
        self.assertEqual(list(self.worker.IMPORT_DIR.joinpath(job_id).glob("*")), [])

        # The person keeps what the CRM uses and sets "Bathroom style" aside; crm-core then moves the job on.
        for c in columns:
            c["field"], c["used"] = c["suggested"], c["suggested"] is not None
        with self.conn.cursor() as cur:
            cur.execute("UPDATE importing.jobs SET columns = %s::jsonb, status = 'cleaning', heartbeat_at = NULL WHERE id = %s", (json.dumps(columns), job_id))
        self.conn.commit()
        claimed = self.worker.claim(self.conn)
        self.assertEqual((claimed["id"], claimed["status"]), (job_id, "cleaning"))
        self.worker.clean(self.conn, claimed)

        with self.conn.cursor() as cur:
            cur.execute("SELECT row_no, name, phone, email, address, region, zip, state, group_id, match_lead IS NOT NULL FROM importing.rows WHERE job_id = %s ORDER BY row_no", (job_id,))
            rows = cur.fetchall()
        self.conn.commit()
        by_no = {r[0]: r for r in rows}
        self.assertEqual(by_no[1][1:7], ("Pat Owner", "5125550100", "pat@example.com", "1 Main St", "TX", "78701"))
        self.assertEqual(by_no[4][3], "sam@example.com")  # lower-cased
        # Pat O. shares Pat Owner's phone: one group of two. Lee matches the lead already in the CRM.
        self.assertEqual((by_no[1][7], by_no[3][7], by_no[1][8] == by_no[3][8]), ("near_duplicate", "near_duplicate", True))
        self.assertEqual((by_no[6][7], by_no[6][9]), ("near_duplicate", True))
        self.assertEqual(by_no[4][7], "clean")
        job = self.job(job_id)
        self.assertEqual((job["status"], job["report"]["near_groups"], job["report"]["dropped_columns"]), ("reviewing", 2, ["Bathroom style"]))

        # The queue moves on to the next import.
        self.assertEqual(self.worker.claim(self.conn)["id"], second)

    def test_a_cancelled_import_leaves_no_rows(self) -> None:
        job_id = self.queue(CSV.encode())
        claimed = self.worker.claim(self.conn)
        with self.conn.cursor() as cur:
            cur.execute("UPDATE importing.jobs SET cancel_requested = true, status = 'cancelled' WHERE id = %s", (job_id,))
        self.conn.commit()
        self.worker.process(self.conn, claimed)
        with self.conn.cursor() as cur:
            cur.execute("SELECT count(*) FROM importing.rows WHERE job_id = %s", (job_id,))
            self.assertEqual(cur.fetchone()[0], 0)
        self.conn.commit()


if __name__ == "__main__":
    unittest.main()
