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
                keys = [matching.standard_key(header) for header in headers if header]
                self.assertTrue(all(keys))
                self.assertEqual(len(keys), len(set(keys)))
        self.assertEqual(matching.suggest("Alt. Phone"), "phone")
        self.assertIsNone(matching.suggest("Owner 2 First Name"))
        self.assertEqual(matching.source_detail("Owner 2 First Name"), "Owner 2 first name")
        self.assertIsNone(matching.suggest("Owner Mailing Address"))
        self.assertEqual(matching.source_detail("Owner Mailing Address"), "Owner mailing address")
        self.assertEqual(matching.standard_key("OWNER_2_FIRST_NAME"), "owner_2_first_name")
        self.assertEqual(matching.standard_key("Status (time)"), "status_time")
        self.assertEqual(matching.standard_key("Alt. Phone"), "alternate_phone")
        self.assertEqual(matching.standard_key("Living Square Feet"), "living_area")
        self.assertEqual(matching.standard_keys(["Phone", "Phone Number", "Phone 2"]), ["phone", "phone_2", "phone_2_2"])
        self.assertEqual(matching.standard_key("Living Sq Ft"), "living_area")

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

    def test_a_column_with_no_telling_heading_is_suggested_from_what_its_cells_look_like(self) -> None:
        phones = ["(512) 555-0100", "512.555.0101", "+1 512 555 0102", "5125550103", "512-555-0104"]
        self.assertEqual(matching.suggest_from_values(phones), "phone")
        self.assertEqual(matching.suggest_from_values(["a@x.com"] * 5), "email")
        self.assertEqual(matching.suggest_from_values(["TX", "tx", "CA", "NY", "FL"]), "region")
        self.assertEqual(matching.suggest_from_values(["78701", "78702", "78701-1234", "10001", "90210"]), "zip")
        self.assertIsNone(matching.suggest_from_values(["happy", "sad", "ok", "fine", "good"]))
        self.assertIsNone(matching.suggest_from_values(phones[:3]))  # too few to be sure
        self.assertIsNone(matching.suggest_from_values(phones[:4] + ["not a phone", "also not"]))

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


    def test_a_title_line_above_the_header_and_a_wider_data_row_lose_nothing_in_a_csv(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "list.csv"
            path.write_text("Leads export\n\nName,Phone,Email\nA,1,a@x.com,extra\n")
            (headers, frame), = list(readers.read_batches(path, True))
            self.assertEqual(headers, ["Name", "Phone", "Email", "Column 4"])
            self.assertEqual(frame.rows(), [("A", "1", "a@x.com", "extra")])
            (_, rest), = list(readers.read_batches(path, True, skip_rows=0))
            self.assertEqual(rest.height, 1)

    def test_a_row_far_down_a_csv_wider_than_the_top_keeps_its_extra_cells(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "list.csv"
            path.write_text("Name,Phone"+"\n"+"A,1"+"\n"+"B,2"+"\n"*1 + ("C,3"+"\n") * 5000 + "D,4,x@y.com,extra"+"\n"+'"Smith, John",5,,'+"\n")
            frames = list(readers.read_batches(path, True))
            headers = frames[0][0]
            rows = [row for _, frame in frames for row in frame.rows()]
            self.assertEqual(headers, ["Name", "Phone", "Column 3", "Column 4"])
            self.assertIn(("D", "4", "x@y.com", "extra"), rows)
            self.assertIn(("Smith, John", "5", "", ""), rows)

    def test_a_spreadsheet_that_does_not_say_how_big_it_is_is_measured_by_reading_it(self) -> None:
        import re
        import zipfile

        from openpyxl import Workbook

        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
            plain, bare = Path(tmp) / "plain.xlsx", Path(tmp) / "bare.xlsx"
            book = Workbook()
            book.active.append(["Name", "Phone"])
            book.active.append(["A", "5551234"])
            book.active["E5"] = "far"
            book.save(plain)
            with zipfile.ZipFile(plain) as src, zipfile.ZipFile(bare, "w", zipfile.ZIP_DEFLATED) as out:
                for part in src.infolist():
                    data = src.read(part.filename)
                    if part.filename == "xl/worksheets/sheet1.xml":
                        data = re.sub(rb"<dimension[^>]*/>", b"", data)
                    out.writestr(part.filename, data)
            (headers, _), = list(readers.read_batches(bare, True))
            self.assertEqual(len(headers), 5)

    def test_a_one_column_list_keeps_its_first_line_as_the_header(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "list.csv"
            path.write_text("Phone\n5551234\n")
            (headers, frame), = list(readers.read_batches(path, True))
            self.assertEqual((headers, frame.rows()), (["Phone"], [("5551234",)]))

    def test_a_workbook_opens_on_its_first_sheet_with_data_and_names_the_others(self) -> None:
        from openpyxl import Workbook

        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
            path = Path(tmp) / "list.xlsx"
            book = Workbook()
            book.active.title = "Cover"
            data = book.create_sheet("Leads")
            data.append(["Leads export"])
            data.append(["Name", "Phone"])
            data.append(["A", "5551234"])
            data["E5"] = "far"  # a cell past the first rows, outside the first 200 only by being declared in the sheet's width
            book.save(path)
            (headers, frame), = list(readers.read_batches(path, True))
            self.assertEqual(headers[:2], ["Name", "Phone"])
            self.assertEqual(len(headers), 5)
            self.assertEqual(frame.rows()[0][:2], ("A", "5551234"))
            self.assertEqual(readers.other_sheets(path), ["Cover"])

    def test_a_text_list_whose_bad_byte_comes_after_the_first_sample_is_still_windows_1252(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "source.csv"
            path.write_bytes(b"Name,Phone\n" + b"Ann,5551234\n" * 30_000 + "José,5550000\n".encode("cp1252"))
            (_, frame), = list(readers.read_batches(readers.to_utf8(path), True, skip_rows=30_000))
            self.assertEqual(frame.rows(), [("José", "5550000")])


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

    def test_columns_are_suggested_from_what_the_workspace_decided_before_then_the_heading_then_the_cells(self) -> None:
        self.conn.execute("""INSERT INTO importing.mapping_memory (org_id, header_key, field, used) VALUES
            ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'mood', 'source', true), ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'owner name', NULL, false)""")
        self.conn.commit()
        job_id = self.queue('Owner Name,Contact 1,Mood,Zip Code,Misc\nPerson 0,(512) 555-0100,happy,78700,x0\nPerson 1,(512) 555-0101,happy,78701,x1\nPerson 2,(512) 555-0102,happy,78702,x2\nPerson 3,(512) 555-0103,happy,78703,x3\nPerson 4,(512) 555-0104,happy,78704,x4\nPerson 5,(512) 555-0105,happy,78705,x5\n'.encode())
        self.worker.load(self.conn, self.worker.claim(self.conn))
        columns = {c["header"]: c for c in self.job(job_id)["columns"]}
        self.assertEqual({h: c["suggested"] for h, c in columns.items()},
                         {"Owner Name": None, "Contact 1": "phone", "Mood": "source", "Zip Code": "zip", "Misc": None})
        self.assertEqual((columns["Owner Name"]["remembered"], columns["Mood"]["remembered"], columns["Contact 1"]["remembered"]), ("unused", "used", None))
        self.assertEqual(columns["Mood"]["key"], "mood")

    def test_a_call_dated_in_the_future_shows_in_the_report_so_a_wrong_time_zone_is_noticed(self) -> None:
        header = "a,Agent name,Log Time,Scheduled time,Phone,Log Type,Call Notes,First Name,Last Name,Address\n"
        job_id = self.queue((header + "1,A,10/15/2099 20:47:30,Not scheduled,5125550100,Voicemail,,Pat,Owner,1 Main St\n").encode(), "calls.csv")
        self.conn.execute("UPDATE importing.jobs SET kind = 'readymode_calls', source_timezone = 'UTC' WHERE id = %s", (job_id,))
        self.conn.commit()
        self.worker.load_calls(self.conn, self.worker.claim(self.conn))
        report = self.job(job_id)["report"]
        self.assertEqual((report["future_calls"], report["last_call"]), (1, "2099-10-15T20:47:30+00:00"))

    def test_made_up_phones_are_left_out_names_are_set_right_and_the_report_counts_what_was_cleared(self) -> None:
        job_id = self.queue('Owner Name,Phone,Email\n"SMITH, JOHN",5125550100,john@example.com\nJANE DOE,5555555555,not an email\nAnna McDonald,1234567890,\nACME PROPERTIES LLC,(512) 555-0111,\n"Smith, Jr",5125550122,\nBob,abc,\n'.encode())
        self.worker.load(self.conn, self.worker.claim(self.conn))
        columns = self.job(job_id)["columns"]
        for c in columns:
            c["field"], c["used"] = c["suggested"], True
        self.conn.execute("UPDATE importing.jobs SET columns = %s::jsonb, status = 'cleaning', heartbeat_at = NULL WHERE id = %s", (json.dumps(columns), job_id))
        self.conn.commit()
        self.worker.clean(self.conn, self.worker.claim(self.conn))
        with self.conn.cursor() as cur:
            cur.execute("SELECT name, phone, email FROM importing.rows WHERE job_id = %s ORDER BY row_no", (job_id,))
            rows = cur.fetchall()
        self.conn.commit()
        self.assertEqual(rows, [("John Smith", "5125550100", "john@example.com"), ("Jane Doe", None, None), ("Anna McDonald", None, None),
                                ("ACME PROPERTIES LLC", "5125550111", None), ("Smith, Jr", "5125550122", None), ("Bob", None, None)])
        self.assertEqual(self.job(job_id)["report"]["cleared_cells"], {"phone": 1, "phone_made_up": 2, "email": 1})

    def clean_phone_list(self, content: bytes) -> tuple[str, dict]:
        job_id = self.queue(content)
        self.worker.load(self.conn, self.worker.claim(self.conn))
        columns = self.job(job_id)["columns"]
        for c in columns:
            c["field"], c["used"] = c["suggested"], True
        self.conn.execute("UPDATE importing.jobs SET columns = %s::jsonb, status = 'cleaning', heartbeat_at = NULL WHERE id = %s", (json.dumps(columns), job_id))
        self.conn.commit()
        self.worker.clean(self.conn, self.worker.claim(self.conn))
        return job_id, self.job(job_id)

    def test_phone_line_types_are_added_only_when_a_lookup_is_set_up_and_never_stop_the_import(self) -> None:
        import linetype

        data = b'Name,Phone\nAnn,5125550100\nBen,5125550111\n'
        job_id, job = self.clean_phone_list(data)  # no lookup set up: nothing happens
        self.assertNotIn("line_types", job["report"])
        self.assertEqual(job["status"], "ready")

        linetype.PROVIDERS["fake"] = lambda numbers: {n: "mobile" if n.endswith("0") else "landline" for n in numbers}
        self.addCleanup(linetype.PROVIDERS.clear)
        os.environ["LINE_TYPE_PROVIDER"] = "fake"
        self.addCleanup(os.environ.pop, "LINE_TYPE_PROVIDER", None)
        job_id, job = self.clean_phone_list(data)
        self.assertEqual(job["report"]["line_types"], {"mobile": 1, "landline": 1})
        with self.conn.cursor() as cur:
            cur.execute("SELECT phone, source_data->>'phone_line_type' FROM importing.rows WHERE job_id = %s ORDER BY row_no", (job_id,))
            self.assertEqual(cur.fetchall(), [("5125550100", "mobile"), ("5125550111", "landline")])
        self.conn.commit()

        def broken(numbers):
            raise RuntimeError("service down")
        linetype.PROVIDERS["fake"] = broken
        job_id, job = self.clean_phone_list(data)
        self.assertEqual((job["status"], job["report"]["line_types"]), ("ready", "unavailable"))

    def test_a_phone_alone_matching_a_lead_with_another_name_is_asked_about_never_merged(self) -> None:
        # "Lee Existing" is in the CRM with (512) 555-0199. Another name on the same phone may be someone else at a shared number.
        job_id, job = self.clean_phone_list(b'Name,Phone\nPat Other,5125550199\nSam New,5125550222\n')
        self.assertEqual((job["status"], job["report"]["near_groups"], job["report"]["certain_matches_merged"]), ("reviewing", 1, 0))
        with self.conn.cursor() as cur:
            cur.execute("SELECT name, state, match_lead IS NOT NULL FROM importing.rows WHERE job_id = %s ORDER BY row_no", (job_id,))
            self.assertEqual(cur.fetchall(), [("Pat Other", "near_duplicate", True), ("Sam New", "clean", False)])
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
        self.assertEqual((job["report"]["first_call"], job["report"]["future_calls"]), ("2026-10-16T01:47:00+00:00", 0))
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
        # Imports work at the same time: a second one is taken on by another worker, and a third finds nothing left.
        second = self.queue(b"Name,Phone\nX,5550000\n")
        other = self.worker.claim(self.conn, "another-worker")
        self.assertEqual(other["id"], second)
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
        self.assertEqual(columns[1]["standard_key"], "phone")
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
        with self.conn.cursor() as cur:
            cur.execute("SELECT source_data FROM importing.rows WHERE job_id = %s AND row_no = 1", (job_id,))
            self.assertEqual(cur.fetchone()[0]["name"], "Pat Owner")
        self.conn.commit()
        job = self.job(job_id)
        self.assertEqual((job["status"], job["report"]["near_groups"], job["report"]["dropped_columns"]), ("reviewing", 2, ["Bathroom style"]))

        # The second import was taken on by another worker while the first was running.
        self.assertEqual(self.job(second)["status"], "loading")

    def test_source_only_property_headers_gain_stable_keys_and_usable_property_details(self) -> None:
        data = (b"Owner 1 First Name,Owner 1 Last Name,Address,County,Living Square Feet,Bedrooms,Bathrooms,Year Built,Vacant?,Phone\n"
                b"Pat,Owner,1 Main St,Travis,1,234,3,2,1980,No,5125550100\n")
        # Quote the comma inside the area cell so it stays one original value.
        data = data.replace(b",1,234,3,", b',"1,234",3,')
        job_id = self.queue(data)
        self.worker.load(self.conn, self.worker.claim(self.conn))
        columns = self.job(job_id)["columns"]
        self.assertEqual([c["standard_key"] for c in columns],
                         ["owner_1_first_name", "owner_1_last_name", "address", "county", "living_area", "bedrooms", "bathrooms", "year_built", "vacancy", "phone"])
        self.assertEqual([c["suggested"] for c in columns],
                         ["first_name", "last_name", "address", "county", "living_area", "bedrooms", "bathrooms", "year_built", "vacancy", "phone"])
        for column in columns:
            column["field"], column["used"] = column["suggested"], column["suggested"] is not None
        with self.conn.cursor() as cur:
            cur.execute("UPDATE importing.jobs SET columns = %s::jsonb, status = 'cleaning' WHERE id = %s", (json.dumps(columns), job_id))
        self.conn.commit()
        self.worker.clean(self.conn, self.worker.claim(self.conn))
        with self.conn.cursor() as cur:
            cur.execute("SELECT source_data, importing.property_details(source_data) FROM importing.rows WHERE job_id = %s", (job_id,))
            source, details = cur.fetchone()
        self.conn.commit()
        self.assertEqual(source["living_area"], "1,234")
        self.assertEqual(source["owner_1_first_name"], "Pat")
        self.assertEqual(details["area"], 1234)
        self.assertEqual((details["beds"], details["baths"], details["county"], details["year_built"]), (3, 2, "Travis", "1980"))

    def test_manual_property_mapping_uses_confirmed_field_in_source_data(self) -> None:
        job_id = self.queue(b"First Name,Last Name,Address,Unfamiliar Area Title,Phone\nPat,Owner,1 Main St,1234,5125550100\n")
        self.worker.load(self.conn, self.worker.claim(self.conn))
        columns = self.job(job_id)["columns"]
        for column in columns:
            column["field"], column["used"] = column["suggested"], column["suggested"] is not None
        columns[3]["field"], columns[3]["used"] = "living_area", True
        self.conn.execute("UPDATE importing.jobs SET columns = %s::jsonb, status = 'cleaning' WHERE id = %s", (json.dumps(columns), job_id))
        self.conn.commit()
        self.worker.clean(self.conn, self.worker.claim(self.conn))
        with self.conn.cursor() as cur:
            cur.execute("SELECT cells[4], source_data, importing.property_details(source_data) FROM importing.rows WHERE job_id = %s", (job_id,))
            original, source, details = cur.fetchone()
        self.assertEqual(original, "1234")
        self.assertEqual(source["living_area"], "1234")
        self.assertEqual(details["area"], 1234)

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
        job_id = self.queue(b"Name,Address,City,Zip,Phone\nMary Randel,3307 Lily St,Pasadena,77505,5125550111\nMaricela Moreno,3307 Lily St,Pasadena,77505,5125550112\n")
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

    def _clean(self, data: bytes, skip_tracing: bool = False) -> tuple:
        job_id = self.queue(data)
        if skip_tracing:
            self.conn.execute("UPDATE importing.jobs SET for_skip_tracing = true WHERE id = %s", (job_id,))
            self.conn.commit()
        self.worker.load(self.conn, self.worker.claim(self.conn))
        columns = self.job(job_id)["columns"]
        for column in columns:
            column["field"], column["used"] = column["suggested"], column["suggested"] is not None
        with self.conn.cursor() as cur:
            cur.execute("UPDATE importing.jobs SET columns = %s::jsonb, status = 'cleaning' WHERE id = %s", (json.dumps(columns), job_id))
        self.conn.commit()
        self.worker.clean(self.conn, self.worker.claim(self.conn))
        return job_id, self.job(job_id)

    def test_rows_that_are_the_same_after_tidying_are_merged_without_asking(self) -> None:
        job_id, job = self._clean(
            b"Name,Phone,Address,City,Zip\n"
            b"GENE ORTEGA,(310) 555-0101,21820 GRACE AVE,Carson,90745\n"
            b"Gene Ortega,310.555.0101,21820  Grace Ave,Carson,90745\n"
            b"SOL SHOUMER,(310) 555-0102,10912 CRENSHAW BLVD,Inglewood,90303\n")
        self.assertEqual((job["status"], job["report"]["near_groups"], job["report"]["identical_merged"]), ("ready", 0, 1))
        with self.conn.cursor() as cur:
            cur.execute("SELECT state FROM importing.rows WHERE job_id = %s ORDER BY row_no", (job_id,))
            self.assertEqual([row[0] for row in cur.fetchall()], ["clean", "skip", "clean"])
        self.conn.commit()

    def test_a_row_that_matches_a_lead_on_everything_is_merged_into_it_without_asking(self) -> None:
        with self.conn.cursor() as cur:
            cur.execute("INSERT INTO crm.properties (org_id, address, city, postal_code) VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '21820 Grace Ave', 'Carson', '90745') RETURNING id")
            property_id = cur.fetchone()[0]
            cur.execute("INSERT INTO crm.leads (org_id, name, phone, property_id) VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Gene Ortega', '3105550101', %s)", (property_id,))
        self.conn.commit()
        job_id, job = self._clean(b"Name,Phone,Address,City,Zip\nGene Ortega,(310) 555-0101,21820 Grace Ave,Carson,90745\n")
        self.assertEqual((job["status"], job["report"]["near_groups"], job["report"]["certain_matches_merged"]), ("ready", 0, 1))
        with self.conn.cursor() as cur:
            cur.execute("SELECT state, match_lead IS NOT NULL FROM importing.rows WHERE job_id = %s", (job_id,))
            self.assertEqual(cur.fetchall(), [("merge", True)])
        self.conn.commit()

    def test_a_row_that_matches_a_lead_on_only_some_keys_is_asked_about(self) -> None:
        with self.conn.cursor() as cur:
            cur.execute("INSERT INTO crm.leads (org_id, name, phone) VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Gene Ortega', '3105550101')")
        self.conn.commit()
        job_id, job = self._clean(b"Name,Phone,Address,City,Zip\nGene Ortega,(310) 555-0101,21820 Grace Ave,Carson,90745\n")
        self.assertEqual((job["report"]["near_groups"], job["report"]["certain_matches_merged"]), (1, 0))

    def test_a_list_with_no_phone_numbers_or_emails_is_refused_and_nothing_is_kept(self) -> None:
        job_id, job = self._clean(b"Name,Address,City,Zip\nGene Ortega,21820 Grace Ave,Carson,90745\nSol Shoumer,10912 Crenshaw Blvd,Inglewood,90303\n")
        self.assertEqual(job["status"], "failed")
        self.assertIn("phone number or an email", job["error"])
        with self.conn.cursor() as cur:
            cur.execute("SELECT count(*) FROM importing.rows WHERE job_id = %s", (job_id,))
            self.assertEqual(cur.fetchone()[0], 0)
        self.conn.commit()

    def test_a_list_of_addresses_is_let_in_when_it_is_for_skip_tracing(self) -> None:
        job_id, job = self._clean(b"Name,Address,City,Zip\nGene Ortega,21820 Grace Ave,Carson,90745\nSol Shoumer,10912 Crenshaw Blvd,Inglewood,90303\n", skip_tracing=True)
        self.assertEqual(job["status"], "ready")
        with self.conn.cursor() as cur:
            cur.execute("SELECT count(*) FROM importing.rows WHERE job_id = %s AND state = 'clean'", (job_id,))
            self.assertEqual(cur.fetchone()[0], 2)
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

    def test_a_file_that_keeps_stopping_the_worker_is_failed_after_a_few_tries(self) -> None:
        job_id = self.queue(CSV.encode())
        for _ in range(self.worker.MAX_RECLAIMS + 1):
            claimed = self.worker.claim(self.conn)
            self.assertIsNotNone(claimed)
            # the worker "stops": its heartbeat goes stale and nothing finishes the job
            with self.conn.cursor() as cur:
                cur.execute("UPDATE importing.jobs SET heartbeat_at = now() - interval '10 minutes' WHERE id = %s", (job_id,))
            self.conn.commit()
        self.assertIsNone(self.worker.claim(self.conn))
        failed = self.job(job_id)
        self.assertEqual(failed["status"], "failed")
        self.assertIn("stopped several times", failed["error"])

    def test_a_waiting_import_can_see_the_one_in_front_of_it(self) -> None:
        import upload_api

        front = self.queue(CSV.encode())
        waiting = self.queue(CSV.encode())
        self.worker.claim(self.conn)  # the first becomes the one being worked on
        with self.conn.cursor() as cur:
            cur.execute("UPDATE importing.jobs SET progress = '{\"phase\":\"matching\",\"done\":10000,\"total\":10000,\"step\":\"repeats\"}'::jsonb WHERE id = %s", (front,))
        self.conn.commit()
        import psycopg
        from psycopg.rows import dict_row

        me = {"organization_id": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"}
        reader = psycopg.connect(os.environ["CRM_TEST_ADMIN_URL"], row_factory=dict_row)  # the upload API reads with dict rows
        self.addCleanup(reader.close)
        info = upload_api.queue_info(reader, me, {"id": waiting})
        self.assertEqual(info["ahead"], 1)
        self.assertEqual(info["running"]["id"], front)
        self.assertEqual(info["running"]["phase"], "matching")
        self.assertEqual(info["running"]["done"], 10000)
        other = upload_api.queue_info(reader, {"organization_id": "99999999-9999-4999-8999-999999999999"}, {"id": waiting})
        self.assertEqual(other["running"], {"other_workspace": True, "idle_seconds": other["running"]["idle_seconds"]})


if __name__ == "__main__":
    unittest.main()
