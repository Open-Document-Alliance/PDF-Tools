"""Dependency-free checks for the experimental local OCR proposal contract."""

import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch


SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "local-ocr-proposal.py"
SPEC = importlib.util.spec_from_file_location("local_ocr_proposal", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)
PNG = b"\x89PNG\r\n\x1a\n" + b"synthetic-render"
PDF = b"%PDF-1.7\nsynthetic-pdf"
ENGINE = {"name": "ocrmac-vision", "ocrmac_version": "synthetic",
          "pypdfium2_version": "synthetic", "pillow_version": "synthetic"}


class LocalOcrProposalTests(unittest.TestCase):
    def proposal(self, observations=None):
        return MODULE.proposal_from_observations(
            PDF, 1, 2, PNG, 100, 200,
            observations if observations is not None else [("VISIBLE", 0.8, [0.1, 0.2, 0.3, 0.1])],
            ENGINE,
        )

    def test_proposal_binds_source_render_page_and_unverified_status(self):
        proposal = self.proposal()
        self.assertEqual(proposal["status"], "unverified_ocr_proposal")
        self.assertEqual(proposal["source_pdf_sha256"], MODULE.digest(PDF))
        self.assertEqual(proposal["render_png_sha256"], MODULE.digest(PNG))
        self.assertEqual(proposal["proposals"][0]["box_top_left_pixels"], [10.0, 140.0, 30.0, 20.0])
        claimed = proposal.pop("proposal_sha256")
        self.assertEqual(claimed, MODULE.digest(MODULE.canonical(proposal)))

    def test_empty_ocr_is_an_explicit_empty_proposal(self):
        self.assertEqual(self.proposal([])["proposals"], [])

    def test_wrong_source_page_render_and_bad_boxes_reject(self):
        for source, page, png, box in [
            (b"not a PDF", 1, PNG, [0.1, 0.2, 0.3, 0.1]),
            (PDF, 3, PNG, [0.1, 0.2, 0.3, 0.1]),
            (PDF, 1, b"not png", [0.1, 0.2, 0.3, 0.1]),
            (PDF, 1, PNG, [0.9, 0.2, 0.3, 0.1]),
            (PDF, 1, PNG, [0.1, float("nan"), 0.3, 0.1]),
            (PDF, 1, PNG, [True, 0.2, 0.3, 0.1]),
        ]:
            with self.subTest(source=source[:8], page=page, box=box):
                with self.assertRaises(ValueError):
                    MODULE.proposal_from_observations(source, page, 2, png, 100, 200,
                                                      [("VISIBLE", 0.8, box)], ENGINE)

    def test_ocr_confidence_does_not_become_a_correctness_claim(self):
        result = self.proposal()
        self.assertIn("engine_confidence_unverified", result["proposals"][0])
        self.assertTrue(any("not a correctness probability" in item for item in result["limitations"]))

    def test_source_read_rejects_symlink_and_keeps_exact_bytes(self):
        with tempfile.TemporaryDirectory() as folder:
            source = Path(folder) / "source.pdf"
            source.write_bytes(PDF)
            self.assertEqual(MODULE.read_source(source), PDF)
            alias = Path(folder) / "alias.pdf"
            alias.symlink_to(source)
            with self.assertRaises(OSError):
                MODULE.read_source(alias)

    def replay(self, source, page):
        self.assertEqual(source, PDF)
        self.assertEqual(page, 1)
        return PNG, 100, 200, 2, {key: ENGINE[key] for key in ("pypdfium2_version", "pillow_version")}

    def test_committed_proposal_replays_source_page_and_render(self):
        with tempfile.TemporaryDirectory() as root:
            folder = Path(root) / "output"
            proposal = self.proposal()
            MODULE.retain_proposal(folder, PNG, proposal)
            result = MODULE.verify_retained(folder, PDF, proposal["proposal_sha256"], self.replay)
            self.assertEqual(result["status"], "source_render_replayed_ocr_unverified")
            self.assertEqual(result["observation_count"], 1)
            self.assertEqual(os.stat(folder).st_mode & 0o777, 0o700)

    def test_interrupted_save_rejects_and_existing_output_is_preserved(self):
        with tempfile.TemporaryDirectory() as root:
            folder = Path(root) / "output"
            proposal = self.proposal()
            original = MODULE.write_exclusive
            def fail_proposal(path, data):
                if path.name == "proposal.json":
                    raise OSError("injected write failure")
                original(path, data)
            with patch.object(MODULE, "write_exclusive", side_effect=fail_proposal):
                with self.assertRaises(OSError):
                    MODULE.retain_proposal(folder, PNG, proposal)
            self.assertEqual(set(os.listdir(folder)), {"render.png"})
            with self.assertRaisesRegex(ValueError, "incomplete"):
                MODULE.verify_retained(folder, PDF, proposal["proposal_sha256"], self.replay)
            with self.assertRaises(FileExistsError):
                MODULE.retain_proposal(folder, PNG, proposal)
            self.assertEqual((folder / "render.png").read_bytes(), PNG)

    def test_symlink_parent_saves_and_syncs_the_physical_parent(self):
        with tempfile.TemporaryDirectory() as root:
            physical = Path(root) / "physical"
            physical.mkdir(mode=0o700)
            alias = Path(root) / "shortcut"
            alias.symlink_to(physical, target_is_directory=True)
            folder = alias / "output"
            proposal = self.proposal()
            MODULE.retain_proposal(folder, PNG, proposal)
            result = MODULE.verify_retained(folder, PDF, proposal["proposal_sha256"], self.replay)
            self.assertEqual(result["observation_count"], 1)
            with self.assertRaises(FileExistsError):
                MODULE.retain_proposal(folder, PNG, proposal)

    def test_independently_rounded_page_edge_boxes_replay(self):
        x = 0.8369076797385621
        w = 0.16309232026143794
        proposal = MODULE.proposal_from_observations(
            PDF, 1, 2, PNG, 1224, 1224, [("EDGE", 0.8, [x, 0, w, w])], ENGINE)
        box = proposal["proposals"][0]["box_top_left_pixels"]
        self.assertEqual(box[:1] + box[2:3], [1024.38, 199.63])
        self.assertGreater(box[0] + box[2], 1224.01)
        render = lambda *_: (PNG, 1224, 1224, 2,
                            {key: ENGINE[key] for key in ("pypdfium2_version", "pillow_version")})
        with tempfile.TemporaryDirectory() as root:
            folder = Path(root) / "valid"
            MODULE.retain_proposal(folder, PNG, proposal)
            MODULE.verify_retained(folder, PDF, proposal["proposal_sha256"], render)
            for axis in (0, 1):
                bad = json.loads(MODULE.canonical(proposal))
                bad["proposals"][0]["box_top_left_pixels"][axis] += 0.000001
                del bad["proposal_sha256"]
                bad["proposal_sha256"] = MODULE.digest(MODULE.canonical(bad))
                changed = Path(root) / f"overflow-{axis}"
                MODULE.retain_proposal(changed, PNG, bad)
                with self.assertRaisesRegex(ValueError, "outside"):
                    MODULE.verify_retained(changed, PDF, bad["proposal_sha256"], render)

    def test_replay_rejects_changed_source_render_pin_or_engine(self):
        with tempfile.TemporaryDirectory() as root:
            folder = Path(root) / "output"
            proposal = self.proposal()
            MODULE.retain_proposal(folder, PNG, proposal)
            for source, pin, render in [
                (PDF + b"changed", proposal["proposal_sha256"], self.replay),
                (PDF, "f" * 64, self.replay),
                (PDF, proposal["proposal_sha256"], lambda *_: (PNG + b"changed", 100, 200, 2, {})),
                (PDF, proposal["proposal_sha256"], lambda *_: (PNG, 100, 200, 2, {"pypdfium2_version": "drift"})),
            ]:
                with self.subTest(source=source, pin=pin):
                    with self.assertRaises(ValueError):
                        MODULE.verify_retained(folder, source, pin, render)

    def test_physical_retention_rejects_mode_symlink_extra_and_byte_drift(self):
        for hostile in ("mode", "symlink", "extra", "bytes", "missing_commit"):
            with self.subTest(hostile=hostile), tempfile.TemporaryDirectory() as root:
                folder = Path(root) / "output"
                proposal = self.proposal()
                MODULE.retain_proposal(folder, PNG, proposal)
                if hostile == "mode":
                    os.chmod(folder / "render.png", 0o644)
                elif hostile == "symlink":
                    (folder / "render.png").unlink()
                    (Path(root) / "outside.png").write_bytes(PNG)
                    (folder / "render.png").symlink_to(Path(root) / "outside.png")
                elif hostile == "extra":
                    (folder / "unexpected").touch()
                elif hostile == "bytes":
                    (folder / "render.png").write_bytes(PNG + b"changed")
                else:
                    (folder / "commit.json").unlink()
                with self.assertRaises((ValueError, OSError)):
                    MODULE.verify_retained(folder, PDF, proposal["proposal_sha256"], self.replay)

    def test_fully_rehashed_invalid_observations_reject(self):
        for field, value in [("observation_index", 2), ("box_top_left_pixels", [99, 0, 20, 10]),
                             ("engine_confidence_unverified", True), ("text_proposal", "")]:
            with self.subTest(field=field), tempfile.TemporaryDirectory() as root:
                proposal = self.proposal()
                proposal["proposals"][0][field] = value
                del proposal["proposal_sha256"]
                proposal["proposal_sha256"] = MODULE.digest(MODULE.canonical(proposal))
                folder = Path(root) / "output"
                MODULE.retain_proposal(folder, PNG, proposal)
                with self.assertRaises(ValueError):
                    MODULE.verify_retained(folder, PDF, proposal["proposal_sha256"], self.replay)

    def test_duplicate_json_members_and_noncanonical_bytes_reject(self):
        for data in (b'{"a":1,"a":2}\n', b'{"a":{"b":1,"b":2}}\n', b'{"a":NaN}\n', b'{ "a":1}\n'):
            with self.subTest(data=data), self.assertRaises(ValueError):
                MODULE.strict_json(data)

    def test_missing_adapter_and_wrong_pin_fail_without_output(self):
        with tempfile.TemporaryDirectory() as root:
            source = Path(root) / "source.pdf"
            source.write_bytes(PDF)
            output = Path(root) / "output"
            args = [str(SCRIPT), "--pdf", str(source), "--page", "1", "--output-dir", str(output),
                    "--expect-source-sha256"]
            wrong = subprocess.run([sys.executable, "-S", *args, "f" * 64], capture_output=True, text=True)
            self.assertEqual(wrong.returncode, 2)
            self.assertIn("caller's pin", json.loads(wrong.stderr)["message"])
            missing = subprocess.run([sys.executable, "-S", *args, MODULE.digest(PDF)], capture_output=True, text=True)
            self.assertEqual(missing.returncode, 2)
            self.assertIn("Optional OCR adapter", json.loads(missing.stderr)["message"])
            self.assertFalse(output.exists())

    @unittest.skipUnless(hasattr(os, "mkfifo"), "POSIX FIFO check")
    def test_source_fifo_rejects_without_waiting_for_a_writer(self):
        with tempfile.TemporaryDirectory() as root:
            source = Path(root) / "source.pdf"
            os.mkfifo(source, 0o600)
            result = subprocess.run([sys.executable, "-S", str(SCRIPT), "--pdf", str(source),
                                     "--page", "1", "--output-dir", str(Path(root) / "output"),
                                     "--expect-source-sha256", "f" * 64],
                                    capture_output=True, text=True, timeout=2)
            self.assertEqual(result.returncode, 2)
            self.assertIn("regular file", json.loads(result.stderr)["message"])

    def test_offline_review_uses_validated_snapshot_and_escapes_ocr_text(self):
        with tempfile.TemporaryDirectory() as root:
            folder = Path(root) / "output"
            text = '<script>fetch("https://evil.test")</script><img onerror="alert(1)">'
            proposal = self.proposal([(text, 0.8, [0.1, 0.2, 0.3, 0.1])])
            MODULE.retain_proposal(folder, PNG, proposal)
            review = Path(root) / "review.html"
            result = MODULE.verify_retained(folder, PDF, proposal["proposal_sha256"], self.replay,
                                            review_html=review)
            document = review.read_bytes()
            self.assertEqual(result["review_html_sha256"], MODULE.digest(document))
            self.assertIn(b'&lt;script&gt;', document)
            self.assertNotIn(b'<script>', document)
            self.assertNotIn(b'<img onerror=', document)
            self.assertIn(b"default-src 'none'", document)
            self.assertIn(b"Image replay does not verify OCR words", document)
            self.assertIn(b'href="#box-0"', document)
            self.assertEqual(review.stat().st_mode & 0o777, 0o600)
            self.assertEqual(set(os.listdir(folder)), {"render.png", "proposal.json", "commit.json"})

    def test_review_writes_nothing_on_failed_replay_and_never_overwrites(self):
        with tempfile.TemporaryDirectory() as root:
            folder = Path(root) / "output"
            proposal = self.proposal()
            MODULE.retain_proposal(folder, PNG, proposal)
            review = Path(root) / "review.html"
            with self.assertRaises(ValueError):
                MODULE.verify_retained(folder, PDF, "f" * 64, self.replay, review_html=review)
            self.assertFalse(review.exists())
            review.write_bytes(b"outside sentinel")
            with self.assertRaises(FileExistsError):
                MODULE.verify_retained(folder, PDF, proposal["proposal_sha256"], self.replay, review_html=review)
            self.assertEqual(review.read_bytes(), b"outside sentinel")
            with self.assertRaisesRegex(ValueError, "outside"):
                MODULE.verify_retained(folder, PDF, proposal["proposal_sha256"], self.replay,
                                        review_html=folder / "review.html")
            self.assertFalse((folder / "review.html").exists())

    def test_review_does_not_reread_changed_proposal_after_validation(self):
        with tempfile.TemporaryDirectory() as root:
            folder = Path(root) / "output"
            proposal = self.proposal()
            MODULE.retain_proposal(folder, PNG, proposal)
            def render_and_change_disk(source, page):
                (folder / "proposal.json").write_bytes(b'changed after snapshot read')
                return self.replay(source, page)
            review = Path(root) / "review.html"
            result = MODULE.verify_retained(folder, PDF, proposal["proposal_sha256"],
                                            render_and_change_disk, review_html=review)
            self.assertEqual(result["proposal_sha256"], proposal["proposal_sha256"])
            self.assertIn("VISIBLE", review.read_text())
            self.assertNotIn("changed after snapshot read", review.read_text())

    def test_empty_review_is_explicit_and_generation_cannot_skip_replay(self):
        with tempfile.TemporaryDirectory() as root:
            folder = Path(root) / "output"
            proposal = self.proposal([])
            MODULE.retain_proposal(folder, PNG, proposal)
            review = Path(root) / "review.html"
            MODULE.verify_retained(folder, PDF, proposal["proposal_sha256"], self.replay, review_html=review)
            self.assertIn("No text was proposed", review.read_text())
            result = subprocess.run([sys.executable, str(SCRIPT), "--pdf", "not-read.pdf", "--page", "1",
                                     "--output-dir", str(Path(root) / "new"), "--expect-source-sha256", "f" * 64,
                                     "--review-html", str(Path(root) / "not-created.html")],
                                    capture_output=True, text=True)
            self.assertEqual(result.returncode, 2)
            self.assertIn("requires --verify-proposal-dir", result.stderr)
            self.assertFalse((Path(root) / "not-created.html").exists())


if __name__ == "__main__":
    unittest.main()
