"""Dependency-free checks for the experimental local OCR proposal contract."""

import importlib.util
from pathlib import Path
import tempfile
import unittest


SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "local-ocr-proposal.py"
SPEC = importlib.util.spec_from_file_location("local_ocr_proposal", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)
PNG = b"\x89PNG\r\n\x1a\n" + b"synthetic-render"
PDF = b"%PDF-1.7\nsynthetic-pdf"
ENGINE = {"name": "synthetic-test"}


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


if __name__ == "__main__":
    unittest.main()
