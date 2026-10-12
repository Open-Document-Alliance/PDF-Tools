import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  PDF_MUTATION_MAX_FILE_BYTES,
  hashBoundedPdfFileSafely,
  pdfMutationFileLimitError,
} from "./bounded-pdf-file.js";
import { writeOutputAtomic } from "./helpers.js";

function sameFile(left, right) {
  return left.device === right.device && left.inode === right.inode;
}

/**
 * CSV exports only create new files. Bind every input to the bytes actually
 * extracted, and use the existing durable no-clobber transaction so aliases,
 * late-arriving outputs, and failed writes cannot truncate a source PDF.
 * The optional filesystem/transition seams support deterministic race tests.
 */
export async function writeCsvExport({ outputPath, bytes, sources, assertPathAllowed }, {
  fsOps = fs,
  onTransition,
} = {}) {
  const verifySources = async () => {
    for (const source of sources) {
      const current = await hashBoundedPdfFileSafely(source.path, PDF_MUTATION_MAX_FILE_BYTES, {
        fileSystem: fsOps,
        assertPathAllowed,
        createSizeLimitError: pdfMutationFileLimitError,
      });
      if (
        current.canonicalPath !== source.canonicalPath
        || current.sizeBytes !== source.sizeBytes
        || current.sha256 !== source.sha256
        || !sameFile(current.fileIdentity, source.fileIdentity)
      ) {
        const error = new Error("A source PDF changed during CSV export. Retry the request.");
        error.code = "CSV_SOURCE_CHANGED";
        throw error;
      }
    }
  };
  const rejectSourceAlias = async () => {
    const canonicalParent = await fsOps.realpath(path.dirname(outputPath));
    assertPathAllowed(canonicalParent);
    const canonicalOutput = path.join(canonicalParent, path.basename(outputPath));
    assertPathAllowed(canonicalOutput);
    let stats = null;
    try {
      stats = await fsOps.lstat(canonicalOutput, { bigint: true });
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    if (sources.some(source => canonicalOutput === source.canonicalPath || (
      stats && sameFile({ device: String(stats.dev), inode: String(stats.ino) }, source.fileIdentity)
    ))) {
      const error = new Error("output_csv refers to a source PDF. Choose a new CSV path.");
      error.code = "CSV_OUTPUT_SOURCE_ALIAS";
      throw error;
    }
  };

  await verifySources();
  await rejectSourceAlias();
  return await writeOutputAtomic(outputPath, bytes, {
    fsOps,
    onTransition,
    assertPathAllowed,
    overwrite: false,
    beforeTransaction: async () => {
      await verifySources();
      await rejectSourceAlias();
    },
    verifyActivatedTargets: async ([target]) => {
      const saved = await hashBoundedPdfFileSafely(target.targetPath, bytes.length, {
        fileSystem: fsOps,
        assertPathAllowed,
        requirePdfHeader: false,
      });
      if (saved.sizeBytes !== bytes.length || saved.sha256 !== createHash("sha256").update(bytes).digest("hex")) {
        throw new Error("The saved CSV did not reopen as the exact export bytes.");
      }
      // A changed source rolls the newly activated CSV back before commit.
      await verifySources();
    },
  });
}
