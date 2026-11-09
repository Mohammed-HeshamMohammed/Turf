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
import readymode  # noqa: E402

CSV = """Owner Name,Cell,Email,Address,City,State,Zip,Bathroom style
Pat Owner,(512) 555-0100,pat@example.com,1 Main St,Austin,tx,78701,modern
Pat Owner,(512) 555-0100,pat@example.com,1 Main St,Austin,tx,78701,modern
Pat Owner,512.555.0100,,,,,,
Sam Seller,5125550101,SAM@Example.com,2 Oak Ave,Austin,TX,78702,rustic
,,,,,,,
Lee Existing,+1 512 555 0199,,,,,,
"""


class MatchingTest(unittest.TestCase):
    def test_example_export_titles_are_classified_without_guessing_lead_fields(self) -> None:
        exports = [
            ["Phone", "Alt. Phone", "First Name", "Last Name", "Address", "City", "State", "Country", "Zip", "Email",
             "Batch Name", "Original File Name", "Upload Date", "Status", "Original Status", "Status (time)",
             "Status (agent)", "Lead File Campaign"],
            ["Id", "Address", "City", "State", "Zip", "County", "Living Square Feet", "Year Built", "Lot (Acres)",
             "Lot (Square Feet)", "Land Use", "Property Type", "Property Use", "Subdivision", "APN", "Legal Description",
             "Units Count", "Bedrooms", "Bathrooms", "# of Stories", "Garage Type", "Garage Square Feet", "Carport",
             "Carport Area", "Air Conditioning Type", "Heating Type", "# of Fireplaces", "Owner 1 First Name",
             "Owner 1 Last Name", "Owner 2 First Name", "Owner 2 Last Name", "Owner 3 First Name", "Owner 3 Last Name",
             "Owner 4 First Name", "Owner 4 Last Name", "Owner Mailing Address", "Owner Mailing City", "Owner Mailing State",
             "Owner Mailing Zip", "Ownership Length (Months)", "Owner Type", "Owner Occupied", "Vacant?"],
            ["Address", "City", "", "State", "Zip", "", "", "First Name", "Last Name"],
        ]
        for headers in exports:
            with self.subTest(columns=len(headers)):
                suggested = matching.suggest_all(headers)
                unknown = [header for header, field in zip(headers, suggested)
                           if header and not field and not matching.source_detail(header)]
                self.assertEqual(unknown, [])
        self.assertEqual(matching.suggest("Alt. Phone"), "phone")
        self.assertIsNone(matching.suggest("Owner 2 First Name"))
        self.assertEqual(matching.source_detail("Owner 2 First Name"), "Owner 2 first name")
        self.assertIsNone(matching.suggest("Owner Mailing Address"))
        self.assertEqual(matching.source_detail("Owner Mailing Address"), "Owner mailing address")

    def test_shared_address_or_phone_with_different_names_is_not_a_repeat(self) -> None:
        import worker

        grouped = worker.group_source_candidates([
            (1, "Mary Randel", None, None, "3307lilyst|77505"),
            (2, "Maricela Moreno", None, None, "3307lilyst|77505"),
            (3, "Irfana Hussain", "5550100", None, "2118hadley|77003"),
            (4, "Charanjit Narula", "5550100", None, "2118hadley|77003"),
            (5, "Mary Randel", None, None, "3307lilyst|77505"),
        ])
        self.assertNotEqual(grouped.find(("r", 1)), grouped.find(("r", 2)))
        self.assertNotEqual(grouped.find(("r", 3)), grouped.find(("r", 4)))
        self.assertEqual(grouped.find(("r", 1)), grouped.find(("r", 5)))

    def test_readymode_export_keeps_local_time_and_ignores_zero_phones(self) -> None:
        from zoneinfo import ZoneInfo
        headers = ["a", "Log Time", "Scheduled time", "Phone", "Ph#2", "Log Type", "First Name", "Last Name"]
        columns = readymode.columns(headers)
        event = readymode.event(["12345", "10/15/2026 20:47", "Not scheduled", "0", "(512) 555-0100",
                                 "Spanish Speaker", "Pat", "Owner"], columns, ZoneInfo("America/Chicago"))
        self.assertEqual(event["phone"], "5125550100")
        self.assertEqual(event["scheduled_at"], None)
        self.assertEqual(event["occurred_at"], "2026-10-16T01:47:00+00:00")
        self.assertEqual((event["outcome"], event["raw_outcome"]), ("Language barrier", "Spanish Speaker"))

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

    def test_only_columns_blank_across_every_row_are_removed(self) -> None:
        job_id = self.queue(b"Name,Blank,Phone,Sparse\nA,  ,5551111,\nB,,5552222,kept\n")
        self.worker.load(self.conn, self.worker.claim(self.conn))
        job = self.job(job_id)
        self.assertEqual([column["header"] for column in job["columns"]], ["Name", "Phone", "Sparse"])
        self.assertEqual([column["idx"] for column in job["columns"]], [0, 1, 2])
        self.assertEqual(job["report"]["empty_columns_removed"], ["Blank"])
        with self.conn.cursor() as cur:
            cur.execute("SELECT cells FROM importing.rows WHERE job_id = %s ORDER BY row_no", (job_id,))
            self.assertEqual([row[0] for row in cur.fetchall()], [["A", "5551111", ""], ["B", "5552222", "kept"]])
        self.conn.commit()

    def test_readymode_calls_are_staged_before_any_lead_changes(self) -> None:
        data = ("a,Agent name,Log Time,Scheduled time,Phone,Log Type,Call Notes,First Name,Last Name,Address,Ph#2,Ph#6\n"
                "12345,Old agent,10/15/2026 20:47,Not scheduled,5125550100,Voicemail,Left message,Pat,Owner,1 Main St,0,0\n"
                "12346,Old agent,10/15/2026 21:00,Not scheduled,0,Wrong Number,,Pat,Owner,1 Main St,0,0\n").encode()
        job_id = self.queue(data, "calls.csv")
        self.conn.execute("UPDATE importing.jobs SET kind = 'readymode_calls', source_timezone = 'America/Chicago' WHERE id = %s", (job_id,))
        self.conn.commit()
        self.worker.load_calls(self.conn, self.worker.claim(self.conn))
        job = self.job(job_id)
        self.assertEqual(job["status"], "call_ready")
        self.assertEqual((job["report"]["valid_calls"], job["report"]["unusable_calls"]), (1, 1))
        self.assertIn("Ph#6", job["report"]["empty_columns_removed"])
        with self.conn.cursor() as cur:
            cur.execute("SELECT state, call_data, lead_id FROM importing.rows WHERE job_id = %s ORDER BY row_no", (job_id,))
            rows = cur.fetchall()
            cur.execute("SELECT count(*) FROM crm.call_events")
            calls = cur.fetchone()[0]
        self.conn.commit()
        self.assertEqual([row[0] for row in rows], ["loaded", "skip"])
        self.assertEqual(rows[0][1]["notes"], "Left message")
        self.assertTrue(all(row[2] is None for row in rows))
        self.assertEqual(calls, 0)

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
        # Pat Owner's two distinct source rows share a phone. Lee matches a lead already in the CRM.
        self.assertEqual((by_no[1][7], by_no[3][7], by_no[1][8] == by_no[3][8]), ("near_duplicate", "near_duplicate", True))
        self.assertEqual((by_no[6][7], by_no[6][9]), ("near_duplicate", True))
        self.assertEqual(by_no[4][7], "clean")
        job = self.job(job_id)
        self.assertEqual((job["status"], job["report"]["near_groups"], job["report"]["dropped_columns"]), ("reviewing", 2, ["Bathroom style"]))

        # The queue moves on to the next import.
        self.assertEqual(self.worker.claim(self.conn)["id"], second)

    def test_exact_prior_rows_are_linked_without_review_but_changed_rows_still_need_a_choice(self) -> None:
        original = b"Name,Phone,Address\nPat Owner,5125550100,1 Main St\n"
        prior = self.queue(original)
        self.worker.load(self.conn, self.worker.claim(self.conn))
        with self.conn.cursor() as cur:
            cur.execute("""INSERT INTO crm.leads (org_id, name, phone)
                           VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Pat Owner', '5125550100') RETURNING id""")
            lead_id = cur.fetchone()[0]
            cur.execute("UPDATE importing.rows SET state = 'merged', lead_id = %s WHERE job_id = %s", (lead_id, prior))
            cur.execute("UPDATE importing.jobs SET status = 'done' WHERE id = %s", (prior,))
        self.conn.commit()

        current = self.queue(original + b"Pat Owner,5125550100,2 Main St\n")
        self.worker.load(self.conn, self.worker.claim(self.conn))
        columns = self.job(current)["columns"]
        for column in columns:
            column["field"], column["used"] = column["suggested"], column["suggested"] is not None
        with self.conn.cursor() as cur:
            cur.execute("UPDATE importing.jobs SET columns = %s::jsonb, status = 'cleaning' WHERE id = %s",
                        (json.dumps(columns), current))
        self.conn.commit()
        self.worker.clean(self.conn, self.worker.claim(self.conn))

        with self.conn.cursor() as cur:
            cur.execute("SELECT state, lead_id FROM importing.rows WHERE job_id = %s ORDER BY row_no", (current,))
            rows = cur.fetchall()
        self.conn.commit()
        self.assertEqual(rows[0], ("skip", lead_id))
        self.assertEqual(rows[1][0], "near_duplicate")
        job = self.job(current)
        self.assertEqual((job["status"], job["report"]["exact_existing"], job["report"]["near_groups"]),
                         ("reviewing", 1, 1))
        self.assertEqual(job["report"]["unusable_rows"], 0)

        only_exact = self.queue(original)
        self.worker.load(self.conn, self.worker.claim(self.conn))
        columns = self.job(only_exact)["columns"]
        for column in columns:
            column["field"], column["used"] = column["suggested"], column["suggested"] is not None
        with self.conn.cursor() as cur:
            cur.execute("UPDATE importing.jobs SET columns = %s::jsonb, status = 'cleaning' WHERE id = %s",
                        (json.dumps(columns), only_exact))
        self.conn.commit()
        self.worker.clean(self.conn, self.worker.claim(self.conn))
        job = self.job(only_exact)
        self.assertEqual((job["status"], job["report"]["exact_existing"], job["report"]["near_groups"]),
                         ("done", 1, 0))

        another_person = self.queue(original)
        with self.conn.cursor() as cur:
            cur.execute("UPDATE importing.jobs SET user_id = '22222222-2222-4222-8222-222222222222' WHERE id = %s",
                        (another_person,))
        self.conn.commit()
        self.worker.load(self.conn, self.worker.claim(self.conn))
        columns = self.job(another_person)["columns"]
        for column in columns:
            column["field"], column["used"] = column["suggested"], column["suggested"] is not None
        with self.conn.cursor() as cur:
            cur.execute("UPDATE importing.jobs SET columns = %s::jsonb, status = 'cleaning' WHERE id = %s",
                        (json.dumps(columns), another_person))
        self.conn.commit()
        self.worker.clean(self.conn, self.worker.claim(self.conn))
        self.assertEqual(self.job(another_person)["report"]["exact_existing"], 0)

    def test_shared_household_with_different_names_needs_no_repeat_review(self) -> None:
        with self.conn.cursor() as cur:
            cur.execute("""INSERT INTO crm.properties (org_id, address, city, postal_code)
                           VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '3307 Lily St', 'Pasadena', '77505')
                           RETURNING id""")
            property_id = cur.fetchone()[0]
            cur.execute("""INSERT INTO crm.leads (org_id, name, property_id)
                           VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'John Tenant', %s)""", (property_id,))
        self.conn.commit()
        job_id = self.queue(b"Name,Address,City,Zip\nMary Randel,3307 Lily St,Pasadena,77505\nMaricela Moreno,3307 Lily St,Pasadena,77505\n")
        self.worker.load(self.conn, self.worker.claim(self.conn))
        columns = self.job(job_id)["columns"]
        for column in columns:
            column["field"], column["used"] = column["suggested"], column["suggested"] is not None
        with self.conn.cursor() as cur:
            cur.execute("UPDATE importing.jobs SET columns = %s::jsonb, status = 'cleaning' WHERE id = %s", (json.dumps(columns), job_id))
        self.conn.commit()
        self.worker.clean(self.conn, self.worker.claim(self.conn))
        job = self.job(job_id)
        self.assertEqual((job["status"], job["report"]["near_groups"]), ("ready", 0))
        with self.conn.cursor() as cur:
            cur.execute("SELECT name, state FROM importing.rows WHERE job_id = %s ORDER BY row_no", (job_id,))
            self.assertEqual(cur.fetchall(), [("Mary Randel", "clean"), ("Maricela Moreno", "clean")])
        self.conn.commit()

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
