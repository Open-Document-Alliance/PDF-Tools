#!/usr/bin/env python3
"""Thin scorer bridge: semantics are delegated to the pinned upstream classes."""
import importlib
import json
import pathlib
import sys


def main():
    root, request_path, response_path = map(pathlib.Path, sys.argv[1:4])
    sys.path.insert(0, str(root))
    request = json.loads(request_path.read_text())
    response = {"schema": "pdf-tools.olmocr-upstream-response.v1", "status": "unavailable", "results": []}
    try:
        tests = importlib.import_module("olmocr.bench.tests")
        if not pathlib.Path(tests.__file__).resolve().is_relative_to(root.resolve()):
            raise RuntimeError("Upstream scorer imported outside the pinned checkout")
        # Math can otherwise silently fail while all string-only tests work.
        rendered = tests.render_equation(r"x^2+1")
        if rendered is None or getattr(rendered, "error", None):
            raise RuntimeError("Upstream KaTeX/Chromium preflight failed")
        response["status"] = "completed"
        for item in request["tests"]:
            row = {"id": item["id"], "category": item["category"], "status": "not_run"}
            if item["markdown"] is not None:
                try:
                    test = tests.load_single_test(item["test"])
                    passed, explanation = test.run(item["markdown"])
                    if type(passed) is not bool:
                        raise ValueError("Upstream test returned a nonboolean verdict")
                    row.update(status="passed" if passed else "failed", explanation=str(explanation)[:2000])
                except Exception as error:
                    row.update(status="scorer_error", explanation=f"{type(error).__name__}: {error}"[:2000])
            response["results"].append(row)
    except Exception as error:
        response["reason"] = f"{type(error).__name__}: {error}"[:2000]
    with response_path.open("x") as output:
        json.dump(response, output, indent=2)
        output.write("\n")


if __name__ == "__main__":
    main()
